// Agendador central. Um único Cron Trigger ("* * * * *") chama tick(); a rotina mora na tabela
// schedules e é editável pelo painel. Cada tick faz pouco trabalho, grava o progresso e sai.
// Fila persistente = automation_jobs (com retentativas, backoff, deduplicação e recuperação).

import { nowIso, inWindow, localDate, localMinutes, randomToken, safeJson, truncate, addMinutes } from './util.js';
import { getSettings, setSetting, usageToday, settingStmt } from './db.js';
import { DEFAULT_SCHEDULES, SEED_VERSION } from './defaults.js';
import { seedExclusionRules } from './exclusion.js';
import { runDiscover, validateDiscoverRequest } from './agents/finder.js';
import { runInvestigate } from './agents/investigator.js';
import { runScore } from './agents/scorer.js';
import { runPrepare } from './agents/copywriter.js';
import { runOutreach, runFollowup } from './agents/outreach.js';
import { runInbox } from './agents/inbox.js';
import { runPlan } from './agents/planner.js';
import { runReminders } from './agents/scheduler.js';
import { GoogleNotConnected, buildMime, gmailSend } from './google.js';

export const TASK_AGENT = {
  discover: 'finder', investigate: 'investigator', score: 'scorer', prepare: 'copywriter',
  outreach: 'outreach', inbox: 'inbox', followup: 'followup', report: 'report',
  plan: 'planner', reminders: 'scheduler',
};
// pausado: ler respostas (descadastros), lembrar reuniões já marcadas, montar a lista manual e relatório continuam
const RUN_WHEN_PAUSED = new Set(['inbox', 'report', 'plan', 'reminders']);
const MAX_JOBS_PER_TICK = 3;
const STALE_JOB_MINUTES = 10;
const STALE_RESEARCH_MINUTES = 15;

export async function ensureSeeded(ctx) {
  const row = await ctx.first("SELECT value FROM settings WHERE key = 'seed_version'");
  if (row && +safeJson(row.value) >= SEED_VERSION) return false;
  await seedExclusionRules(ctx);
  const ts = nowIso();
  await ctx.batch(DEFAULT_SCHEDULES.map((s) => ctx.stmt(
    `INSERT OR IGNORE INTO schedules (task, label, enabled, days, start_time, end_time, interval_minutes, batch_size, updated_at)
     VALUES (?,?,1,?,?,?,?,?,?)`, s.task, s.label, s.days || '1,2,3,4,5', s.start_time, s.end_time, s.interval_minutes, s.batch_size, ts,
  )));
  await ctx.run("INSERT OR IGNORE INTO campaigns (id, name, status, created_at, updated_at) VALUES (1, 'Prospecção principal', 'active', ?, ?)", ts, ts);
  return true;
}

async function acquireLock(ctx, minutes = 5) {
  const id = randomToken(8);
  const until = addMinutes(new Date(), minutes).toISOString();
  const r = await ctx.run(
    `INSERT INTO settings (key, value, updated_at) VALUES ('engine_lock', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
     WHERE json_extract(settings.value, '$.until') < ?`,
    JSON.stringify({ id, until }), nowIso(), nowIso(),
  );
  return r.changes ? id : null;
}
async function releaseLock(ctx, id) {
  await ctx.run("UPDATE settings SET value = ? WHERE key = 'engine_lock' AND json_extract(value, '$.id') = ?", JSON.stringify({ id: null, until: '1970-01-01T00:00:00.000Z' }), id);
}

const nextUtcMidnight = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();

/** Recupera tarefas interrompidas (worker encerrado no meio). */
export async function recoverStale(ctx) {
  const jobCut = addMinutes(ctx.now, -STALE_JOB_MINUTES).toISOString();
  const resCut = addMinutes(ctx.now, -STALE_RESEARCH_MINUTES).toISOString();
  const ts = nowIso();
  const rs = await ctx.batch([
    ctx.stmt(`UPDATE automation_jobs SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
              last_error = COALESCE(last_error, '') || ' [recuperado: execução interrompida]', locked_at = NULL, lock_id = NULL, updated_at = ?
              WHERE status = 'running' AND locked_at < ?`, ts, jobCut),
    ctx.stmt(`UPDATE companies SET research_status = CASE WHEN research_attempts >= 3 THEN 'failed' ELSE 'pending' END, updated_at = ?
              WHERE research_status = 'investigating' AND updated_at < ?`, ts, resCut),
    ctx.stmt(`UPDATE messages SET status = 'draft', error = 'recuperado: envio interrompido — conferir no Gmail antes de reenviar', updated_at = ?
              WHERE status = 'sending' AND kind = 'initial' AND updated_at < ? AND gmail_message_id IS NULL`, ts, jobCut),
  ]);
  const n = rs.reduce((s, r) => s + (r.meta?.changes || 0), 0);
  if (n) ctx.log('warn', 'engine', `${n} tarefa(s) interrompida(s) recuperada(s)`);
  return n;
}

/** Decide quais tarefas da rotina vencem agora e cria os jobs (com dedupe). */
export async function enqueueDue(ctx, settings) {
  const schedules = await ctx.all('SELECT * FROM schedules');
  const tz = settings.timezone;
  const today = localDate(ctx.now, tz);
  const hm = localMinutes(ctx.now, tz);
  const stmts = [];
  const due = [];
  for (const s of schedules) {
    if (!s.enabled) continue;
    if (s.paused_until && s.paused_until > nowIso(ctx.now)) continue;
    const agent = TASK_AGENT[s.task];
    if (agent && settings.agents[agent] === false) continue;
    if (settings.system.paused && !RUN_WHEN_PAUSED.has(s.task)) continue;
    if (!inWindow(ctx.now, tz, s.days, s.start_time, s.end_time || '23:59')) continue;
    const isDue = s.interval_minutes > 0
      ? (!s.last_run_at || (ctx.now - new Date(s.last_run_at)) >= s.interval_minutes * 60_000 - 15_000)
      : s.last_run_date !== today; // diária: se o horário passou sem rodar, roda no próximo tick (recuperação)
    if (!isDue) continue;
    const slot = s.interval_minutes > 0 ? Math.floor(hm / s.interval_minutes) : 0;
    stmts.push(ctx.stmt(
      `INSERT OR IGNORE INTO automation_jobs (type, payload, status, priority, run_after, dedupe_key, created_at, updated_at)
       VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)`,
      s.task, JSON.stringify({ batch: s.batch_size, scheduled: true }), s.task === 'inbox' ? 3 : 5, nowIso(ctx.now), `${s.task}:${today}:${slot}`, nowIso(), nowIso(),
    ));
    stmts.push(ctx.stmt('UPDATE schedules SET last_run_at = ?, last_run_date = ? WHERE task = ?', nowIso(ctx.now), today, s.task));
    due.push(s.task);
  }
  if (stmts.length) await ctx.batch(stmts);
  return due;
}

async function runDiscoverTargets(ctx, settings) {
  const targets = settings.finder.targets || [];
  if (!targets.length) return { note: 'Nenhum alvo de descoberta cadastrado (Automação → Alvos).' };
  const results = [];
  let cursor = +settings.finder.target_cursor || 0;
  const n = Math.min(targets.length, Math.max(1, +settings.finder.jobs_per_run || 1));
  for (let i = 0; i < n; i++) {
    const t = targets[cursor % targets.length];
    cursor++;
    results.push(await runDiscover(ctx, t));
  }
  await setSetting(ctx, 'finder', { ...settings.finder, target_cursor: cursor % targets.length });
  return { targets: results };
}

async function runReport(ctx, settings) {
  const ts = nowIso();
  const old = (days) => addMinutes(ctx.now, -days * 1440).toISOString();
  await ctx.batch([
    ctx.stmt('DELETE FROM sessions WHERE expires_at < ?', ts),
    ctx.stmt('DELETE FROM oauth_states WHERE expires_at < ?', ts),
    ctx.stmt('DELETE FROM rate_limits WHERE window_start < ?', old(2)),
    ctx.stmt("DELETE FROM automation_logs WHERE created_at < ? AND level IN ('debug','info')", old(60)),
    ctx.stmt("DELETE FROM automation_jobs WHERE status IN ('done','cancelled') AND updated_at < ?", old(30)),
  ]);
  const alerts = await ctx.all("SELECT id, agent, message, created_at FROM automation_logs WHERE level IN ('alert','error') AND seen = 0 AND created_at >= ? ORDER BY id DESC LIMIT 20", old(1));
  let mailed = false;
  if (alerts.length && settings.notifications.email_admin && settings.sender.email) {
    try {
      const text = `Resumo de alertas das últimas 24h (${alerts.length}):\n\n${alerts.map((a) => `• [${a.agent}] ${a.message}`).join('\n')}\n\nAbra o painel para revisar: ${ctx.env.APP_URL || ''}`;
      await gmailSend(ctx, buildMime({ from: settings.sender.email, fromName: 'Aureon', to: settings.sender.email, subject: `Aureon: ${alerts.length} alerta(s) para revisar`, text }));
      mailed = true;
    } catch (e) { if (!(e instanceof GoogleNotConnected)) ctx.log('warn', 'report', `Não consegui enviar o resumo por e-mail: ${e.message}`); }
  }
  ctx.log('info', 'report', `Relatório diário: limpeza feita, ${alerts.length} alerta(s)${mailed ? ' enviados por e-mail' : ''}`);
  return { alerts: alerts.length, mailed };
}

export async function runJob(ctx, job, settings) {
  const p = safeJson(job.payload, {});
  const batch = Math.max(1, Math.min(50, +p.batch || 1));
  switch (job.type) {
    case 'discover': return p.request ? runDiscover(ctx, validateDiscoverRequest(p.request)) : runDiscoverTargets(ctx, settings);
    case 'investigate': return runInvestigate(ctx, Math.min(batch, 5));
    case 'score': return runScore(ctx, batch);
    case 'prepare': return runPrepare(ctx, batch);
    case 'outreach': return runOutreach(ctx, Math.min(batch, 3));
    case 'followup': return runFollowup(ctx, Math.min(batch, 3));
    case 'inbox': return runInbox(ctx, Math.min(batch, 15));
    case 'report': return runReport(ctx, settings);
    case 'plan': return runPlan(ctx);
    case 'reminders': return runReminders(ctx);
    default: throw new Error(`Tipo de tarefa desconhecido: ${job.type}`);
  }
}

async function claimJob(ctx) {
  const lockId = randomToken(8);
  const rows = await ctx.all(
    `UPDATE automation_jobs SET status = 'running', lock_id = ?, locked_at = ?, attempts = attempts + 1, updated_at = ?
     WHERE id = (SELECT id FROM automation_jobs WHERE status = 'pending' AND run_after <= ? ORDER BY priority, id LIMIT 1) AND status = 'pending'
     RETURNING *`, lockId, nowIso(), nowIso(), nowIso(),
  );
  return rows[0] || null;
}

async function finishJob(ctx, job, settings, error, result) {
  const ts = nowIso();
  if (!error) {
    await ctx.batch([
      ctx.stmt("UPDATE automation_jobs SET status = 'done', result = ?, last_error = NULL, finished_at = ?, updated_at = ?, lock_id = NULL WHERE id = ?", truncate(JSON.stringify(result ?? {}), 2000), ts, ts, job.id),
      ctx.stmt('UPDATE schedules SET last_status = ? WHERE task = ?', 'ok', job.type),
    ]);
    return;
  }
  const msg = truncate(error.message || String(error), 500);
  if (error.limitReached) {
    // limite atingido: pausa só a tarefa afetada até a cota zerar (00:00 UTC), salva o estado e avisa
    const until = nextUtcMidnight(ctx.now);
    await ctx.batch([
      ctx.stmt("UPDATE automation_jobs SET status = 'failed', last_error = ?, finished_at = ?, updated_at = ?, lock_id = NULL WHERE id = ?", msg, ts, ts, job.id),
      ctx.stmt('UPDATE schedules SET paused_until = ?, paused_reason = ?, last_status = ? WHERE task = ?', until, msg, 'limite', job.type),
    ]);
    ctx.log('alert', 'engine', `Tarefa "${job.type}" pausada até ${until.slice(0, 16).replace('T', ' ')} UTC: ${msg}`, null, job.id);
    return;
  }
  const permanent = error instanceof GoogleNotConnected || error.configMissing || error.status === 400 || error.status === 403;
  const dead = permanent || job.attempts >= job.max_attempts;
  const retryIn = error.retryAfterMinutes || Math.min(240, 2 ** job.attempts * 2);
  await ctx.batch([
    ctx.stmt(`UPDATE automation_jobs SET status = ?, last_error = ?, run_after = ?, updated_at = ?, lock_id = NULL, finished_at = CASE WHEN ? THEN ? ELSE NULL END WHERE id = ?`,
      dead ? 'dead' : 'pending', msg, addMinutes(ctx.now, retryIn).toISOString(), ts, dead ? 1 : 0, ts, job.id),
    ctx.stmt('UPDATE schedules SET last_status = ? WHERE task = ?', dead ? 'erro' : 'tentando de novo', job.type),
  ]);
  ctx.metric('job_errors');
  ctx.log(dead ? (permanent ? 'warn' : 'alert') : 'error', TASK_AGENT[job.type] || 'engine', `${job.type}: ${msg}${dead ? '' : ` (nova tentativa em ${retryIn} min)`}`, null, job.id);
}

/** Verifica as cotas globais (D1/Workers) e, se perto do limite, pausa o trabalho pesado do dia. */
async function quotaGuard(ctx, settings) {
  const rows = await ctx.all("SELECT metric, count FROM usage_metrics WHERE day = ? AND metric IN ('d1_rows_written','d1_rows_read','worker_requests')", nowIso(ctx.now).slice(0, 10));
  const u = Object.fromEntries(rows.map((r) => [r.metric, r.count]));
  const L = settings.limits;
  if ((u.d1_rows_written || 0) >= L.d1_rows_written_daily) return `D1: ${u.d1_rows_written} linhas gravadas hoje (limite configurado ${L.d1_rows_written_daily})`;
  if ((u.d1_rows_read || 0) >= L.d1_rows_read_daily) return `D1: ${u.d1_rows_read} linhas lidas hoje (limite configurado ${L.d1_rows_read_daily})`;
  if ((u.worker_requests || 0) >= L.worker_requests_daily) return `Workers: ${u.worker_requests} requisições hoje (limite configurado ${L.worker_requests_daily})`;
  return null;
}

/** Um ciclo do agendador. `force` permite rodar um job manual mesmo com o lock de outro tick vencido. */
export async function tick(ctx, { maxJobs = MAX_JOBS_PER_TICK } = {}) {
  ctx.metric('cron_ticks');
  const summary = { ran: [], enqueued: [], skipped: null };
  await ensureSeeded(ctx);
  const lock = await acquireLock(ctx);
  if (!lock) { summary.skipped = 'outro ciclo em andamento'; await ctx.flush(); return summary; }
  try {
    const settings = await getSettings(ctx, true);
    if (settings.system.emergency_stop) { summary.skipped = 'pausa emergencial'; return summary; }
    await recoverStale(ctx);
    const quota = await quotaGuard(ctx, settings);
    if (quota) {
      summary.skipped = quota;
      const already = await ctx.first("SELECT id FROM automation_logs WHERE agent = 'engine' AND level = 'alert' AND message LIKE 'Cota%' AND created_at >= ?", nowIso(ctx.now).slice(0, 10));
      if (!already) ctx.log('alert', 'engine', `Cota diária perto do limite gratuito — tarefas pausadas até 00:00 UTC. ${quota}`);
      return summary;
    }
    summary.enqueued = await enqueueDue(ctx, settings);
    for (let i = 0; i < maxJobs && ctx.budgetLeft() > 12; i++) {
      const job = await claimJob(ctx);
      if (!job) break;
      const fresh = await getSettings(ctx, true);
      if (fresh.system.emergency_stop) { await ctx.run("UPDATE automation_jobs SET status = 'pending', lock_id = NULL, attempts = attempts - 1 WHERE id = ?", job.id); break; }
      let result, error;
      try { result = await runJob(ctx, job, fresh); } catch (e) { error = e; }
      await finishJob(ctx, job, fresh, error, result);
      summary.ran.push({ id: job.id, type: job.type, ok: !error, error: error?.message, result });
    }
    return summary;
  } finally {
    try { await releaseLock(ctx, lock); } catch { /* lock expira sozinho */ }
    await ctx.flush();
  }
}

/** Cria um job manual (botão "rodar agora" ou pedido de descoberta). */
export async function enqueueJob(ctx, type, payload = {}, { dedupeKey = null, priority = 4 } = {}) {
  if (!TASK_AGENT[type]) throw Object.assign(new Error('Tipo de tarefa inválido'), { status: 400 });
  const r = await ctx.run(
    `INSERT OR IGNORE INTO automation_jobs (type, payload, status, priority, run_after, dedupe_key, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)`,
    type, JSON.stringify(payload), priority, nowIso(), dedupeKey, nowIso(), nowIso(),
  );
  return r.changes ? r.last_row_id : null;
}

export { usageToday, settingStmt };
