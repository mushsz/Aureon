// PLANNER — monta a rotina do dia (tela Hoje): poucos cartões, em ordem do que mais vira reunião.
//   1. reply   — responder quem respondeu (100)
//   2. hot     — abriu a mini-auditoria nas últimas 48 h (90)
//   3. meeting — reunião hoje: lembrete pronto (80)
//   4. touch   — toques manuais da sequência (WhatsApp, Instagram, ligação) (60–70)
//   5. decide  — empresas em dúvida na lista de exclusão (30)
// Quem envia é sempre você. O planner só escolhe, escreve o texto e organiza.

import { nowIso, localDate, safeJson, truncate } from '../util.js';
import { getSettings } from '../db.js';
import { composeManual, auditUrl, ensureAuditToken } from './copywriter.js';
import { buildMime, gmailSend, GoogleNotConnected } from '../google.js';
import { normalizePhone } from '../channels.js';

export const PRIORITY = { reply: 100, hot: 90, meeting: 80, touch: 60, decide: 30 };

const addDays = (dateStr, n) => {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
export const nextDay = (dateStr) => addDays(dateStr, 1);

export function taskStmt(ctx, t) {
  const ts = nowIso();
  return ctx.stmt(
    `INSERT OR IGNORE INTO tasks (lead_id, company_id, conversation_id, appointment_id, kind, channel, step, priority, title, reason, message, due_date, dedupe_key, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    t.lead_id ?? null, t.company_id ?? null, t.conversation_id ?? null, t.appointment_id ?? null, t.kind, t.channel || 'none', t.step || 0,
    t.priority ?? PRIORITY[t.kind], truncate(t.title, 200), truncate(t.reason || '', 300), t.message ? truncate(t.message, 2000) : null, t.due_date, t.dedupe_key, ts, ts,
  );
}

/** Canal manual disponível para a empresa, na ordem de preferência, sem repetir o último usado. */
export function pickChannel(company, prefs, lastChannel = null, suppressed = new Set()) {
  const has = {
    whatsapp: company.whatsapp && !suppressed.has(`phone:${company.whatsapp}`),
    instagram: company.instagram && !suppressed.has(`instagram:${company.instagram}`),
    phone: company.phone_norm && !suppressed.has(`phone:${company.phone_norm}`),
  };
  const avail = prefs.filter((c) => has[c]);
  return avail.find((c) => c !== lastChannel) || avail[0] || null;
}

async function loadSuppressed(ctx) {
  const rows = await ctx.all("SELECT type, value FROM suppression_list WHERE type IN ('phone','instagram','email','domain')");
  return new Set(rows.map((r) => `${r.type}:${r.value}`));
}

async function findingsFor(ctx, companyIds) {
  if (!companyIds.length) return new Map();
  const rows = await ctx.all(
    `SELECT a.company_id, a.findings FROM lead_analyses a WHERE a.company_id IN (${companyIds.map(() => '?').join(',')})
       AND a.id = (SELECT MAX(id) FROM lead_analyses b WHERE b.company_id = a.company_id)`, ...companyIds,
  );
  return new Map(rows.map((r) => [r.company_id, safeJson(r.findings, [])]));
}

const LEAD_SELECT = `SELECT l.id AS lead_id, l.stage, l.score, l.priority AS lead_priority, l.service_fit, l.contact_id, l.audit_token, l.manual_step, l.last_manual_at,
  l.audit_last_viewed_at, l.contact_pending, l.needs_review, c.id AS company_id, c.name, c.domain, c.whatsapp, c.instagram, c.phone, c.exclusion_status,
  ct.person_name, ct.normalized_value AS contact_email,
  (SELECT MIN(sent_at) FROM messages m WHERE m.lead_id = l.id AND m.kind = 'initial' AND m.status = 'sent') AS first_email_at
  FROM leads l JOIN companies c ON c.id = l.company_id LEFT JOIN contacts ct ON ct.id = l.contact_id`;

/** Tarefa "quente" na hora em que a mini-auditoria é aberta. */
export async function planHotTask(ctx, leadId) {
  const settings = await getSettings(ctx);
  const today = localDate(ctx.now, settings.timezone);
  const row = await ctx.first(`${LEAD_SELECT} WHERE l.id = ?`, leadId);
  if (!row || !['contatado', 'aguardando_contato', 'qualificado', 'respondeu'].includes(row.stage) || !['allow', 'approved'].includes(row.exclusion_status)) return false;
  const supp = await loadSuppressed(ctx);
  const channel = pickChannel({ ...row, phone_norm: phoneNorm(row.phone) }, ['whatsapp', 'instagram', 'phone'], null, supp);
  if (!channel) return false;
  const findings = (await findingsFor(ctx, [row.company_id])).get(row.company_id) || [];
  const message = composeManual({ channel, kind: 'hot', company: row, findings, service: row.service_fit, sender: settings.sender, auditLink: auditUrl(ctx.env, row.audit_token), personName: row.person_name });
  await taskStmt(ctx, {
    lead_id: row.lead_id, company_id: row.company_id, kind: 'hot', channel, priority: PRIORITY.hot + Math.min(9, Math.floor((row.score || 0) / 12)),
    title: row.name, reason: 'Abriu a sua análise agora', message, due_date: today, dedupe_key: `hot:${row.lead_id}:${today}`,
  }).run();
  ctx.stats.queries++;
  return true;
}

/** Tarefa para responder uma mensagem recebida. */
export function replyTaskStmt(ctx, { conv, lead, inboundId, cls, companyName, today }) {
  return taskStmt(ctx, {
    lead_id: lead.id, company_id: lead.company_id, conversation_id: conv.id, kind: 'reply', channel: 'email',
    priority: PRIORITY.reply + (['meeting', 'positive'].includes(cls.classification) ? 5 : 0),
    title: companyName, reason: cls.reason, due_date: today, dedupe_key: `reply:${inboundId}`,
  });
}

const phoneNorm = (p) => normalizePhone(p);

/** Monta a rotina do dia. Idempotente (dedupe por tarefa/dia). */
export async function runPlan(ctx, { digest = true } = {}) {
  const settings = await getSettings(ctx);
  const P = settings.planner;
  const tz = settings.timezone;
  const today = localDate(ctx.now, tz);
  const ts = nowIso();
  const stmts = [];
  const supp = await loadSuppressed(ctx);
  const created = { reply: 0, hot: 0, meeting: 0, touch: 0, decide: 0 };

  // tarefas antigas: toques e quentes vencidos há mais de 4 dias expiram; decisões são refeitas a cada dia
  stmts.push(ctx.stmt("UPDATE tasks SET status = 'expired', updated_at = ? WHERE status = 'open' AND kind IN ('touch','hot') AND due_date < ?", ts, addDays(today, -4)));
  stmts.push(ctx.stmt("UPDATE tasks SET status = 'expired', updated_at = ? WHERE status = 'open' AND kind IN ('decide','meeting') AND due_date < ?", ts, today));

  // 1. respostas sem resposta sua
  const replies = await ctx.all(
    `SELECT m.id AS inbound_id, m.classification, m.classification_reason, cv.id AS conv_id, l.id AS lead_id, l.company_id, c.name
     FROM messages m JOIN conversations cv ON cv.id = m.conversation_id JOIN leads l ON l.id = m.lead_id JOIN companies c ON c.id = l.company_id
     WHERE m.direction = 'in' AND m.classification NOT IN ('auto','bounce','unsubscribe')
       AND NOT (m.classification = 'refusal' AND m.needs_review = 0)
       AND m.id = (SELECT MAX(id) FROM messages x WHERE x.conversation_id = cv.id AND x.direction = 'in')
       AND NOT EXISTS (SELECT 1 FROM messages o WHERE o.conversation_id = cv.id AND o.direction = 'out' AND o.id > m.id AND o.status IN ('sent','simulated'))
       AND l.stage NOT IN ('nao_contatar','perdido','convertido') LIMIT 20`,
  );
  for (const r of replies) {
    stmts.push(replyTaskStmt(ctx, { conv: { id: r.conv_id }, lead: { id: r.lead_id, company_id: r.company_id }, inboundId: r.inbound_id, cls: { classification: r.classification, reason: r.classification_reason }, companyName: r.name, today }));
    created.reply++;
  }

  // 2. abriram a análise nas últimas 48 h e você ainda não falou com eles depois disso
  const hotCut = new Date(ctx.now.getTime() - 48 * 3_600_000).toISOString();
  const hot = await ctx.all(
    `${LEAD_SELECT} WHERE l.audit_last_viewed_at >= ? AND (l.last_manual_at IS NULL OR l.last_manual_at < l.audit_last_viewed_at)
       AND l.stage IN ('contatado','aguardando_contato','qualificado','respondeu') AND c.exclusion_status IN ('allow','approved') LIMIT 10`, hotCut,
  );

  // 3. reuniões de hoje
  const dayStart = new Date(`${today}T00:00:00Z`).getTime() - 12 * 3_600_000;
  const meetings = await ctx.all(
    `SELECT a.id, a.starts_at, a.meet_link, a.html_link, a.attendee_email, l.id AS lead_id, l.company_id, c.name, c.whatsapp, c.instagram, c.phone, ct.person_name
     FROM appointments a JOIN leads l ON l.id = a.lead_id JOIN companies c ON c.id = l.company_id LEFT JOIN contacts ct ON ct.id = l.contact_id
     WHERE a.status = 'booked' AND a.starts_at >= ? AND a.starts_at < ?`, new Date(dayStart).toISOString(), new Date(dayStart + 48 * 3_600_000).toISOString(),
  );

  // 4. toques manuais: quem recebeu e-mail (passos de email_lead_steps) e quem só tem WhatsApp/Instagram/telefone
  const emailLeads = await ctx.all(
    `${LEAD_SELECT} WHERE l.stage = 'contatado' AND l.last_inbound_at IS NULL AND c.exclusion_status IN ('allow','approved') AND l.contact_id IS NOT NULL
       AND l.manual_step < ? AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.lead_id = l.id AND t.kind = 'touch' AND t.status = 'open')
     ORDER BY l.score DESC LIMIT 40`, P.email_lead_steps.length,
  );
  const manualLeads = await ctx.all(
    `${LEAD_SELECT} WHERE ((l.stage = 'qualificado' AND l.contact_pending = 1 AND l.needs_review = 0 AND l.priority != 'nao_automatico' AND l.score >= ?)
        OR (l.stage = 'contatado' AND l.contact_id IS NULL AND l.last_inbound_at IS NULL))
       AND c.exclusion_status IN ('allow','approved') AND (c.whatsapp IS NOT NULL OR c.instagram IS NOT NULL OR c.phone IS NOT NULL)
       AND l.manual_step < ? AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.lead_id = l.id AND t.kind = 'touch' AND t.status = 'open')
     ORDER BY l.score DESC LIMIT 40`, settings.outreach.min_score, P.manual_lead_steps.length,
  );

  // 5. decisões rápidas (lista de exclusão em dúvida)
  const decide = await ctx.all(
    `SELECT c.id AS company_id, c.name, c.exclusion_reason, l.id AS lead_id FROM companies c JOIN leads l ON l.company_id = c.id
     WHERE c.exclusion_status = 'review' AND l.stage NOT IN ('nao_contatar','perdido') ORDER BY l.score DESC NULLS LAST LIMIT 3`,
  );

  const allIds = [...new Set([...hot, ...emailLeads, ...manualLeads].map((r) => r.company_id))];
  const findingsBy = await findingsFor(ctx, allIds);
  const ctxFor = (r) => ({ company: r, findings: findingsBy.get(r.company_id) || [], service: r.service_fit, sender: settings.sender, personName: r.person_name });

  for (const r of hot) {
    const channel = pickChannel({ ...r, phone_norm: phoneNorm(r.phone) }, ['whatsapp', 'instagram', 'phone'], null, supp);
    if (!channel) continue;
    stmts.push(taskStmt(ctx, {
      lead_id: r.lead_id, company_id: r.company_id, kind: 'hot', channel, priority: PRIORITY.hot + Math.min(9, Math.floor((r.score || 0) / 12)),
      title: r.name, reason: 'Abriu a sua análise', message: composeManual({ ...ctxFor(r), channel, kind: 'hot', auditLink: auditUrl(ctx.env, r.audit_token) }),
      due_date: today, dedupe_key: `hot:${r.lead_id}:${localDate(new Date(r.audit_last_viewed_at), tz)}`,
    }));
    created.hot++;
  }

  for (const a of meetings) {
    if (localDate(new Date(a.starts_at), tz) !== today) continue;
    const channel = a.whatsapp ? 'whatsapp' : a.instagram ? 'instagram' : 'none';
    stmts.push(taskStmt(ctx, {
      lead_id: a.lead_id, company_id: a.company_id, appointment_id: a.id, kind: 'meeting', channel,
      title: a.name, reason: `Reunião hoje às ${new Intl.DateTimeFormat('pt-BR', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(new Date(a.starts_at))}`,
      message: composeManual({ channel, kind: 'meeting', company: a, sender: settings.sender, personName: a.person_name, meetingAt: a.starts_at, timezone: tz, meetLink: a.meet_link || a.html_link }),
      due_date: today, dedupe_key: `meeting:${a.id}:${today}`,
    }));
    created.meeting++;
  }

  const dueTouch = (r, steps, base) => {
    const step = steps[r.manual_step];
    if (!step) return null;
    const prev = r.manual_step > 0 ? steps[r.manual_step - 1] : null;
    const from = prev ? r.last_manual_at : base;
    if (!from) return null;
    const wait = prev ? step.day - prev.day : step.day;
    const dueAt = new Date(from).getTime() + wait * 86_400_000;
    return dueAt <= ctx.now.getTime() + 6 * 3_600_000 ? step : null; // até 6 h adiantado: a lista é da manhã
  };
  let lastChannelBy = new Map();
  const touchedLeads = [...emailLeads, ...manualLeads].map((r) => r.lead_id);
  if (touchedLeads.length) {
    const last = await ctx.all(`SELECT lead_id, channel FROM messages WHERE kind = 'manual_touch' AND lead_id IN (${touchedLeads.map(() => '?').join(',')}) ORDER BY id`, ...touchedLeads);
    lastChannelBy = new Map(last.map((m) => [m.lead_id, m.channel]));
  }
  for (const r of emailLeads) {
    const step = dueTouch(r, P.email_lead_steps, r.first_email_at);
    if (!step) continue;
    const channel = pickChannel({ ...r, phone_norm: phoneNorm(r.phone) }, step.channels, lastChannelBy.get(r.lead_id), supp);
    if (!channel) continue;
    stmts.push(taskStmt(ctx, {
      lead_id: r.lead_id, company_id: r.company_id, kind: 'touch', channel, step: r.manual_step + 1, priority: PRIORITY.touch + Math.min(9, Math.floor((r.score || 0) / 12)),
      title: r.name, reason: `Toque ${r.manual_step + 2} da sequência (já recebeu e-mail)`,
      message: composeManual({ ...ctxFor(r), channel, kind: 'followup', auditLink: auditUrl(ctx.env, r.audit_token) }),
      due_date: today, dedupe_key: `touch:${r.lead_id}:${r.manual_step + 1}`,
    }));
    created.touch++;
  }
  let newManual = 0;
  for (const r of manualLeads) {
    const isNew = r.manual_step === 0;
    if (isNew && newManual >= P.new_manual_per_day) continue;
    const step = dueTouch(r, P.manual_lead_steps, isNew ? ts : null);
    if (!step) continue;
    const channel = pickChannel({ ...r, phone_norm: phoneNorm(r.phone) }, step.channels, lastChannelBy.get(r.lead_id), supp);
    if (!channel) continue;
    const token = await ensureAuditToken(ctx, r.lead_id, r.audit_token);
    stmts.push(taskStmt(ctx, {
      lead_id: r.lead_id, company_id: r.company_id, kind: 'touch', channel, step: r.manual_step + 1, priority: PRIORITY.touch - 2 + Math.min(9, Math.floor((r.score || 0) / 12)),
      title: r.name, reason: isNew ? 'Primeiro contato (sem e-mail publicado)' : `Toque ${r.manual_step + 1} da sequência manual`,
      message: composeManual({ ...ctxFor(r), channel, kind: isNew ? 'first' : 'followup', auditLink: auditUrl(ctx.env, token) }),
      due_date: today, dedupe_key: `touch:${r.lead_id}:${r.manual_step + 1}`,
    }));
    created.touch++;
    if (isNew) newManual++;
  }

  for (const d of decide) {
    stmts.push(taskStmt(ctx, {
      lead_id: d.lead_id, company_id: d.company_id, kind: 'decide', title: d.name, reason: d.exclusion_reason || 'Em dúvida na lista de exclusão',
      due_date: today, dedupe_key: `decide:${d.company_id}:${today}`,
    }));
    created.decide++;
  }

  for (let i = 0; i < stmts.length; i += 80) await ctx.batch(stmts.slice(i, i + 80));

  const summary = await todaySummary(ctx, today);
  let mailed = false;
  if (digest && P.digest_email && summary.open > 0 && settings.sender.email) {
    try {
      const url = `${(ctx.env.APP_URL || '').replace(/\/$/, '')}/#/hoje`;
      const parts = Object.entries(summary.byKind).filter(([, n]) => n).map(([k, n]) => `${n} ${{ reply: 'resposta(s) para responder', hot: 'empresa(s) quente(s)', meeting: 'reunião(ões) hoje', touch: 'toque(s) de WhatsApp/Instagram/ligação', decide: 'decisão(ões) rápida(s)' }[k]}`);
      await gmailSend(ctx, buildMime({
        from: settings.sender.email, fromName: 'Aureon', to: settings.sender.email,
        subject: `Sua manhã: ${summary.shown} tarefa(s), cerca de ${Math.max(2, Math.round(summary.shown * 0.8))} min`,
        text: `Bom dia! A rotina de hoje está pronta:\n\n${parts.map((p) => `• ${p}`).join('\n')}\n\nAbrir no celular: ${url}`,
      }));
      mailed = true;
    } catch (e) { if (!(e instanceof GoogleNotConnected)) ctx.log('warn', 'planner', `Resumo da manhã não enviado: ${e.message}`); }
  }
  ctx.log('info', 'planner', `Rotina de ${today}: ${summary.open} tarefa(s) abertas${mailed ? ' · resumo enviado por e-mail' : ''}`, created);
  return { date: today, created, open: summary.open, mailed };
}

export async function todaySummary(ctx, today) {
  const settings = await getSettings(ctx);
  const rows = await ctx.all("SELECT kind, COUNT(*) AS n FROM tasks WHERE status = 'open' AND due_date <= ? GROUP BY kind", today);
  const byKind = Object.fromEntries(rows.map((r) => [r.kind, r.n]));
  const open = rows.reduce((s, r) => s + r.n, 0);
  return { open, byKind, shown: Math.min(open, settings.planner.max_cards) };
}
