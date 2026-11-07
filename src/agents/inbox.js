// INBOX — lê o Gmail, guarda só respostas a conversas iniciadas pelo sistema e classifica cada uma
// por regras determinísticas. Ambíguo → REVISÃO NECESSÁRIA, nunca resposta automática.

import { normalize, nowIso, truncate } from '../util.js';
import { getSettings, stageStmts } from '../db.js';
import { gmailList, gmailGet, parseGmailMessage } from '../google.js';
import { runCloser } from './closer.js';

export const CLASSES = {
  positive: 'Resposta positiva',
  info_request: 'Solicitação de informações',
  meeting: 'Interesse em reunião',
  question: 'Dúvida',
  objection: 'Objeção',
  refusal: 'Recusa',
  unsubscribe: 'Pedido de descadastramento',
  auto: 'Mensagem automática',
  bounce: 'Falha de entrega',
  inconclusive: 'Resposta inconclusiva',
};

const P = (list) => list.map((s) => ({ phrase: normalize(s), re: new RegExp(`(^| )${normalize(s).replace(/ /g, ' +')}( |$)`) }));
const RULES = {
  unsubscribe: P(['descadastrar', 'descadastre', 'descadastra', 'descadastro', 'me descadastrem', 'remover meu email', 'remover meu e mail', 'remova meu', 'removam meu', 'retire meu', 'tirar meu email',
    'nao enviar mais', 'nao envie mais', 'nao enviem mais', 'nao quero receber', 'parem de enviar', 'pare de enviar', 'parar de enviar', 'unsubscribe', 'sair da lista',
    'excluir meu contato', 'exclua meu contato', 'nao me mande', 'nao mandem mais', 'spam', 'nao entre mais em contato', 'nao autorizo']),
  refusal: P(['nao tenho interesse', 'nao temos interesse', 'sem interesse', 'nao ha interesse', 'nao estamos interessados', 'nao estou interessado', 'nao estou interessada',
    'nao precisamos', 'nao preciso', 'ja temos fornecedor', 'ja temos uma empresa', 'ja temos parceiro', 'ja possuimos', 'nao obrigado', 'nao obrigada', 'dispenso', 'dispensamos',
    'nao e do nosso interesse', 'nao faz sentido', 'nao se aplica']),
  meeting: P(['podemos conversar', 'vamos conversar', 'vamos marcar', 'marcar uma', 'marcar um', 'agendar', 'agendamos', 'reuniao', 'uma call', 'videochamada', 'chamada de video',
    'bate papo', 'qual horario', 'quais horarios', 'que horario', 'tenho disponibilidade', 'disponibilidade', 'pode me ligar', 'me liga', 'me ligue', 'ligar amanha',
    'conversar amanha', 'conversar semana', 'podemos falar', 'vamos falar', 'google meet', 'teams', 'zoom']),
  info_request: P(['mais informacoes', 'mais informacao', 'mais detalhes', 'me envie', 'me envia', 'me enviar', 'me mande', 'me mandar', 'enviar a analise', 'mandar a analise', 'compartilhar a analise', 'pode compartilhar', 'quero ver a analise', 'gostaria de ver', 'manda a analise', 'envie a analise', 'pode enviar', 'pode mandar',
    'apresentacao', 'portfolio', 'portifolio', 'cases', 'como funciona', 'gostaria de saber', 'quero saber', 'me explica', 'me explique']),
  price: P(['quanto custa', 'qual o valor', 'qual valor', 'valores', 'preco', 'precos', 'orcamento', 'investimento', 'custo', 'mensalidade', 'tabela']),
  positive: P(['tenho interesse', 'temos interesse', 'interessante', 'interessado', 'interessada', 'faz sentido', 'gostei', 'gostaria', 'pode ser', 'com certeza', 'claro',
    'vamos sim', 'quero sim', 'sim', 'ok', 'perfeito', 'otimo', 'bacana', 'legal']),
  objection: P(['muito caro', 'caro', 'sem orcamento', 'sem verba', 'agora nao', 'nao e o momento', 'momento nao', 'mais pra frente', 'mais para frente', 'talvez depois',
    'ano que vem', 'proximo ano', 'ja temos site', 'ja temos sistema', 'estamos satisfeitos', 'no momento nao', 'nao agora', 'depois conversamos', 'mais adiante']),
  auto_body: P(['resposta automatica', 'mensagem automatica', 'estou ausente', 'estarei ausente', 'fora do escritorio', 'em ferias', 'out of office', 'automatic reply', 'auto reply', 'retornarei']),
};
const WEAK_POSITIVE = new Set(['sim', 'ok', 'claro', 'legal', 'bacana', 'otimo', 'perfeito', 'gostaria']);

/** Remove a parte citada ("Em ... escreveu:", linhas com ">") para classificar só o texto novo. */
export function stripQuoted(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) break;
    if (/^\s*(em|on)\s.+(escreveu|wrote)\s*:?\s*$/i.test(line)) break;
    if (/^\s*-{2,}\s*(mensagem original|original message)/i.test(line)) break;
    if (/^\s*(de|from):\s.+@/i.test(line) && out.length) break;
    out.push(line);
  }
  return out.join('\n').trim();
}

/**
 * Classifica uma mensagem recebida.
 * Retorna { classification, needs_review, auto_ok, reason, matches }.
 */
export function classifyReply({ from = '', subject = '', text = '', headers = {} }) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).toLowerCase()]));
  const fromL = from.toLowerCase();
  const subjN = normalize(subject);
  if (/mailer-daemon|postmaster@/.test(fromL) || /delivery status notification|undeliverable|nao foi possivel entregar|mail delivery failed|returned mail|falha na entrega/.test(subjN)) {
    return { classification: 'bounce', needs_review: false, auto_ok: false, reason: 'remetente/assunto de falha de entrega', matches: [] };
  }
  if ((h['auto-submitted'] && h['auto-submitted'] !== 'no') || h['x-autoreply'] || h['x-autorespond'] || /auto_reply|auto-reply/.test(h['precedence'] || '') || /bulk|junk/.test(h['precedence'] || '')
      || /^(resposta automatica|automatic reply|auto reply|out of office|ausente|ferias)/.test(subjN)) {
    return { classification: 'auto', needs_review: false, auto_ok: false, reason: 'cabeçalho/assunto de resposta automática', matches: [] };
  }
  const fresh = stripQuoted(text);
  const t = normalize(fresh);
  const words = t ? t.split(' ').length : 0;
  const hit = {};
  // negativas primeiro; o trecho negativo é retirado antes de procurar interesse
  // (senão "não tenho interesse" também casaria com "tenho interesse")
  let rest = ` ${t} `;
  for (const k of ['unsubscribe', 'refusal', 'objection', 'auto_body']) {
    hit[k] = RULES[k].filter((r) => r.re.test(t)).map((r) => r.phrase);
    for (const r of RULES[k]) rest = rest.replace(new RegExp(r.re.source, 'g'), ' ');
  }
  rest = rest.replace(/(^| )(nao|nem|nunca|jamais)( [a-z]+){0,2}( |$)/g, ' ');
  for (const k of ['meeting', 'info_request', 'price', 'positive']) hit[k] = RULES[k].filter((r) => r.re.test(rest.trim())).map((r) => r.phrase);
  const has = (k) => hit[k].length > 0;
  const matches = Object.entries(hit).filter(([, v]) => v.length).map(([k]) => k);

  // descadastro vence tudo (o lado seguro)
  if (has('unsubscribe')) return { classification: 'unsubscribe', needs_review: false, auto_ok: false, reason: 'pedido explícito de descadastro', matches };
  if (has('auto_body') && words < 80 && !has('meeting') && !has('info_request')) return { classification: 'auto', needs_review: false, auto_ok: false, reason: 'texto de resposta automática', matches };
  const strongPositive = hit.positive.some((p) => !WEAK_POSITIVE.has(p));
  const positive = strongPositive || (has('positive') && words <= 12);
  const interest = positive || has('meeting') || has('info_request');

  if (has('refusal') && interest) return { classification: 'refusal', needs_review: true, auto_ok: false, reason: 'recusa e interesse na mesma mensagem — ambíguo', matches };
  if (has('refusal')) return { classification: 'refusal', needs_review: false, auto_ok: false, reason: 'recusa explícita', matches };
  if (has('objection') && interest) return { classification: 'objection', needs_review: true, auto_ok: false, reason: 'interesse com objeção — encaminhar para você', matches };
  if (has('objection')) return { classification: 'objection', needs_review: true, auto_ok: false, reason: 'objeção', matches };
  if (has('price')) return { classification: has('meeting') ? 'meeting' : 'question', needs_review: true, auto_ok: false, reason: 'pergunta sobre preço — sem preço automático, encaminhar para você', matches };
  if (words > 120) return { classification: has('meeting') ? 'meeting' : interest ? 'positive' : 'inconclusive', needs_review: true, auto_ok: false, reason: 'mensagem longa — leitura humana', matches };
  if (has('meeting')) return { classification: 'meeting', needs_review: false, auto_ok: true, reason: 'pedido de conversa/reunião', matches };
  if (has('info_request')) return { classification: 'info_request', needs_review: false, auto_ok: true, reason: 'pedido de informações', matches };
  if (positive) return { classification: 'positive', needs_review: false, auto_ok: true, reason: 'resposta positiva', matches };
  if (fresh.includes('?')) return { classification: 'question', needs_review: true, auto_ok: false, reason: 'dúvida aberta', matches };
  return { classification: 'inconclusive', needs_review: true, auto_ok: false, reason: 'não foi possível interpretar com segurança', matches };
}

const STAGE_BY_CLASS = {
  positive: 'interessado', meeting: 'interessado', info_request: 'interessado',
  question: 'respondeu', objection: 'respondeu', inconclusive: 'respondeu',
  refusal: 'perdido', unsubscribe: 'nao_contatar',
};

/** Registra uma mensagem recebida já parseada, aplicando supressão e mudança de etapa. */
export async function ingestInbound(ctx, msg, conv) {
  const cls = classifyReply(msg);
  const ts = nowIso();
  const lead = await ctx.first('SELECT * FROM leads WHERE id = ?', conv.lead_id);
  const contact = conv.contact_id ? await ctx.first('SELECT * FROM contacts WHERE id = ?', conv.contact_id) : null;
  // depois de uma resposta automática nossa, qualquer nova mensagem vai para você
  const alreadyAuto = await ctx.first("SELECT id FROM messages WHERE conversation_id = ? AND kind IN ('auto_reply','manual_reply') LIMIT 1", conv.id);
  if (alreadyAuto && cls.auto_ok) { cls.auto_ok = false; cls.needs_review = true; cls.reason += ' · conversa já teve resposta — encaminhada para você'; }

  const stmts = [ctx.stmt(
    `INSERT OR IGNORE INTO messages (conversation_id, lead_id, direction, kind, status, subject, body_text, to_addr, from_addr,
       gmail_message_id, rfc_message_id, classification, classification_reason, needs_review, received_at, created_at, updated_at)
     VALUES (?, ?, 'in', 'inbound', 'received', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    conv.id, conv.lead_id, truncate(msg.subject, 300), truncate(msg.text, 20_000), truncate(msg.to, 300), msg.from,
    msg.id, msg.messageId, cls.classification, cls.reason, cls.needs_review ? 1 : 0, msg.internalDate, ts, ts,
  )];
  const suppressEmail = contact?.normalized_value || msg.from;
  if (['unsubscribe', 'refusal', 'bounce'].includes(cls.classification) && !(cls.classification === 'refusal' && cls.needs_review)) {
    const reason = cls.classification;
    for (const e of new Set([suppressEmail, msg.from].filter(Boolean))) {
      stmts.push(ctx.stmt("INSERT OR IGNORE INTO suppression_list (type, value, reason, source, created_at) VALUES ('email', ?, ?, ?, ?)", e, reason, `gmail:${msg.id}`, ts));
    }
    if (contact) stmts.push(ctx.stmt("UPDATE contacts SET status = 'suppressed', updated_at = ? WHERE id = ?", ts, contact.id));
    // cancela qualquer rascunho pendente para esse lead
    stmts.push(ctx.stmt("UPDATE messages SET status = 'cancelled', error = ?, updated_at = ? WHERE lead_id = ? AND direction = 'out' AND status = 'draft'", `cancelado: ${reason}`, ts, conv.lead_id));
  }
  if (cls.classification !== 'auto') {
    const to = cls.classification === 'bounce' ? 'perdido' : STAGE_BY_CLASS[cls.classification];
    const keepStage = ['reuniao_agendada', 'convertido'].includes(lead.stage) && !['unsubscribe', 'refusal'].includes(cls.classification);
    const extra = { last_inbound_at: msg.internalDate };
    if (cls.needs_review) extra.needs_review = 1;
    if (cls.classification === 'refusal' || cls.classification === 'bounce') extra.lost_reason = CLASSES[cls.classification];
    stmts.push(...stageStmts(ctx, lead, keepStage ? lead.stage : (to || lead.stage), `Resposta: ${CLASSES[cls.classification]} (${cls.reason})`, 'inbox', extra));
    stmts.push(ctx.stmt('UPDATE conversations SET status = ?, last_message_at = ?, updated_at = ? WHERE id = ?', cls.needs_review ? 'needs_review' : 'open', msg.internalDate, ts, conv.id));
  }
  const res = await ctx.batch(stmts);
  const inserted = res[0]?.meta?.changes > 0;
  if (inserted) {
    ctx.metric('replies_received');
    ctx.log(cls.needs_review ? 'alert' : 'info', 'inbox', `${CLASSES[cls.classification]} de ${msg.from}${cls.needs_review ? ' — REVISÃO NECESSÁRIA' : ''}`, { conversation_id: conv.id, reason: cls.reason });
  }
  return { inserted, cls };
}

/** Verifica o Gmail: lista mensagens novas na caixa de entrada e guarda só as de conversas nossas. */
export async function runInbox(ctx, batch = 10) {
  const settings = await getSettings(ctx);
  const integ = await ctx.first("SELECT * FROM integrations WHERE provider = 'google' AND status = 'connected'");
  if (!integ) return { checked: 0, note: 'Google não conectado' };
  const since = Math.max(0, (+integ.inbox_cursor || Math.floor(Date.now() / 1000) - 86_400) - 300);
  const list = await gmailList(ctx, `in:inbox after:${since} -from:me`, batch);
  const ids = (list?.messages || []).map((m) => m.id);
  if (!ids.length) {
    await ctx.run("UPDATE integrations SET inbox_cursor = ?, updated_at = ? WHERE provider = 'google'", String(Math.floor(ctx.now.getTime() / 1000) - 60), nowIso());
    return { checked: 0 };
  }
  const known = await ctx.all(`SELECT gmail_message_id FROM messages WHERE gmail_message_id IN (${ids.map(() => '?').join(',')})`, ...ids);
  const knownSet = new Set(known.map((k) => k.gmail_message_id));
  let ingested = 0, ignored = 0, maxDate = since;
  const toClose = [];
  for (const id of ids) {
    if (knownSet.has(id)) continue;
    if (ctx.budgetLeft() < 10) break;
    const m = parseGmailMessage(await gmailGet(ctx, id));
    maxDate = Math.max(maxDate, Math.floor(new Date(m.internalDate).getTime() / 1000));
    // só conversas iniciadas pelo sistema: mesmo fio do Gmail, ou remetente igual ao contato abordado
    let conv = await ctx.first('SELECT * FROM conversations WHERE gmail_thread_id = ?', m.threadId);
    if (!conv) {
      conv = await ctx.first(
        `SELECT cv.* FROM conversations cv JOIN contacts ct ON ct.id = cv.contact_id
         WHERE ct.normalized_value = ? AND EXISTS (SELECT 1 FROM messages mm WHERE mm.conversation_id = cv.id AND mm.status = 'sent') ORDER BY cv.id DESC LIMIT 1`, m.from,
      );
    }
    if (!conv) { ignored++; continue; } // e-mail que não é de prospecção: não guardamos nada
    const { inserted, cls } = await ingestInbound(ctx, m, conv);
    if (inserted) { ingested++; if (cls.auto_ok) toClose.push({ conv, m, cls }); }
  }
  await ctx.run("UPDATE integrations SET inbox_cursor = ?, updated_at = ? WHERE provider = 'google'", String(maxDate), nowIso());
  let replied = 0;
  for (const item of toClose) {
    if (ctx.budgetLeft() < 8) break;
    const r = await runCloser(ctx, settings, item.conv, item.m, item.cls);
    if (r.replied) replied++;
  }
  return { checked: ids.length, ingested, ignored, auto_replied: replied };
}
