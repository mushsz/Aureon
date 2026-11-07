// OUTREACH — envia as mensagens preparadas pelo Gmail do próprio usuário (OAuth), uma por vez,
// dentro da janela, dos limites e só depois da aprovação explícita do modo real.
// Em modo simulação, nada sai: a mensagem fica registrada como "simulated".

import { nowIso, inWindow, localDate, zonedToUtc, zonedParts } from '../util.js';
import { getSettings, stageStmts } from '../db.js';
import { loadRules, checkExclusion, subjectFromCompany, isSuppressed } from '../exclusion.js';
import { buildMime, gmailSend } from '../google.js';
import { composeFollowup, unsubscribeUrl } from './copywriter.js';

/** Início do dia local (no fuso) em UTC ISO, para contar envios "de hoje". */
export function localDayStartIso(now, tz) {
  const p = zonedParts(now, tz);
  return zonedToUtc(p.year, p.month, p.day, 0, 0, tz).toISOString();
}

/** Todas as travas que valem para qualquer envio. Retorna null se pode enviar, ou o motivo. */
export async function sendGate(ctx, settings, { segment } = {}) {
  const o = settings.outreach;
  if (settings.system.emergency_stop) return 'pausa emergencial ativa';
  if (settings.system.paused) return 'sistema pausado';
  if (!settings.agents.outreach) return 'agente Outreach desativado';
  if (!inWindow(ctx.now, settings.timezone, o.days, o.start, o.end)) return 'fora da janela de envio configurada';
  const dayStart = localDayStartIso(ctx.now, settings.timezone);
  const counts = await ctx.first(
    `SELECT COUNT(*) AS total, MAX(sent_at) AS last_sent FROM messages
     WHERE direction = 'out' AND status IN ('sent','simulated','sending') AND kind IN ('initial','followup') AND COALESCE(sent_at, created_at) >= ?`, dayStart,
  );
  if (counts.total >= o.daily_limit) return `limite diário atingido (${counts.total}/${o.daily_limit})`;
  if (counts.last_sent && (ctx.now - new Date(counts.last_sent)) / 60_000 < o.min_minutes_between) return `intervalo mínimo entre envios (${o.min_minutes_between} min)`;
  if (segment) {
    const seg = await ctx.first(
      `SELECT COUNT(*) AS n FROM messages m JOIN leads l ON l.id = m.lead_id JOIN companies c ON c.id = l.company_id
       WHERE m.direction = 'out' AND m.status IN ('sent','simulated','sending') AND m.kind IN ('initial','followup') AND COALESCE(m.sent_at, m.created_at) >= ? AND c.segment = ?`, dayStart, segment,
    );
    if (seg.n >= o.per_segment_daily_limit) return `limite diário do segmento ${segment} atingido`;
  }
  return null;
}

export const isLive = (settings) => settings.outreach.mode === 'live' && !!settings.outreach.live_approved_at;

/** Checagens do destinatário, refeitas imediatamente antes de cada envio. */
async function recipientGate(ctx, row, rules) {
  if (!['allow', 'approved'].includes(row.exclusion_status)) return `empresa em ${row.exclusion_status} na lista de exclusão`;
  const ex = checkExclusion(rules, subjectFromCompany(row));
  if (ex.verdict === 'block') return 'bloqueada pela lista de exclusão';
  if (ex.verdict === 'review' && row.exclusion_status !== 'approved') return 'em dúvida na lista de exclusão';
  if (row.contact_status !== 'valid') return 'contato sem base legal válida';
  const sup = await isSuppressed(ctx, row.to_addr);
  if (sup) return `destinatário na lista de supressão (${sup})`;
  if (['nao_contatar', 'perdido', 'convertido'].includes(row.stage)) return `lead em ${row.stage}`;
  return null;
}

async function deliver(ctx, settings, row, { subject, body, kind, threadId, inReplyTo }) {
  const live = isLive(settings);
  const ts = nowIso();
  if (!live) return { status: 'simulated', gmailId: null, threadId: null, ts };
  const unsub = await unsubscribeUrl(ctx.env, row.contact_id, row.to_addr);
  const mime = buildMime({
    from: settings.sender.email, fromName: settings.sender.name, to: row.to_addr, subject, text: body,
    inReplyTo, references: inReplyTo, listUnsubscribe: unsub,
  });
  const sent = await gmailSend(ctx, mime, threadId);
  ctx.metric('emails_sent');
  return { status: 'sent', gmailId: sent.id, threadId: sent.threadId, ts };
}

/** Envia (ou simula) até `batch` mensagens iniciais. Uma por execução por padrão. */
export async function runOutreach(ctx, batch = 1) {
  const settings = await getSettings(ctx);
  const rules = await loadRules(ctx);
  let done = 0;
  const reasons = [];
  for (let i = 0; i < batch; i++) {
    const row = await ctx.first(
      `SELECT m.id AS message_id, m.subject, m.body_text, m.to_addr, m.conversation_id, l.id AS lead_id, l.stage, l.contact_id,
              ct.status AS contact_status, c.*
       FROM messages m JOIN leads l ON l.id = m.lead_id JOIN companies c ON c.id = l.company_id JOIN contacts ct ON ct.id = l.contact_id
       WHERE m.kind = 'initial' AND m.status = 'draft' AND l.stage = 'aguardando_contato'
       ORDER BY l.score DESC, m.id LIMIT 1`,
    );
    if (!row) break;
    const gate = await sendGate(ctx, settings, { segment: row.segment });
    if (gate) { reasons.push(gate); break; }
    const blocked = await recipientGate(ctx, row, rules);
    if (blocked) {
      await ctx.batch([
        ctx.stmt("UPDATE messages SET status = 'cancelled', error = ?, updated_at = ? WHERE id = ?", blocked, nowIso(), row.message_id),
        ...stageStmts(ctx, { id: row.lead_id, stage: row.stage }, blocked.includes('supressão') ? 'nao_contatar' : 'qualificado', `Envio cancelado: ${blocked}`, 'outreach', { needs_review: 1 }),
      ]);
      ctx.log('warn', 'outreach', `Envio cancelado para ${row.name}: ${blocked}`);
      continue;
    }
    // trava contra envio duplo: só quem muda draft→sending segue
    const lock = await ctx.run("UPDATE messages SET status = 'sending', updated_at = ? WHERE id = ? AND status = 'draft'", nowIso(), row.message_id);
    if (!lock.changes) continue;
    try {
      const r = await deliver(ctx, settings, row, { subject: row.subject, body: row.body_text, kind: 'initial' });
      await ctx.batch([
        ctx.stmt('UPDATE messages SET status = ?, gmail_message_id = ?, sent_at = ?, updated_at = ? WHERE id = ?', r.status, r.gmailId, r.ts, r.ts, row.message_id),
        ctx.stmt('UPDATE conversations SET gmail_thread_id = COALESCE(?, gmail_thread_id), last_message_at = ?, updated_at = ? WHERE id = ?', r.threadId, r.ts, r.ts, row.conversation_id),
        ...stageStmts(ctx, { id: row.lead_id, stage: row.stage }, 'contatado', r.status === 'sent' ? 'E-mail enviado' : 'E-mail simulado (modo simulação)', 'outreach', { last_contact_at: r.ts }),
      ]);
      ctx.log('info', 'outreach', `${r.status === 'sent' ? 'Enviado' : 'Simulado'}: ${row.name} <${row.to_addr}>`, { message_id: row.message_id });
      done++;
    } catch (e) {
      await ctx.run("UPDATE messages SET status = 'draft', error = ?, updated_at = ? WHERE id = ?", String(e.message).slice(0, 500), nowIso(), row.message_id);
      throw e;
    }
  }
  return { sent: done, blocked_by: reasons[0] || null };
}

/** Follow-up: um por vez, só para quem não respondeu, no mesmo fio do Gmail. */
export async function runFollowup(ctx, batch = 1) {
  const settings = await getSettings(ctx);
  if (!settings.agents.followup) return { sent: 0, blocked_by: 'agente Follow-up desativado' };
  const o = settings.outreach;
  const cutoff = new Date(ctx.now.getTime() - o.followup_after_days * 86_400_000).toISOString();
  const rules = await loadRules(ctx);
  let done = 0;
  for (let i = 0; i < batch; i++) {
    const row = await ctx.first(
      `SELECT l.id AS lead_id, l.stage, l.contact_id, l.followup_count, ct.status AS contact_status, ct.normalized_value AS to_addr,
              cv.id AS conversation_id, cv.gmail_thread_id, cv.subject AS conv_subject,
              (SELECT MIN(sent_at) FROM messages WHERE lead_id = l.id AND kind = 'initial') AS first_sent_at,
              (SELECT status FROM messages WHERE lead_id = l.id AND kind = 'initial') AS initial_status, c.*
       FROM leads l JOIN companies c ON c.id = l.company_id JOIN contacts ct ON ct.id = l.contact_id
       JOIN conversations cv ON cv.lead_id = l.id
       WHERE l.stage = 'contatado' AND l.followup_count < ? AND l.last_contact_at <= ? AND l.last_inbound_at IS NULL
       ORDER BY l.last_contact_at LIMIT 1`, o.max_followups, cutoff,
    );
    if (!row) break;
    const gate = await sendGate(ctx, settings, { segment: row.segment });
    if (gate) return { sent: done, blocked_by: gate };
    const blocked = await recipientGate(ctx, row, rules);
    if (blocked) {
      await ctx.batch(stageStmts(ctx, { id: row.lead_id, stage: row.stage }, row.stage, `Follow-up cancelado: ${blocked}`, 'followup', { followup_count: o.max_followups }));
      continue;
    }
    // simulação só gera follow-up de quem também foi simulado; envio real só segue fio real
    const live = isLive(settings);
    if (live && (row.initial_status !== 'sent' || !row.gmail_thread_id)) {
      await ctx.run('UPDATE leads SET followup_count = ?, updated_at = ? WHERE id = ?', o.max_followups, nowIso(), row.lead_id);
      continue;
    }
    const n = row.followup_count + 1;
    const unsub = await unsubscribeUrl(ctx.env, row.contact_id, row.to_addr);
    const f = composeFollowup({ company: row, sender: settings.sender, unsubUrl: unsub, firstSentAt: row.first_sent_at, timezone: settings.timezone });
    const subject = row.conv_subject?.startsWith('Re:') ? row.conv_subject : `Re: ${row.conv_subject || row.name}`;
    const ins = await ctx.run(
      `INSERT OR IGNORE INTO messages (conversation_id, lead_id, direction, kind, status, template, subject, body_text, to_addr, from_addr, dedupe_key, created_at, updated_at)
       VALUES (?, ?, 'out', 'followup', 'sending', ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.conversation_id, row.lead_id, f.template, subject, f.body, row.to_addr, settings.sender.email, `followup:${row.lead_id}:${n}`, nowIso(), nowIso(),
    );
    if (!ins.changes) { await ctx.run('UPDATE leads SET followup_count = ? WHERE id = ?', n, row.lead_id); continue; }
    const msg = await ctx.first('SELECT id FROM messages WHERE dedupe_key = ?', `followup:${row.lead_id}:${n}`);
    try {
      const r = await deliver(ctx, settings, row, { subject, body: f.body, kind: 'followup', threadId: row.gmail_thread_id });
      await ctx.batch([
        ctx.stmt('UPDATE messages SET status = ?, gmail_message_id = ?, sent_at = ?, updated_at = ? WHERE id = ?', r.status, r.gmailId, r.ts, r.ts, msg.id),
        ctx.stmt('UPDATE conversations SET last_message_at = ?, updated_at = ? WHERE id = ?', r.ts, r.ts, row.conversation_id),
        ctx.stmt('UPDATE leads SET followup_count = ?, last_contact_at = ?, updated_at = ? WHERE id = ?', n, r.ts, r.ts, row.lead_id),
      ]);
      ctx.log('info', 'followup', `Follow-up ${r.status === 'sent' ? 'enviado' : 'simulado'}: ${row.name}`);
      done++;
    } catch (e) {
      // apaga o registro para a próxima execução poder tentar de novo (o job registra o erro)
      await ctx.run('DELETE FROM messages WHERE id = ?', msg.id);
      throw e;
    }
  }
  return { sent: done };
}

export { localDate };
