// Rotas da API do painel e páginas públicas (descadastro e agendamento).

import { Router, HttpError, json, html, redirect, readJson, v } from './http.js';
import { createUser, createSession, clearCookie, getSession, checkCsrf, login, changePassword, rateLimit } from './auth.js';
import { getSettings, setSetting, auditStmt, stageStmts } from './db.js';
import { nowIso, safeJson, verifyPayload, escapeHtml, randomToken, hmacSign, hmacVerify, truncate } from './util.js';
import { STAGES, STAGE_KEYS, SERVICES, DEFAULT_SETTINGS } from './defaults.js';
import { SEGMENTS, validateDiscoverRequest, parseManualImport, saveCandidates } from './agents/finder.js';
import { loadRules, checkExclusion, compileRules } from './exclusion.js';
import { tick, enqueueJob, ensureSeeded, TASK_AGENT } from './engine.js';
import { startOAuth, finishOAuth, disconnectGoogle, getIntegration, gmailProfile, freeBusy, buildMime, gmailSend, GoogleNotConnected } from './google.js';
import { findAppointment, availableSlots, bookSlot, cancelBooking, bookingPageHtml, publicPage } from './agents/scheduler.js';
import { createBookingOffer } from './agents/closer.js';
import { validateSender } from './agents/copywriter.js';
import { CLASSES } from './agents/inbox.js';
import { registerToday } from './api_today.js';
import { auditUrl, ensureAuditToken } from './agents/copywriter.js';
import { waLink, igProfile, telLink, normalizePhone, formatPhone } from './channels.js';

const r = new Router();
const PUBLIC = { public: true };

// ---------- público ----------

// Saúde pública e mínima (sem dados de negócio), usada pelo vigia do GitHub Actions.
// attention lista o que precisa de você: Cron parado, Google expirado, pausa emergencial.
r.add('GET', '/api/health', async (ctx) => {
  const [lock, integ, sys] = await Promise.all([
    ctx.first("SELECT updated_at FROM settings WHERE key = 'engine_lock'"),
    ctx.first("SELECT status FROM integrations WHERE provider = 'google'"),
    ctx.first("SELECT value FROM settings WHERE key = 'system'"),
  ]);
  const lastTick = lock?.updated_at || null;
  const attention = [];
  if (!lastTick || Date.now() - new Date(lastTick) > 10 * 60_000) attention.push('cron_parado');
  if (integ?.status === 'expired') attention.push('google_expirado');
  if (safeJson(sys?.value, {})?.emergency_stop) attention.push('pausa_emergencial');
  return json({ ok: true, time: nowIso(), last_tick_at: lastTick, google: integ?.status || 'disconnected', attention });
}, PUBLIC);

r.add('GET', '/api/setup/status', async (ctx) => {
  const n = await ctx.first('SELECT COUNT(*) AS n FROM users');
  return json({ needsSetup: n.n === 0, setupConfigured: !!ctx.env.SETUP_TOKEN });
}, PUBLIC);

r.add('POST', '/api/setup', async (ctx, req) => {
  if (!(await rateLimit(ctx, `setup:${ctx.ip}`, 10, 3600))) throw new HttpError(429, 'Muitas tentativas.');
  const n = await ctx.first('SELECT COUNT(*) AS n FROM users');
  if (n.n > 0) throw new HttpError(409, 'O administrador já foi criado.');
  if (!ctx.env.SETUP_TOKEN) throw new HttpError(400, 'Defina o segredo SETUP_TOKEN no Worker antes do primeiro acesso.');
  const b = await readJson(req);
  const { safeEqual } = await import('./util.js');
  if (!safeEqual(String(b.setup_token || ''), ctx.env.SETUP_TOKEN)) throw new HttpError(403, 'Código de instalação incorreto.');
  const email = v.email(b.email, 'E-mail', true);
  const name = v.str(b.name, { name: 'Nome', min: 2, max: 80, required: true });
  const id = await createUser(ctx, { email, name, password: String(b.password || '') });
  await ensureSeeded(ctx);
  await auditStmt(ctx, id, 'setup_admin_created', 'user', id).run();
  const s = await createSession(ctx, req, id);
  return json({ ok: true, csrf: s.csrf }, 201, { 'set-cookie': s.cookie });
}, PUBLIC);

r.add('POST', '/api/login', async (ctx, req) => {
  const b = await readJson(req);
  const email = v.email(b.email, 'E-mail', true);
  const user = await login(ctx, req, email, String(b.password || ''));
  const s = await createSession(ctx, req, user.id);
  return json({ ok: true, csrf: s.csrf }, 200, { 'set-cookie': s.cookie });
}, PUBLIC);

r.add('POST', '/api/logout', async (ctx, req, p, session) => {
  if (session) await ctx.run('DELETE FROM sessions WHERE id = ?', session.session_id);
  return json({ ok: true }, 200, { 'set-cookie': clearCookie(ctx.env) });
}, { public: true, csrfIfSession: true });

// Descadastro: GET mostra confirmação; POST confirma (também serve ao one-click do List-Unsubscribe)
async function unsubscribe(ctx, token, source) {
  const p = await verifyPayload(ctx.env, token);
  if (!p?.e) return false;
  const email = String(p.e).toLowerCase();
  const ts = nowIso();
  const stmts = [
    ctx.stmt("INSERT OR IGNORE INTO suppression_list (type, value, reason, source, created_at) VALUES ('email', ?, 'unsubscribe', ?, ?)", email, source, ts),
    ctx.stmt("UPDATE contacts SET status = 'suppressed', updated_at = ? WHERE normalized_value = ?", ts, email),
    ctx.stmt(`UPDATE messages SET status = 'cancelled', error = 'cancelado: descadastro', updated_at = ?
              WHERE direction = 'out' AND status = 'draft' AND lead_id IN (SELECT l.id FROM leads l JOIN contacts c ON c.id = l.contact_id WHERE c.normalized_value = ?)`, ts, email),
  ];
  const leads = await ctx.all('SELECT l.* FROM leads l JOIN contacts c ON c.id = l.contact_id WHERE c.normalized_value = ?', email);
  for (const l of leads) stmts.push(...stageStmts(ctx, l, 'nao_contatar', 'Descadastro pelo link', 'unsubscribe'));
  await ctx.batch(stmts);
  ctx.metric('unsubscribes');
  ctx.log('info', 'outreach', `Descadastro: ${email}`);
  return true;
}

r.add('GET', '/u/:token', async (ctx, req, p) => {
  const ok = await verifyPayload(ctx.env, p.token);
  if (!ok) return html(publicPage('Link inválido', '<h1>Link inválido</h1><p>Responda o e-mail com "descadastrar" que removemos seu endereço.</p>'), 400);
  const already = await ctx.first("SELECT id FROM suppression_list WHERE type = 'email' AND value = ?", String(ok.e).toLowerCase());
  if (already) return html(publicPage('Descadastrado', '<h1>Pronto</h1><p>Seu endereço já está fora da lista. Você não receberá novas mensagens.</p>'));
  return html(publicPage('Descadastrar', `<p class="eyebrow">Preferências de contato</p><h1>Parar de receber mensagens?</h1>
<p class="lead">O endereço <strong>${escapeHtml(ok.e)}</strong> não receberá mais nenhum contato comercial.</p>
<form method="post" action="/u/${escapeHtml(p.token)}"><button class="btn" type="submit">Confirmar descadastro</button></form>`));
}, PUBLIC);

r.add('POST', '/u/:token', async (ctx, req, p) => {
  if (!(await rateLimit(ctx, `unsub:${ctx.ip}`, 30, 3600))) throw new HttpError(429, 'Muitas tentativas.');
  const ok = await unsubscribe(ctx, p.token, 'link');
  if (!ok) return html(publicPage('Link inválido', '<h1>Link inválido</h1>'), 400);
  return html(publicPage('Descadastrado', '<h1>Pronto</h1><p>Seu endereço foi removido. Você não receberá novas mensagens.</p>'));
}, PUBLIC);

// Agendamento público (o token do link é a credencial; formulários levam um HMAC do token)
const bookingCsrf = (env, token) => hmacSign(env, `booking:${token}`);
async function bookingGuard(ctx, req, token) {
  if (!(await rateLimit(ctx, `booking:${ctx.ip}`, 60, 3600))) throw new HttpError(429, 'Muitas tentativas. Tente mais tarde.');
  const appt = await findAppointment(ctx, token);
  if (!appt) throw new HttpError(404, 'Link de agendamento inválido ou expirado.');
  appt._token = token;
  return appt;
}

r.add('GET', '/agendar/:token', async (ctx, req, p) => {
  let appt;
  try { appt = await bookingGuard(ctx, req, p.token); }
  catch (e) { return html(publicPage('Link inválido', `<h1>Link indisponível</h1><p>${escapeHtml(e.message)}</p>`), e.status || 400); }
  const settings = await getSettings(ctx);
  let slots = [];
  let error = null;
  if (appt.status !== 'booked') {
    try { slots = await availableSlots(ctx, settings); }
    catch (e) { error = 'Não consegui consultar a agenda agora. Responda o e-mail com sugestões de horário.'; ctx.log('error', 'scheduler', `Agenda indisponível: ${e.message}`); }
  }
  return html(bookingPageHtml({ appt, slots, timezone: settings.timezone, token: p.token, error, csrf: await bookingCsrf(ctx.env, p.token) }));
}, PUBLIC);

async function readForm(req) {
  if (+(req.headers.get('content-length') || 0) > 5000) throw new HttpError(413, 'Formulário grande demais');
  const fd = await req.formData();
  return Object.fromEntries([...fd].map(([k, val]) => [k, typeof val === 'string' ? val.slice(0, 500) : '']));
}

r.add('POST', '/agendar/:token', async (ctx, req, p) => {
  const appt = await bookingGuard(ctx, req, p.token);
  const f = await readForm(req);
  if (!(await hmacVerify(ctx.env, `booking:${p.token}`, f.csrf || ''))) throw new HttpError(403, 'Formulário expirado. Recarregue a página.');
  const settings = await getSettings(ctx);
  if (appt.status === 'booked') return redirect(`/agendar/${p.token}`, 303);
  const result = await bookSlot(ctx, appt, String(f.slot || ''), f.email);
  if (!result.ok) {
    const slots = await availableSlots(ctx, settings).catch(() => []);
    return html(bookingPageHtml({ appt, slots, timezone: settings.timezone, token: p.token, error: result.error, csrf: await bookingCsrf(ctx.env, p.token) }), 409);
  }
  return redirect(`/agendar/${p.token}`, 303);
}, PUBLIC);

r.add('POST', '/agendar/:token/cancelar', async (ctx, req, p) => {
  const appt = await bookingGuard(ctx, req, p.token);
  const f = await readForm(req);
  if (!(await hmacVerify(ctx.env, `booking:${p.token}`, f.csrf || ''))) throw new HttpError(403, 'Formulário expirado. Recarregue a página.');
  if (appt.status === 'booked') await cancelBooking(ctx, appt, 'pelo link do convidado');
  return redirect(`/agendar/${p.token}`, 303);
}, PUBLIC);

// OAuth Google (o retorno vem do Google, então usa o cookie de sessão SameSite=Lax + state)
r.add('GET', '/api/google/callback', async (ctx, req, p, session) => {
  const url = new URL(req.url);
  if (!session) return redirect('/#/configuracoes?google=login');
  if (url.searchParams.get('error')) return redirect(`/#/configuracoes?google=${encodeURIComponent(url.searchParams.get('error'))}`);
  try {
    const { email } = await finishOAuth(ctx, session.id, url.searchParams.get('code') || '', url.searchParams.get('state') || '');
    await auditStmt(ctx, session.id, 'google_connected', 'integration', 'google', { email }).run();
    return redirect('/#/configuracoes?google=ok');
  } catch (e) {
    ctx.log('error', 'google', `OAuth falhou: ${e.message}`);
    return redirect(`/#/configuracoes?google=${encodeURIComponent(truncate(e.message, 150))}`);
  }
}, { public: true });

// ---------- autenticado ----------

r.add('GET', '/api/me', async (ctx, req, p, s) => json({ user: { id: s.id, email: s.email, name: s.name, role: s.role }, csrf: s.csrf_token }));

r.add('POST', '/api/me/password', async (ctx, req, p, s) => {
  const b = await readJson(req);
  await changePassword(ctx, s, String(b.current || ''), String(b.next || ''));
  return json({ ok: true });
});

r.add('GET', '/api/meta', async () => json({
  stages: STAGES, services: Object.fromEntries(Object.entries(SERVICES).map(([k, x]) => [k, x.label])),
  segments: Object.fromEntries(Object.entries(SEGMENTS).map(([k, x]) => [k, x.label])), classes: CLASSES, tasks: TASK_AGENT,
}));

r.add('GET', '/api/dashboard', async (ctx) => {
  const settings = await getSettings(ctx);
  const [counts, msgs, replied, appts, recent, alerts, segs] = (await ctx.batch([
    ctx.stmt(`SELECT
      (SELECT COUNT(*) FROM companies) AS companies,
      (SELECT COUNT(*) FROM companies WHERE exclusion_status = 'block') AS blocked,
      (SELECT COUNT(*) FROM companies WHERE exclusion_status = 'review') AS exclusion_review,
      (SELECT COUNT(*) FROM leads WHERE priority IN ('alta','media','baixa')) AS qualified,
      (SELECT COUNT(*) FROM leads WHERE priority = 'alta') AS high,
      (SELECT COUNT(*) FROM leads WHERE stage IN ('descoberto','em_analise')) AS researching,
      (SELECT COUNT(*) FROM leads WHERE stage = 'qualificado' AND (contact_pending = 1 OR needs_review = 1)) AS pending,
      (SELECT COUNT(*) FROM leads WHERE stage = 'aguardando_contato') AS waiting,
      (SELECT COUNT(*) FROM leads WHERE stage IN ('interessado','reuniao_agendada','convertido')) AS interested,
      (SELECT COUNT(*) FROM leads WHERE stage = 'convertido') AS converted,
      (SELECT COUNT(*) FROM leads WHERE needs_review = 1 AND stage NOT IN ('nao_contatar','perdido')) AS needs_review,
      (SELECT COUNT(*) FROM conversations WHERE status = 'needs_review') AS conv_review`),
    ctx.stmt(`SELECT
      SUM(CASE WHEN direction='out' AND kind='initial' AND status='sent' THEN 1 ELSE 0 END) AS sent,
      SUM(CASE WHEN direction='out' AND kind='initial' AND status='simulated' THEN 1 ELSE 0 END) AS simulated,
      SUM(CASE WHEN direction='out' AND kind='followup' AND status IN ('sent','simulated') THEN 1 ELSE 0 END) AS followups,
      SUM(CASE WHEN direction='in' THEN 1 ELSE 0 END) AS received FROM messages`),
    ctx.stmt(`SELECT COUNT(DISTINCT lead_id) AS n, (SELECT COUNT(DISTINCT lead_id) FROM messages WHERE kind = 'manual_touch') AS manual,
              (SELECT COUNT(DISTINCT lead_id) FROM messages WHERE direction = 'out' AND ((kind = 'initial' AND status IN ('sent','simulated')) OR kind = 'manual_touch')) AS contacted_leads,
              (SELECT COUNT(*) FROM tasks WHERE status = 'open' AND due_date <= ?) AS tasks_open
              FROM messages WHERE direction = 'in' AND classification NOT IN ('auto','bounce')`, nowIso().slice(0, 10)),
    ctx.stmt(`SELECT COUNT(*) AS booked, SUM(CASE WHEN starts_at >= ? THEN 1 ELSE 0 END) AS upcoming FROM appointments WHERE status = 'booked'`, nowIso()),
    ctx.stmt(`SELECT h.created_at, h.from_stage, h.to_stage, h.reason, h.actor, c.name, c.id AS company_id
              FROM lead_stage_history h JOIN leads l ON l.id = h.lead_id JOIN companies c ON c.id = l.company_id ORDER BY h.id DESC LIMIT 12`),
    ctx.stmt(`SELECT id, level, agent, message, created_at FROM automation_logs WHERE level IN ('alert','error') AND seen = 0 ORDER BY id DESC LIMIT 8`),
    ctx.stmt(`SELECT c.segment, COUNT(*) AS n FROM leads l JOIN companies c ON c.id = l.company_id WHERE l.priority IN ('alta','media','baixa') GROUP BY c.segment ORDER BY n DESC LIMIT 6`),
  ])).map((x) => x.results);
  const c = counts[0], m = msgs[0];
  const contacted = replied[0].contacted_leads || 0;
  return json({
    mode: settings.outreach.mode === 'live' && settings.outreach.live_approved_at ? 'live' : 'simulation',
    system: settings.system,
    metrics: {
      companies: c.companies, blocked: c.blocked, exclusion_review: c.exclusion_review, qualified: c.qualified, high: c.high,
      researching: c.researching, pending: c.pending, waiting: c.waiting, contacted_real: m.sent || 0, contacted_simulated: m.simulated || 0,
      followups: m.followups || 0, received: m.received || 0, replied_leads: replied[0].n, interested: c.interested,
      contacted_manual: replied[0].manual || 0, contacted_leads: contacted, tasks_open: replied[0].tasks_open || 0,
      meetings: appts[0].booked || 0, upcoming_meetings: appts[0].upcoming || 0, converted: c.converted,
      needs_review: c.needs_review, conversations_review: c.conv_review,
      response_rate: contacted ? replied[0].n / contacted : null,
      conversion_rate: contacted ? (appts[0].booked || 0) / contacted : null,
    },
    recent, alerts, segments: segs,
  });
});

r.add('POST', '/api/alerts/seen', async (ctx) => {
  await ctx.run("UPDATE automation_logs SET seen = 1 WHERE seen = 0 AND level IN ('alert','error')");
  return json({ ok: true });
});

// ---------- empresas ----------

const SORTS = { score: 'l.score DESC NULLS LAST, c.id DESC', recent: 'c.id DESC', name: 'c.normalized_name ASC' };
r.add('GET', '/api/companies', async (ctx, req) => {
  const u = new URL(req.url).searchParams;
  const where = [];
  const args = [];
  const q = v.str(u.get('q'), { max: 100 });
  if (q) { where.push('(c.normalized_name LIKE ? OR c.domain LIKE ? OR c.normalized_city LIKE ?)'); const like = `%${q.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')}%`; args.push(like, like, like); }
  if (u.get('segment')) { where.push('c.segment = ?'); args.push(u.get('segment')); }
  if (u.get('stage')) { where.push('l.stage = ?'); args.push(v.oneOf(u.get('stage'), STAGE_KEYS, 'etapa')); }
  if (u.get('priority')) { where.push('l.priority = ?'); args.push(u.get('priority')); }
  if (u.get('exclusion')) { where.push('c.exclusion_status = ?'); args.push(v.oneOf(u.get('exclusion'), ['allow', 'review', 'block', 'approved'], 'exclusão')); }
  if (u.get('city')) { where.push('c.normalized_city = ?'); args.push(u.get('city').toLowerCase()); }
  const sort = SORTS[u.get('sort')] || SORTS.score;
  const page = v.int(u.get('page'), { min: 0, max: 10000, def: 0 });
  const sql = `SELECT c.id, c.name, c.segment, c.city, c.state, c.domain, c.website, c.research_status, c.exclusion_status, c.exclusion_reason, c.source,
                      l.id AS lead_id, l.stage, l.score, l.priority, l.service_fit, l.needs_review, l.contact_pending
               FROM companies c LEFT JOIN leads l ON l.company_id = c.id
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${sort} LIMIT 50 OFFSET ?`;
  const [rows, total, segs] = await ctx.batch([
    ctx.stmt(sql, ...args, page * 50),
    ctx.stmt(`SELECT COUNT(*) AS n FROM companies c LEFT JOIN leads l ON l.company_id = c.id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`, ...args),
    ctx.stmt('SELECT segment, COUNT(*) AS n FROM companies GROUP BY segment ORDER BY n DESC LIMIT 40'),
  ]);
  return json({ items: rows.results, total: total.results[0].n, page, segments: segs.results });
});

r.add('GET', '/api/companies/:id', async (ctx, req, p) => {
  const id = v.int(p.id, { min: 1 });
  const company = await ctx.first('SELECT * FROM companies WHERE id = ?', id);
  if (!company) throw new HttpError(404, 'Empresa não encontrada');
  const lead = await ctx.first('SELECT * FROM leads WHERE company_id = ?', id);
  const [analysis, score, contacts, history, messages, appts] = (await ctx.batch([
    ctx.stmt('SELECT * FROM lead_analyses WHERE company_id = ? ORDER BY id DESC LIMIT 1', id),
    ctx.stmt('SELECT * FROM lead_scores WHERE company_id = ? ORDER BY id DESC LIMIT 1', id),
    ctx.stmt(`SELECT ct.*, (SELECT json_group_array(json_object('source_type', s.source_type, 'source_url', s.source_url, 'evidence', s.evidence, 'collected_at', s.collected_at))
              FROM contact_sources s WHERE s.contact_id = ct.id) AS sources FROM contacts ct WHERE ct.company_id = ? ORDER BY ct.is_primary DESC, ct.id`, id),
    ctx.stmt('SELECT * FROM lead_stage_history WHERE lead_id = ? ORDER BY id DESC LIMIT 50', lead?.id ?? -1),
    ctx.stmt('SELECT id, conversation_id, direction, channel, kind, status, subject, body_text, to_addr, from_addr, classification, classification_reason, needs_review, sent_at, received_at, created_at, error FROM messages WHERE lead_id = ? ORDER BY id', lead?.id ?? -1),
    ctx.stmt('SELECT * FROM appointments WHERE lead_id = ? ORDER BY id DESC', lead?.id ?? -1),
  ])).map((x) => x.results);
  const a = analysis[0];
  const wa = normalizePhone(company.whatsapp);
  const ph = normalizePhone(company.phone);
  const token = lead && company.exclusion_status !== 'block' ? await ensureAuditToken(ctx, lead.id, lead.audit_token) : null;
  return json({
    channels: {
      whatsapp: wa ? { display: formatPhone(wa), link: waLink(wa) } : null,
      instagram: company.instagram ? { handle: company.instagram, link: igProfile(company.instagram) } : null,
      phone: ph ? { display: formatPhone(ph), link: telLink(ph) } : null,
      audit_url: auditUrl(ctx.env, token),
      audit_views: lead?.audit_views || 0, audit_last_viewed_at: lead?.audit_last_viewed_at || null,
    },
    company: { ...company, source_tags: safeJson(company.source_tags, {}) },
    lead,
    analysis: a ? { ...a, signals: safeJson(a.signals, {}), findings: safeJson(a.findings, []), psi: safeJson(a.psi) } : null,
    score: score[0] ? { ...score[0], breakdown: safeJson(score[0].breakdown, []) } : null,
    contacts: contacts.map((c) => ({ ...c, sources: safeJson(c.sources, []) })),
    history, messages, appointments: appts.map(({ token_hash, ...x }) => x),
  });
});

async function leadFor(ctx, companyId) {
  const lead = await ctx.first('SELECT * FROM leads WHERE company_id = ?', companyId);
  return lead;
}

r.add('POST', '/api/companies/:id/block', async (ctx, req, p, s) => {
  const id = v.int(p.id, { min: 1 });
  const b = await readJson(req);
  const reason = v.str(b.reason, { name: 'Motivo', max: 200 }) || 'Bloqueada manualmente';
  const company = await ctx.first('SELECT * FROM companies WHERE id = ?', id);
  if (!company) throw new HttpError(404, 'Empresa não encontrada');
  const ts = nowIso();
  const stmts = [ctx.stmt("UPDATE companies SET exclusion_status = 'block', exclusion_reason = ?, research_status = CASE WHEN research_status='pending' THEN 'skipped' ELSE research_status END, updated_at = ? WHERE id = ?", `Manual: ${reason}`, ts, id)];
  if (v.bool(b.add_rule) && company.domain) stmts.push(ctx.stmt("INSERT OR IGNORE INTO exclusion_rules (type, value, reason, is_system, active, created_at, updated_at) VALUES ('domain', ?, ?, 0, 1, ?, ?)", company.domain, reason, ts, ts));
  stmts.push(ctx.stmt("UPDATE messages SET status = 'cancelled', error = 'empresa bloqueada', updated_at = ? WHERE direction='out' AND status='draft' AND lead_id IN (SELECT id FROM leads WHERE company_id = ?)", ts, id));
  const lead = await leadFor(ctx, id);
  if (lead) stmts.push(...stageStmts(ctx, lead, 'nao_contatar', `Bloqueada: ${reason}`, `user:${s.id}`));
  stmts.push(auditStmt(ctx, s.id, 'company_blocked', 'company', id, { reason, add_rule: !!b.add_rule }));
  await ctx.batch(stmts);
  return json({ ok: true });
});

r.add('POST', '/api/companies/:id/approve', async (ctx, req, p, s) => {
  const id = v.int(p.id, { min: 1 });
  const company = await ctx.first('SELECT * FROM companies WHERE id = ?', id);
  if (!company) throw new HttpError(404, 'Empresa não encontrada');
  if (company.exclusion_status === 'block') throw new HttpError(400, 'Empresa bloqueada pela lista de exclusão. Para liberar, desative a regra que a bloqueou.');
  const ts = nowIso();
  await ctx.batch([
    ctx.stmt("UPDATE companies SET exclusion_status = 'approved', exclusion_reason = COALESCE(exclusion_reason,'') || ' · liberada manualmente', updated_at = ? WHERE id = ?", ts, id),
    ctx.stmt("UPDATE leads SET needs_review = 0, priority = CASE WHEN score >= 80 THEN 'alta' WHEN score >= 60 THEN 'media' WHEN score >= 40 THEN 'baixa' ELSE 'nao_automatico' END, updated_at = ? WHERE company_id = ?", ts, id),
    auditStmt(ctx, s.id, 'company_approved', 'company', id),
  ]);
  return json({ ok: true });
});

r.add('POST', '/api/companies/:id/reinvestigate', async (ctx, req, p, s) => {
  const id = v.int(p.id, { min: 1 });
  const lead = await leadFor(ctx, id);
  const stmts = [ctx.stmt("UPDATE companies SET research_status = 'pending', research_attempts = 0, updated_at = ? WHERE id = ? AND exclusion_status != 'block'", nowIso(), id)];
  if (lead && ['descoberto', 'em_analise', 'qualificado'].includes(lead.stage)) stmts.push(...stageStmts(ctx, lead, 'descoberto', 'Nova análise pedida', `user:${s.id}`));
  await ctx.batch(stmts);
  return json({ ok: true });
});

r.add('DELETE', '/api/companies/:id', async (ctx, req, p, s) => {
  const id = v.int(p.id, { min: 1 });
  const company = await ctx.first('SELECT id, name, domain FROM companies WHERE id = ?', id);
  if (!company) throw new HttpError(404, 'Empresa não encontrada');
  await ctx.batch([
    ctx.stmt('DELETE FROM companies WHERE id = ?', id),
    auditStmt(ctx, s.id, 'company_deleted', 'company', id, { name: company.name, domain: company.domain }),
  ]);
  return json({ ok: true });
});

r.add('POST', '/api/discover', async (ctx, req, p, s) => {
  const b = await readJson(req);
  const request = validateDiscoverRequest(b);
  const jobId = await enqueueJob(ctx, 'discover', { request }, { priority: 2 });
  await auditStmt(ctx, s.id, 'discover_requested', 'job', jobId, request).run();
  const summary = v.bool(b.run_now) ? await tick(ctx, { maxJobs: 1 }) : null;
  return json({ ok: true, job_id: jobId, summary });
});

r.add('POST', '/api/import', async (ctx, req, p, s) => {
  const b = await readJson(req);
  const rows = parseManualImport(v.str(b.text, { name: 'Lista', max: 60_000, required: true }), { city: v.str(b.city, { max: 80 }), state: v.str(b.state, { max: 2 }), segment: v.str(b.segment, { max: 40 }) });
  if (!rows.length) throw new HttpError(400, 'Nenhuma linha válida. Formato: nome; site; cidade; UF; segmento; e-mail; telefone');
  const counts = await saveCandidates(ctx, rows, `user:${s.id}`);
  await auditStmt(ctx, s.id, 'manual_import', 'companies', null, counts).run();
  return json({ ok: true, ...counts });
});

// ---------- pipeline ----------

r.add('GET', '/api/pipeline', async (ctx) => {
  const rows = await ctx.all(
    `SELECT * FROM (SELECT l.id, l.stage, l.score, l.priority, l.service_fit, l.needs_review, l.contact_pending, l.updated_at,
            c.id AS company_id, c.name, c.city, c.segment,
            ROW_NUMBER() OVER (PARTITION BY l.stage ORDER BY l.score DESC NULLS LAST, l.updated_at DESC) AS rn
     FROM leads l JOIN companies c ON c.id = l.company_id) WHERE rn <= 40`,
  );
  const counts = await ctx.all('SELECT stage, COUNT(*) AS n FROM leads GROUP BY stage');
  return json({ stages: STAGES, items: rows, counts: Object.fromEntries(counts.map((x) => [x.stage, x.n])) });
});

r.add('POST', '/api/leads/:id/stage', async (ctx, req, p, s) => {
  const id = v.int(p.id, { min: 1 });
  const b = await readJson(req);
  const to = v.oneOf(b.stage, STAGE_KEYS, 'etapa');
  const lead = await ctx.first('SELECT * FROM leads WHERE id = ?', id);
  if (!lead) throw new HttpError(404, 'Lead não encontrado');
  const reason = v.str(b.reason, { max: 300 }) || 'Alterado manualmente';
  const stmts = stageStmts(ctx, lead, to, reason, `user:${s.id}`, to === 'perdido' ? { lost_reason: reason } : {});
  if (to === 'nao_contatar') {
    const ct = lead.contact_id ? await ctx.first('SELECT normalized_value FROM contacts WHERE id = ?', lead.contact_id) : null;
    if (ct) stmts.push(ctx.stmt("INSERT OR IGNORE INTO suppression_list (type, value, reason, source, created_at) VALUES ('email', ?, 'manual', ?, ?)", ct.normalized_value, `user:${s.id}`, nowIso()));
    stmts.push(ctx.stmt("UPDATE messages SET status='cancelled', error='não contatar', updated_at=? WHERE lead_id=? AND direction='out' AND status='draft'", nowIso(), id));
  }
  stmts.push(auditStmt(ctx, s.id, 'lead_stage_changed', 'lead', id, { from: lead.stage, to }));
  await ctx.batch(stmts);
  return json({ ok: true });
});

r.add('POST', '/api/leads/:id/review-done', async (ctx, req, p, s) => {
  const id = v.int(p.id, { min: 1 });
  await ctx.batch([ctx.stmt('UPDATE leads SET needs_review = 0, updated_at = ? WHERE id = ?', nowIso(), id), auditStmt(ctx, s.id, 'lead_reviewed', 'lead', id)]);
  return json({ ok: true });
});

// ---------- conversas ----------

r.add('GET', '/api/conversations', async (ctx, req) => {
  const f = new URL(req.url).searchParams.get('filter') || 'all';
  const where = f === 'review' ? "WHERE cv.status = 'needs_review'" : f === 'drafts' ? "WHERE EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = cv.id AND m.status = 'draft')" : f === 'replied' ? "WHERE EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = cv.id AND m.direction = 'in')" : '';
  const rows = await ctx.all(
    `SELECT cv.id, cv.status, cv.subject, cv.last_message_at, cv.created_at, l.id AS lead_id, l.stage, c.name, c.id AS company_id,
       (SELECT body_text FROM messages m WHERE m.conversation_id = cv.id ORDER BY m.id DESC LIMIT 1) AS last_body,
       (SELECT direction FROM messages m WHERE m.conversation_id = cv.id ORDER BY m.id DESC LIMIT 1) AS last_direction,
       (SELECT status FROM messages m WHERE m.conversation_id = cv.id ORDER BY m.id DESC LIMIT 1) AS last_status,
       (SELECT classification FROM messages m WHERE m.conversation_id = cv.id AND m.direction='in' ORDER BY m.id DESC LIMIT 1) AS last_class
     FROM conversations cv JOIN leads l ON l.id = cv.lead_id JOIN companies c ON c.id = l.company_id ${where}
     ORDER BY COALESCE(cv.last_message_at, cv.created_at) DESC LIMIT 100`,
  );
  return json({ items: rows.map((x) => ({ ...x, last_body: truncate(x.last_body, 160) })) });
});

r.add('GET', '/api/conversations/:id', async (ctx, req, p) => {
  const id = v.int(p.id, { min: 1 });
  const conv = await ctx.first(
    `SELECT cv.*, l.stage, l.company_id, c.name, ct.normalized_value AS contact_email, ct.status AS contact_status
     FROM conversations cv JOIN leads l ON l.id = cv.lead_id JOIN companies c ON c.id = l.company_id LEFT JOIN contacts ct ON ct.id = cv.contact_id WHERE cv.id = ?`, id,
  );
  if (!conv) throw new HttpError(404, 'Conversa não encontrada');
  const messages = await ctx.all('SELECT * FROM messages WHERE conversation_id = ? ORDER BY COALESCE(sent_at, received_at, created_at), id', id);
  return json({ conversation: conv, messages });
});

async function sendReply(ctx, s, id, body) {
  const settings = await getSettings(ctx);
  const conv = await ctx.first('SELECT cv.*, ct.normalized_value AS to_addr FROM conversations cv LEFT JOIN contacts ct ON ct.id = cv.contact_id WHERE cv.id = ?', id);
  if (!conv) throw new HttpError(404, 'Conversa não encontrada');
  const lastIn = await ctx.first("SELECT * FROM messages WHERE conversation_id = ? AND direction = 'in' ORDER BY id DESC LIMIT 1", id);
  const to = lastIn?.from_addr || conv.to_addr;
  if (!to) throw new HttpError(400, 'Essa conversa não tem e-mail para responder.');
  const { isSuppressed } = await import('./exclusion.js');
  const sup = await isSuppressed(ctx, to);
  if (sup) throw new HttpError(400, `Destinatário na lista de supressão (${sup}). Não é possível enviar.`);
  if (validateSender(settings.sender).length) throw new HttpError(400, 'Preencha os dados do remetente em Configurações.');
  const subject = lastIn?.subject ? (/^re:/i.test(lastIn.subject) ? lastIn.subject : `Re: ${lastIn.subject}`) : `Re: ${conv.subject || ''}`;
  let sent;
  try {
    sent = await gmailSend(ctx, buildMime({ from: settings.sender.email, fromName: settings.sender.name, to, subject, text: body, inReplyTo: lastIn?.rfc_message_id, references: lastIn?.rfc_message_id }), conv.gmail_thread_id);
  } catch (e) {
    if (e instanceof GoogleNotConnected) throw new HttpError(400, 'Conecte o Google em Configurações para responder.');
    throw e;
  }
  const ts = nowIso();
  await ctx.batch([
    ctx.stmt(`INSERT INTO messages (conversation_id, lead_id, direction, kind, status, subject, body_text, to_addr, from_addr, gmail_message_id, sent_at, created_at, updated_at)
              VALUES (?, ?, 'out', 'manual_reply', 'sent', ?, ?, ?, ?, ?, ?, ?, ?)`, id, conv.lead_id, subject, body, to, settings.sender.email, sent.id, ts, ts, ts),
    ctx.stmt("UPDATE conversations SET status = 'open', last_message_at = ?, gmail_thread_id = COALESCE(gmail_thread_id, ?), updated_at = ? WHERE id = ?", ts, sent.threadId, ts, id),
    ctx.stmt('UPDATE messages SET needs_review = 0 WHERE conversation_id = ?', id),
    ctx.stmt("UPDATE tasks SET status = 'done', done_at = ?, updated_at = ? WHERE conversation_id = ? AND kind = 'reply' AND status = 'open'", ts, ts, id),
    auditStmt(ctx, s.id, 'manual_reply_sent', 'conversation', id),
  ]);
}

r.add('POST', '/api/conversations/:id/reply', async (ctx, req, p, s) => {
  const id = v.int(p.id, { min: 1 });
  const b = await readJson(req);
  await sendReply(ctx, s, id, v.str(b.body, { name: 'Mensagem', min: 2, max: 8000, required: true }));
  return json({ ok: true });
});

r.add('POST', '/api/conversations/:id/resolve', async (ctx, req, p, s) => {
  const id = v.int(p.id, { min: 1 });
  const b = await readJson(req);
  const conv = await ctx.first('SELECT * FROM conversations WHERE id = ?', id);
  if (!conv) throw new HttpError(404, 'Conversa não encontrada');
  const stmts = [
    ctx.stmt("UPDATE conversations SET status = 'open', updated_at = ? WHERE id = ?", nowIso(), id),
    ctx.stmt('UPDATE messages SET needs_review = 0 WHERE conversation_id = ?', id),
    ctx.stmt('UPDATE leads SET needs_review = 0, updated_at = ? WHERE id = ?', nowIso(), conv.lead_id),
  ];
  if (b.classification) {
    const cls = v.oneOf(b.classification, Object.keys(CLASSES), 'classificação');
    stmts.push(ctx.stmt("UPDATE messages SET classification = ?, classification_reason = 'ajustado manualmente' WHERE id = (SELECT MAX(id) FROM messages WHERE conversation_id = ? AND direction = 'in')", cls, id));
    if (cls === 'unsubscribe' || cls === 'refusal') {
      const lastIn = await ctx.first("SELECT from_addr FROM messages WHERE conversation_id = ? AND direction = 'in' ORDER BY id DESC LIMIT 1", id);
      if (lastIn?.from_addr) stmts.push(ctx.stmt("INSERT OR IGNORE INTO suppression_list (type, value, reason, source, created_at) VALUES ('email', ?, ?, ?, ?)", lastIn.from_addr, cls, `user:${s.id}`, nowIso()));
      const lead = await ctx.first('SELECT * FROM leads WHERE id = ?', conv.lead_id);
      stmts.push(...stageStmts(ctx, lead, cls === 'unsubscribe' ? 'nao_contatar' : 'perdido', 'Classificação manual', `user:${s.id}`));
    }
  }
  stmts.push(auditStmt(ctx, s.id, 'conversation_resolved', 'conversation', id, { classification: b.classification || null }));
  await ctx.batch(stmts);
  return json({ ok: true });
});

r.add('POST', '/api/conversations/:id/booking-link', async (ctx, req, p) => {
  const id = v.int(p.id, { min: 1 });
  const conv = await ctx.first('SELECT * FROM conversations WHERE id = ?', id);
  if (!conv) throw new HttpError(404, 'Conversa não encontrada');
  const settings = await getSettings(ctx);
  const url = await createBookingOffer(ctx, { id: conv.lead_id }, id, settings.timezone);
  return json({ url });
});

r.add('POST', '/api/messages/:id/cancel', async (ctx, req, p, s) => {
  const id = v.int(p.id, { min: 1 });
  const m = await ctx.first("SELECT * FROM messages WHERE id = ? AND status = 'draft'", id);
  if (!m) throw new HttpError(404, 'Rascunho não encontrado');
  const lead = await ctx.first('SELECT * FROM leads WHERE id = ?', m.lead_id);
  await ctx.batch([
    ctx.stmt("UPDATE messages SET status = 'cancelled', error = 'cancelado manualmente', updated_at = ? WHERE id = ?", nowIso(), id),
    ...stageStmts(ctx, lead, 'qualificado', 'Rascunho cancelado manualmente', `user:${s.id}`, { needs_review: 1 }),
    auditStmt(ctx, s.id, 'draft_cancelled', 'message', id),
  ]);
  return json({ ok: true });
});

// ---------- agenda ----------

r.add('GET', '/api/appointments', async (ctx) => {
  const rows = await ctx.all(
    `SELECT a.id, a.status, a.starts_at, a.ends_at, a.attendee_email, a.html_link, a.created_at, l.id AS lead_id, c.name, c.id AS company_id
     FROM appointments a JOIN leads l ON l.id = a.lead_id JOIN companies c ON c.id = l.company_id
     WHERE a.status = 'booked' OR a.created_at >= ? ORDER BY COALESCE(a.starts_at, a.created_at) DESC LIMIT 100`, new Date(Date.now() - 30 * 86_400_000).toISOString(),
  );
  return json({ items: rows });
});

r.add('POST', '/api/appointments/:id/cancel', async (ctx, req, p, s) => {
  const id = v.int(p.id, { min: 1 });
  const appt = await ctx.first(`SELECT a.*, l.stage, c.name AS company_name FROM appointments a JOIN leads l ON l.id = a.lead_id JOIN companies c ON c.id = l.company_id WHERE a.id = ?`, id);
  if (!appt || appt.status !== 'booked') throw new HttpError(404, 'Reunião não encontrada');
  await cancelBooking(ctx, appt, 'cancelado pelo painel');
  await auditStmt(ctx, s.id, 'appointment_cancelled', 'appointment', id).run();
  return json({ ok: true });
});

r.add('GET', '/api/availability/preview', async (ctx) => {
  const settings = await getSettings(ctx);
  try { return json({ slots: (await availableSlots(ctx, settings)).slice(0, 12) }); }
  catch (e) { throw new HttpError(400, e instanceof GoogleNotConnected ? 'Conecte o Google Calendar primeiro.' : e.message); }
});

// ---------- automação ----------

r.add('GET', '/api/automation', async (ctx) => {
  const settings = await getSettings(ctx);
  const [schedules, jobs, errors, counts] = (await ctx.batch([
    ctx.stmt('SELECT * FROM schedules ORDER BY start_time'),
    ctx.stmt('SELECT id, type, status, attempts, max_attempts, run_after, last_error, result, created_at, finished_at FROM automation_jobs ORDER BY id DESC LIMIT 40'),
    ctx.stmt("SELECT id, level, agent, message, created_at FROM automation_logs WHERE level IN ('warn','error','alert') ORDER BY id DESC LIMIT 40"),
    ctx.stmt("SELECT status, COUNT(*) AS n FROM automation_jobs GROUP BY status"),
  ])).map((x) => x.results);
  const lastTick = await ctx.first("SELECT updated_at FROM settings WHERE key = 'engine_lock'");
  return json({
    system: settings.system, agents: settings.agents, schedules, jobs: jobs.map((j) => ({ ...j, result: safeJson(j.result) })), errors,
    job_counts: Object.fromEntries(counts.map((c) => [c.status, c.n])), targets: settings.finder.targets, timezone: settings.timezone,
    outreach: settings.outreach, last_tick_at: lastTick?.updated_at || null,
  });
});

r.add('PUT', '/api/schedules/:task', async (ctx, req, p, s) => {
  const task = v.oneOf(p.task, Object.keys(TASK_AGENT), 'tarefa');
  const b = await readJson(req);
  const end = b.end_time ? v.hm(b.end_time, 'Horário final') : null;
  const start = v.hm(b.start_time, 'Horário inicial');
  if (end && end <= start) throw new HttpError(400, 'O horário final precisa ser depois do inicial.');
  const vals = [
    v.bool(b.enabled) ? 1 : 0, v.days(b.days).join(','), start, end,
    v.int(b.interval_minutes, { name: 'Intervalo', min: 0, max: 720, def: 0 }), v.int(b.batch_size, { name: 'Lote', min: 1, max: 50, def: 1 }), nowIso(), task,
  ];
  await ctx.batch([
    ctx.stmt('UPDATE schedules SET enabled = ?, days = ?, start_time = ?, end_time = ?, interval_minutes = ?, batch_size = ?, updated_at = ? WHERE task = ?', ...vals),
    auditStmt(ctx, s.id, 'schedule_updated', 'schedule', task, b),
  ]);
  return json({ ok: true });
});

r.add('POST', '/api/schedules/:task/resume', async (ctx, req, p, s) => {
  const task = v.oneOf(p.task, Object.keys(TASK_AGENT), 'tarefa');
  await ctx.batch([ctx.stmt('UPDATE schedules SET paused_until = NULL, paused_reason = NULL WHERE task = ?', task), auditStmt(ctx, s.id, 'schedule_resumed', 'schedule', task)]);
  return json({ ok: true });
});

r.add('POST', '/api/agents', async (ctx, req, p, s) => {
  const b = await readJson(req);
  const settings = await getSettings(ctx);
  const agent = v.oneOf(b.agent, Object.keys(DEFAULT_SETTINGS.agents), 'agente');
  await setSetting(ctx, 'agents', { ...settings.agents, [agent]: v.bool(b.enabled) });
  await auditStmt(ctx, s.id, 'agent_toggled', 'agent', agent, { enabled: v.bool(b.enabled) }).run();
  return json({ ok: true });
});

r.add('POST', '/api/system/pause', async (ctx, req, p, s) => {
  const b = await readJson(req);
  const settings = await getSettings(ctx);
  const paused = v.bool(b.paused);
  await setSetting(ctx, 'system', { ...settings.system, paused, paused_reason: paused ? (v.str(b.reason, { max: 200 }) || 'Pausa manual') : null, paused_at: paused ? nowIso() : null });
  await auditStmt(ctx, s.id, paused ? 'system_paused' : 'system_resumed').run();
  return json({ ok: true });
});

r.add('POST', '/api/system/emergency', async (ctx, req, p, s) => {
  const b = await readJson(req);
  const settings = await getSettings(ctx);
  const on = v.bool(b.on);
  await setSetting(ctx, 'system', { ...settings.system, emergency_stop: on, paused: on ? true : settings.system.paused, paused_reason: on ? 'Pausa emergencial' : settings.system.paused_reason, paused_at: on ? nowIso() : settings.system.paused_at });
  if (on) await ctx.run("UPDATE automation_jobs SET status = 'cancelled', updated_at = ? WHERE status = 'pending'", nowIso());
  await auditStmt(ctx, s.id, on ? 'emergency_stop_on' : 'emergency_stop_off').run();
  ctx.log('alert', 'engine', on ? 'PAUSA EMERGENCIAL ativada pelo painel' : 'Pausa emergencial desativada');
  return json({ ok: true });
});

r.add('POST', '/api/jobs/run', async (ctx, req, p, s) => {
  const b = await readJson(req);
  const type = v.oneOf(b.type, Object.keys(TASK_AGENT), 'tarefa');
  const settings = await getSettings(ctx);
  if (settings.system.emergency_stop) throw new HttpError(409, 'Pausa emergencial ativa.');
  const sched = await ctx.first('SELECT batch_size FROM schedules WHERE task = ?', type);
  const id = await enqueueJob(ctx, type, { batch: sched?.batch_size || 1, manual: true }, { priority: 1 });
  await auditStmt(ctx, s.id, 'job_run_now', 'job', id, { type }).run();
  const summary = await tick(ctx, { maxJobs: 1 });
  return json({ ok: true, job_id: id, summary });
});

r.add('POST', '/api/jobs/:id/retry', async (ctx, req, p, s) => {
  const id = v.int(p.id, { min: 1 });
  await ctx.run("UPDATE automation_jobs SET status = 'pending', attempts = 0, run_after = ?, updated_at = ? WHERE id = ? AND status IN ('failed','dead','cancelled')", nowIso(), nowIso(), id);
  return json({ ok: true });
});

r.add('POST', '/api/jobs/:id/cancel', async (ctx, req, p) => {
  const id = v.int(p.id, { min: 1 });
  await ctx.run("UPDATE automation_jobs SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'pending'", nowIso(), id);
  return json({ ok: true });
});

r.add('PUT', '/api/finder/targets', async (ctx, req, p, s) => {
  const b = await readJson(req);
  if (!Array.isArray(b.targets) || b.targets.length > 50) throw new HttpError(400, 'Envie até 50 alvos.');
  const targets = b.targets.map((t) => { try { return validateDiscoverRequest(t); } catch (e) { throw new HttpError(400, e.message); } });
  const settings = await getSettings(ctx);
  await setSetting(ctx, 'finder', { ...settings.finder, targets, target_cursor: 0 });
  await auditStmt(ctx, s.id, 'finder_targets_updated', 'settings', 'finder', { n: targets.length }).run();
  return json({ ok: true, targets });
});

// ---------- exclusão e supressão ----------

const RULE_TYPES = ['keyword', 'review_keyword', 'category', 'review_category', 'cnae', 'review_cnae', 'domain', 'company'];
r.add('GET', '/api/exclusions', async (ctx, req) => {
  const u = new URL(req.url).searchParams;
  const where = [];
  const args = [];
  if (u.get('type')) { where.push('type = ?'); args.push(v.oneOf(u.get('type'), RULE_TYPES, 'tipo')); }
  if (u.get('q')) { where.push('value LIKE ?'); args.push(`%${v.str(u.get('q'), { max: 80 })}%`); }
  const rows = await ctx.all(`SELECT * FROM exclusion_rules ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY is_system, type, value LIMIT 500`, ...args);
  const blocked = await ctx.first("SELECT COUNT(*) AS n FROM companies WHERE exclusion_status = 'block'");
  return json({ items: rows, blocked_companies: blocked.n });
});

r.add('POST', '/api/exclusions', async (ctx, req, p, s) => {
  const b = await readJson(req);
  const type = v.oneOf(b.type, RULE_TYPES, 'tipo');
  let value = v.str(b.value, { name: 'Valor', min: 2, max: 120, required: true }).toLowerCase();
  if (type === 'domain') value = value.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  if ((type === 'category' || type === 'review_category') && !/^[a-z_:]+=[a-z_*]+$/.test(value)) throw new HttpError(400, 'Categoria no formato chave=valor, ex.: amenity=clinic');
  if ((type === 'cnae' || type === 'review_cnae') && !/^\d{2,7}$/.test(value.replace(/\D/g, ''))) throw new HttpError(400, 'CNAE: de 2 a 7 dígitos');
  const ts = nowIso();
  const reason = v.str(b.reason, { max: 200 }) || 'Adicionada manualmente';
  await ctx.batch([
    ctx.stmt('INSERT INTO exclusion_rules (type, value, reason, is_system, active, created_at, updated_at) VALUES (?,?,?,0,1,?,?) ON CONFLICT(type, value) DO UPDATE SET active = 1, updated_at = excluded.updated_at', type, value, reason, ts, ts),
    auditStmt(ctx, s.id, 'exclusion_added', 'exclusion_rule', `${type}:${value}`, { reason }),
  ]);
  // reaplica nas empresas existentes ainda não contatadas
  const rules = compileRules([{ type, value, reason }]);
  const cands = await ctx.all(
    `SELECT c.*, l.id AS lead_id, l.stage FROM companies c LEFT JOIN leads l ON l.company_id = c.id
     WHERE c.exclusion_status IN ('allow','approved','review') AND (l.stage IS NULL OR l.stage IN ('descoberto','em_analise','qualificado','aguardando_contato')) LIMIT 2000`,
  );
  const { subjectFromCompany } = await import('./exclusion.js');
  const stmts = [];
  let affected = 0;
  for (const c of cands) {
    const res = checkExclusion(rules, subjectFromCompany(c));
    if (res.verdict === 'allow') continue;
    affected++;
    if (res.verdict === 'block') {
      stmts.push(ctx.stmt("UPDATE companies SET exclusion_status = 'block', exclusion_reason = ?, updated_at = ? WHERE id = ?", `Regra ${type}: ${value}`, ts, c.id));
      stmts.push(ctx.stmt("UPDATE messages SET status = 'cancelled', error = 'lista de exclusão', updated_at = ? WHERE lead_id = ? AND status = 'draft'", ts, c.lead_id ?? -1));
      if (c.lead_id) stmts.push(...stageStmts(ctx, { id: c.lead_id, stage: c.stage }, 'nao_contatar', `Nova regra de exclusão: ${type} ${value}`, `user:${s.id}`));
    } else if (c.exclusion_status === 'allow') {
      stmts.push(ctx.stmt("UPDATE companies SET exclusion_status = 'review', exclusion_reason = ?, updated_at = ? WHERE id = ?", `Regra ${type}: ${value}`, ts, c.id));
      if (c.lead_id) stmts.push(ctx.stmt('UPDATE leads SET needs_review = 1 WHERE id = ?', c.lead_id));
    }
  }
  for (let i = 0; i < stmts.length; i += 200) await ctx.batch(stmts.slice(i, i + 200));
  return json({ ok: true, affected });
});

r.add('PATCH', '/api/exclusions/:id', async (ctx, req, p, s) => {
  const id = v.int(p.id, { min: 1 });
  const b = await readJson(req);
  await ctx.batch([
    ctx.stmt('UPDATE exclusion_rules SET active = ?, updated_at = ? WHERE id = ?', v.bool(b.active) ? 1 : 0, nowIso(), id),
    auditStmt(ctx, s.id, v.bool(b.active) ? 'exclusion_enabled' : 'exclusion_disabled', 'exclusion_rule', id),
  ]);
  return json({ ok: true });
});

r.add('DELETE', '/api/exclusions/:id', async (ctx, req, p, s) => {
  const id = v.int(p.id, { min: 1 });
  const rule = await ctx.first('SELECT * FROM exclusion_rules WHERE id = ?', id);
  if (!rule) throw new HttpError(404, 'Regra não encontrada');
  if (rule.is_system) throw new HttpError(400, 'Regras do sistema não podem ser apagadas, só desativadas.');
  await ctx.batch([ctx.stmt('DELETE FROM exclusion_rules WHERE id = ?', id), auditStmt(ctx, s.id, 'exclusion_deleted', 'exclusion_rule', id, rule)]);
  return json({ ok: true });
});

r.add('POST', '/api/exclusions/test', async (ctx, req) => {
  const b = await readJson(req);
  const rules = await loadRules(ctx);
  const res = checkExclusion(rules, {
    name: v.str(b.name, { max: 200 }), segment: v.str(b.segment, { max: 80 }), domain: v.str(b.domain, { max: 200 }), website: v.str(b.domain, { max: 200 }),
    email: v.str(b.email, { max: 200 }), text: v.str(b.text, { max: 5000 }), cnaes: v.str(b.cnae, { max: 20 }) ? [b.cnae] : [],
    tags: b.tag && /=/.test(b.tag) ? Object.fromEntries([String(b.tag).split('=')]) : {},
  });
  return json(res);
});

r.add('GET', '/api/suppression', async (ctx) => json({ items: await ctx.all('SELECT * FROM suppression_list ORDER BY id DESC LIMIT 500') }));

r.add('POST', '/api/suppression', async (ctx, req, p, s) => {
  const b = await readJson(req);
  const type = v.oneOf(b.type, ['email', 'domain'], 'tipo');
  const value = type === 'email' ? v.email(b.value, 'E-mail', true) : v.str(b.value, { name: 'Domínio', min: 3, max: 200, required: true }).toLowerCase().replace(/^www\./, '');
  const ts = nowIso();
  await ctx.batch([
    ctx.stmt("INSERT OR IGNORE INTO suppression_list (type, value, reason, source, created_at) VALUES (?, ?, 'manual', ?, ?)", type, value, `user:${s.id}`, ts),
    ctx.stmt(type === 'email' ? "UPDATE contacts SET status = 'suppressed', updated_at = ? WHERE normalized_value = ?" : "UPDATE contacts SET status = 'suppressed', updated_at = ? WHERE normalized_value LIKE '%@' || ?", ts, value),
    auditStmt(ctx, s.id, 'suppression_added', 'suppression', value),
  ]);
  return json({ ok: true });
});

// ---------- configurações ----------

r.add('GET', '/api/settings', async (ctx) => {
  const settings = await getSettings(ctx);
  const integ = await getIntegration(ctx);
  return json({
    settings: { ...settings, engine_lock: undefined, seed_version: undefined },
    google: integ ? { status: integ.status, account_email: integ.account_email, verified_at: integ.verified_at, last_error: integ.last_error, connected_at: integ.connected_at, scopes: integ.scopes } : { status: 'disconnected' },
    env: { app_url: ctx.env.APP_URL || null, google_client: !!ctx.env.GOOGLE_CLIENT_ID, encryption: !!ctx.env.ENCRYPTION_KEY, pagespeed_key: !!ctx.env.PSI_API_KEY },
  });
});

function parseDayList(val) {
  const arr = (Array.isArray(val) ? val : String(val ?? '').split(',')).map((x) => Number(String(x).trim())).filter((x) => Number.isInteger(x));
  const out = [...new Set(arr)].sort((a, b) => a - b);
  if (!out.length || out.length > 4 || out.some((d) => d < 1 || d > 45)) throw new HttpError(400, 'Dias da sequência: de 1 a 4 números entre 1 e 45, ex.: 4, 12');
  return out;
}

const SETTINGS_VALIDATORS = {
  timezone: (b) => { const tz = v.str(b, { name: 'Fuso', max: 60, required: true }); try { new Intl.DateTimeFormat('pt-BR', { timeZone: tz }); } catch { throw new HttpError(400, 'Fuso horário inválido'); } return tz; },
  sender: (b) => ({
    name: v.str(b.name, { name: 'Nome', max: 80 }), company: v.str(b.company, { name: 'Empresa', max: 80 }), email: v.email(b.email, 'E-mail'),
    website: v.str(b.website, { name: 'Site', max: 200 }), phone: v.str(b.phone, { name: 'Telefone', max: 40 }), city: v.str(b.city, { name: 'Cidade', max: 80 }), signature: v.str(b.signature, { max: 400 }),
    instagram: v.str(b.instagram, { name: 'Instagram', max: 80 }).replace(/^@/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/\/.*$/, '').slice(0, 30),
  }),
  services: (b) => Object.fromEntries(Object.keys(SERVICES).map((k) => [k, b[k] !== false])),
  outreach: (b, cur) => ({
    ...cur, // modo e aprovação só mudam pelas rotas próprias
    daily_limit: v.int(b.daily_limit, { name: 'Limite diário', min: 1, max: 200 }),
    per_segment_daily_limit: v.int(b.per_segment_daily_limit, { name: 'Limite por segmento', min: 1, max: 200 }),
    min_minutes_between: v.int(b.min_minutes_between, { name: 'Intervalo', min: 2, max: 240 }),
    days: v.days(b.days), start: v.hm(b.start, 'Início do envio'), end: v.hm(b.end, 'Fim do envio'),
    email_followup_days: parseDayList(b.email_followup_days),
    lost_after_days: v.int(b.lost_after_days, { name: 'Dias até perdido', min: 1, max: 60, def: 7 }),
    allow_named_contacts: v.bool(b.allow_named_contacts),
    min_score: v.int(b.min_score, { name: 'Pontuação mínima', min: 40, max: 100 }),
  }),
  closer: (b) => ({ auto_reply_meeting: v.bool(b.auto_reply_meeting), auto_reply_positive: v.bool(b.auto_reply_positive), auto_reply_info: v.bool(b.auto_reply_info) }),
  availability: (b) => ({
    days: v.days(b.days), start: v.hm(b.start, 'Início'), end: v.hm(b.end, 'Fim'),
    duration_minutes: v.int(b.duration_minutes, { name: 'Duração', min: 15, max: 180 }), buffer_minutes: v.int(b.buffer_minutes, { name: 'Intervalo', min: 0, max: 120 }),
    min_notice_hours: v.int(b.min_notice_hours, { name: 'Antecedência', min: 0, max: 336 }), horizon_days: v.int(b.horizon_days, { name: 'Horizonte', min: 1, max: 60 }),
    calendar_id: v.str(b.calendar_id, { name: 'Agenda', max: 200 }) || 'primary', create_meet_link: v.bool(b.create_meet_link),
  }),
  limits: (b) => Object.fromEntries(Object.entries(DEFAULT_SETTINGS.limits).map(([k, def]) => [k, v.int(b[k], { name: k, min: 0, max: k.startsWith('d1_rows_read') ? 5_000_000 : k.startsWith('d1_rows_written') ? 100_000 : k.startsWith('worker') ? 100_000 : 100_000, def })])),
  investigator: (b) => ({ use_pagespeed: v.bool(b.use_pagespeed), max_page_kb: v.int(b.max_page_kb, { name: 'Tamanho máx.', min: 50, max: 2000 }), cnpj_lookup: v.bool(b.cnpj_lookup) }),
  notifications: (b) => ({ email_admin: v.bool(b.email_admin) }),
  planner: (b, cur) => ({
    ...cur,
    max_cards: v.int(b.max_cards, { name: 'Cartões por dia', min: 3, max: 40 }),
    new_manual_per_day: v.int(b.new_manual_per_day, { name: 'Novos contatos manuais por dia', min: 0, max: 30 }),
    digest_email: v.bool(b.digest_email),
  }),
};

r.add('PUT', '/api/settings/:key', async (ctx, req, p, s) => {
  const key = v.oneOf(p.key, Object.keys(SETTINGS_VALIDATORS), 'configuração');
  const b = await readJson(req);
  const settings = await getSettings(ctx);
  const val = SETTINGS_VALIDATORS[key](key === 'timezone' ? b.value : b, settings[key]);
  if (key === 'outreach' && val.end <= val.start) throw new HttpError(400, 'O fim do envio precisa ser depois do início.');
  if (key === 'availability' && val.end <= val.start) throw new HttpError(400, 'O fim do expediente precisa ser depois do início.');
  await setSetting(ctx, key, val);
  await auditStmt(ctx, s.id, 'settings_updated', 'settings', key, val).run();
  return json({ ok: true, value: val });
});

r.add('POST', '/api/outreach/approve-live', async (ctx, req, p, s) => {
  const b = await readJson(req);
  if (b.confirm !== 'ATIVAR') throw new HttpError(400, 'Digite ATIVAR para confirmar.');
  const settings = await getSettings(ctx);
  const problems = [];
  if (validateSender(settings.sender).length) problems.push('preencha nome e e-mail do remetente');
  const integ = await getIntegration(ctx);
  if (!integ || integ.status !== 'connected') problems.push('conecte o Google');
  else if (!integ.verified_at) problems.push('teste a conexão Google (botão "Testar conexão")');
  else if (settings.sender.email && integ.account_email && settings.sender.email.toLowerCase() !== integ.account_email.toLowerCase()) problems.push(`o e-mail do remetente (${settings.sender.email}) deve ser o da conta Google conectada (${integ.account_email})`);
  const sim = await ctx.first("SELECT COUNT(*) AS n FROM messages WHERE status = 'simulated' AND kind = 'initial'");
  if (!sim.n) problems.push('rode ao menos uma prospecção em modo simulação e revise as mensagens');
  if (problems.length) throw new HttpError(400, `Antes de ativar: ${problems.join('; ')}.`);
  await setSetting(ctx, 'outreach', { ...settings.outreach, mode: 'live', live_approved_at: nowIso(), live_approved_by: s.email });
  await auditStmt(ctx, s.id, 'outreach_live_approved', 'settings', 'outreach').run();
  ctx.log('alert', 'outreach', `Envio real ATIVADO por ${s.email}`);
  return json({ ok: true });
});

r.add('POST', '/api/outreach/simulation', async (ctx, req, p, s) => {
  const settings = await getSettings(ctx);
  await setSetting(ctx, 'outreach', { ...settings.outreach, mode: 'simulation' });
  await auditStmt(ctx, s.id, 'outreach_back_to_simulation', 'settings', 'outreach').run();
  return json({ ok: true });
});

r.add('POST', '/api/google/connect', async (ctx, req, p, s) => json({ url: await startOAuth(ctx, s.id) }));

r.add('POST', '/api/google/disconnect', async (ctx, req, p, s) => {
  await disconnectGoogle(ctx);
  await auditStmt(ctx, s.id, 'google_disconnected').run();
  return json({ ok: true });
});

r.add('POST', '/api/google/test', async (ctx, req, p, s) => {
  const settings = await getSettings(ctx);
  const result = { gmail: null, calendar: null };
  try {
    const prof = await gmailProfile(ctx);
    result.gmail = { ok: true, email: prof.emailAddress, messages_total: prof.messagesTotal };
  } catch (e) { result.gmail = { ok: false, error: e.message }; }
  try {
    const busy = await freeBusy(ctx, settings.availability.calendar_id || 'primary', new Date().toISOString(), new Date(Date.now() + 7 * 86_400_000).toISOString(), settings.timezone);
    result.calendar = { ok: true, busy_blocks_next_7_days: busy.length };
  } catch (e) { result.calendar = { ok: false, error: e.message }; }
  const ok = result.gmail.ok && result.calendar.ok;
  await ctx.run("UPDATE integrations SET verified_at = ?, last_error = ?, updated_at = ? WHERE provider = 'google'", ok ? nowIso() : null, ok ? null : truncate(JSON.stringify(result), 500), nowIso());
  await auditStmt(ctx, s.id, 'google_tested', 'integration', 'google', result).run();
  return json({ ok, ...result });
});

r.add('POST', '/api/google/test-email', async (ctx, req, p, s) => {
  const settings = await getSettings(ctx);
  const integ = await getIntegration(ctx);
  if (!integ?.account_email) throw new HttpError(400, 'Conecte o Google primeiro.');
  const to = integ.account_email;
  const sent = await gmailSend(ctx, buildMime({ from: integ.account_email, fromName: settings.sender.name || 'Aureon', to, subject: 'Aureon: e-mail de teste', text: `Teste de envio pelo Gmail API em ${new Date().toLocaleString('pt-BR', { timeZone: settings.timezone })}.\nSe chegou, o envio está funcionando. Responda este e-mail para testar a leitura (ela só registra respostas de conversas de prospecção).` }));
  await auditStmt(ctx, s.id, 'google_test_email', 'integration', 'google', { to }).run();
  return json({ ok: true, to, gmail_id: sent.id });
});

// ---------- uso, logs, backup ----------

r.add('GET', '/api/usage', async (ctx, req) => {
  const days = v.int(new URL(req.url).searchParams.get('days'), { min: 1, max: 31, def: 7 });
  const since = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const rows = await ctx.all('SELECT day, metric, count FROM usage_metrics WHERE day >= ? ORDER BY day', since);
  const settings = await getSettings(ctx);
  const paused = await ctx.all('SELECT task, label, paused_until, paused_reason FROM schedules WHERE paused_until > ?', nowIso());
  return json({ rows, limits: settings.limits, paused, today: nowIso().slice(0, 10) });
});

r.add('GET', '/api/logs', async (ctx, req) => {
  const u = new URL(req.url).searchParams;
  const level = u.get('level');
  const rows = await ctx.all(`SELECT * FROM automation_logs ${level ? 'WHERE level = ?' : ''} ORDER BY id DESC LIMIT 200`, ...(level ? [level] : []));
  return json({ items: rows });
});

r.add('GET', '/api/audit', async (ctx) => json({ items: await ctx.all('SELECT a.*, u.email FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 200') }));

r.add('GET', '/api/export', async (ctx, req, p, s) => {
  const tables = ['companies', 'contacts', 'contact_sources', 'leads', 'lead_stage_history', 'lead_scores', 'conversations', 'messages', 'appointments', 'schedules', 'suppression_list', 'exclusion_rules', 'settings', 'campaigns'];
  const results = await ctx.batch(tables.map((t) => ctx.stmt(`SELECT * FROM ${t} ORDER BY rowid DESC LIMIT 5000`)));
  const out = { exported_at: nowIso(), note: 'Backup parcial (até 5000 linhas por tabela). Tokens e senhas não são incluídos.' };
  tables.forEach((t, i) => { out[t] = results[i].results.map((row) => (t === 'appointments' ? { ...row, token_hash: undefined } : row)); });
  out.settings = out.settings.filter((x) => x.key !== 'engine_lock');
  await auditStmt(ctx, s.id, 'export').run();
  return json(out, 200, { 'content-disposition': `attachment; filename="aureon-backup-${nowIso().slice(0, 10)}.json"` });
});

registerToday(r, { sendReply });

export const router = r;
