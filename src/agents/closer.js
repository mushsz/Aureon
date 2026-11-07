// CLOSER — primeira resposta a interessados, só nos casos autorizados em Configurações.
// Não inventa preço, não assume compromisso, faz poucas perguntas de qualificação e oferece a agenda.
// Qualquer outra situação fica para você (REVISÃO NECESSÁRIA).

import { nowIso, randomToken, sha256Hex } from '../util.js';
import { stageStmts } from '../db.js';
import { buildMime, gmailSend } from '../google.js';
import { isLive } from './outreach.js';
import { unsubscribeUrl } from './copywriter.js';
import { isSuppressed } from '../exclusion.js';
import { SERVICES } from '../defaults.js';

export async function createBookingOffer(ctx, lead, conversationId, timezone) {
  const token = randomToken(24);
  const ts = nowIso();
  await ctx.run(
    `INSERT INTO appointments (lead_id, conversation_id, token_hash, status, timezone, token_expires_at, created_at, updated_at)
     VALUES (?,?,?,'offered',?,?,?,?)`,
    lead.id, conversationId, await sha256Hex(token), timezone, new Date(Date.now() + 30 * 86_400_000).toISOString(), ts, ts,
  );
  return `${(ctx.env.APP_URL || '').replace(/\/$/, '')}/agendar/${token}`;
}

export function composeCloserReply({ cls, company, service, sender, bookingUrl, unsubUrl }) {
  const svc = SERVICES[service] || SERVICES.custom;
  const open = cls === 'info_request'
    ? `Obrigado pelo retorno! Resumindo: trabalho com ${svc.pitch}. Cada projeto parte de uma conversa curta para entender a necessidade; valores dependem do escopo, então não passo preço antes disso.`
    : 'Obrigado pelo retorno! Fico feliz que faça sentido.';
  return [
    'Olá!', '', open, '',
    `Para facilitar, deixei os horários livres da minha agenda neste link — é só escolher o melhor para vocês: ${bookingUrl}`, '',
    'Para eu chegar preparado, se puder me contar:',
    '1. Qual é hoje o principal desafio no atendimento ou nas vendas?',
    '2. Vocês já usam alguma ferramenta para isso (site, CRM, planilha, WhatsApp)?',
    '3. Existe um prazo ou momento ideal para resolver?', '',
    'Se preferir, responda com dois ou três horários que eu confirmo.', '',
    'Obrigado,', [sender.name, sender.company, sender.phone].filter(Boolean).join('\n'), '', '—',
    `Para não receber mais mensagens, responda "descadastrar" ou acesse: ${unsubUrl}`,
  ].join('\n');
}

/** Retorna { replied, reason }. */
export async function runCloser(ctx, settings, conv, inbound, cls) {
  const allowed = settings.agents.closer && !settings.system.paused && !settings.system.emergency_stop && (
    (cls.classification === 'meeting' && settings.closer.auto_reply_meeting) ||
    (cls.classification === 'positive' && settings.closer.auto_reply_positive) ||
    (cls.classification === 'info_request' && settings.closer.auto_reply_info));
  if (!cls.auto_ok || !allowed) {
    ctx.log('info', 'closer', `Interessado aguardando sua resposta (resposta automática não autorizada para "${cls.classification}")`, { conversation_id: conv.id });
    return { replied: false, reason: 'não autorizado' };
  }
  const row = await ctx.first(
    `SELECT l.*, c.name AS company_name, c.exclusion_status, ct.normalized_value AS to_addr, ct.id AS contact_id2
     FROM leads l JOIN companies c ON c.id = l.company_id LEFT JOIN contacts ct ON ct.id = l.contact_id WHERE l.id = ?`, conv.lead_id,
  );
  if (!row || !['allow', 'approved'].includes(row.exclusion_status)) return { replied: false, reason: 'empresa não liberada' };
  const to = inbound.from || row.to_addr;
  if (await isSuppressed(ctx, to)) return { replied: false, reason: 'destinatário suprimido' };
  const dedupe = `auto:${inbound.id}`;
  const exists = await ctx.first('SELECT id FROM messages WHERE dedupe_key = ?', dedupe);
  if (exists) return { replied: false, reason: 'já respondido' };

  const bookingUrl = await createBookingOffer(ctx, row, conv.id, settings.timezone);
  const unsub = await unsubscribeUrl(ctx.env, row.contact_id || 0, to);
  const body = composeCloserReply({ cls: cls.classification, company: { name: row.company_name }, service: row.service_fit, sender: settings.sender, bookingUrl, unsubUrl: unsub });
  const subject = /^re:/i.test(inbound.subject || '') ? inbound.subject : `Re: ${inbound.subject || conv.subject || row.company_name}`;
  const live = isLive(settings);
  let status = 'simulated', gmailId = null;
  if (live) {
    const mime = buildMime({ from: settings.sender.email, fromName: settings.sender.name, to, subject, text: body, inReplyTo: inbound.messageId, references: [inbound.references, inbound.messageId].filter(Boolean).join(' '), listUnsubscribe: unsub });
    const sent = await gmailSend(ctx, mime, inbound.threadId);
    status = 'sent'; gmailId = sent.id;
    ctx.metric('emails_sent');
  }
  const ts = nowIso();
  await ctx.batch([
    ctx.stmt(
      `INSERT OR IGNORE INTO messages (conversation_id, lead_id, direction, kind, status, template, subject, body_text, to_addr, from_addr, gmail_message_id, dedupe_key, sent_at, created_at, updated_at)
       VALUES (?, ?, 'out', 'auto_reply', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      conv.id, conv.lead_id, status, `closer:${cls.classification}`, subject, body, to, settings.sender.email, gmailId, dedupe, ts, ts, ts,
    ),
    ...stageStmts(ctx, row, 'interessado', 'Closer enviou link de agenda', 'closer'),
    ctx.stmt('UPDATE conversations SET last_message_at = ?, updated_at = ? WHERE id = ?', ts, ts, conv.id),
  ]);
  ctx.log('info', 'closer', `Resposta ${status === 'sent' ? 'enviada' : 'simulada'} com link de agenda para ${row.company_name}`);
  return { replied: true, status };
}
