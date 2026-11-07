// Acesso ao D1 com contagem de consultas e linhas (o plano gratuito limita 50 consultas por
// execução e 5M linhas lidas / 100k gravadas por dia). Logs e métricas ficam em memória e são
// gravados num único batch no fim da execução.

import { nowIso, safeJson, truncate } from './util.js';
import { DEFAULT_SETTINGS } from './defaults.js';

export const QUERY_BUDGET = 45; // margem abaixo do limite de 50 do plano gratuito

export function createContext(env, { now = new Date(), fetchFn, actor = 'system', ip = null } = {}) {
  const stats = { queries: 0, rows_read: 0, rows_written: 0 };
  const logs = [];
  const metrics = new Map();
  const D = env.DB;

  const track = (r) => {
    stats.queries++;
    if (r?.meta) {
      stats.rows_read += r.meta.rows_read || 0;
      stats.rows_written += r.meta.rows_written || 0;
    }
    return r;
  };

  const ctx = {
    env, now, stats, actor, ip,
    fetch: fetchFn || ((...a) => fetch(...a)),
    _settings: null,

    stmt: (sql, ...params) => D.prepare(sql).bind(...params),
    async all(sql, ...params) { return track(await D.prepare(sql).bind(...params).all()).results; },
    async first(sql, ...params) { return (await ctx.all(sql, ...params))[0] ?? null; },
    async run(sql, ...params) { return track(await D.prepare(sql).bind(...params).run()).meta; },
    async batch(stmts) {
      if (!stmts.length) return [];
      stats.queries++; // um batch conta como uma consulta no limite por execução
      const rs = await D.batch(stmts);
      for (const r of rs) {
        stats.rows_read += r?.meta?.rows_read || 0;
        stats.rows_written += r?.meta?.rows_written || 0;
      }
      return rs;
    },
    budgetLeft() { return QUERY_BUDGET - stats.queries; },

    log(level, agent, message, data = null, jobId = null) {
      logs.push({ level, agent, message: truncate(message, 1000), data: data == null ? null : truncate(JSON.stringify(data), 4000), jobId });
    },
    metric(name, n = 1) { metrics.set(name, (metrics.get(name) || 0) + n); },
    pendingMetric(name) { return metrics.get(name) || 0; },

    async flush() {
      const ts = nowIso();
      const day = ts.slice(0, 10);
      const stmts = logs.splice(0).map((l) => D.prepare(
        'INSERT INTO automation_logs (level, agent, job_id, message, data, created_at) VALUES (?,?,?,?,?,?)',
      ).bind(l.level, l.agent, l.jobId, l.message, l.data, ts));
      // as próprias contagens de D1 também viram métrica
      ctx.metric('d1_queries', stats.queries + 1);
      ctx.metric('d1_rows_read', stats.rows_read);
      ctx.metric('d1_rows_written', stats.rows_written + stmts.length + metrics.size);
      for (const [name, n] of metrics) {
        if (!n) continue;
        stmts.push(D.prepare(
          'INSERT INTO usage_metrics (day, metric, count) VALUES (?,?,?) ON CONFLICT(day, metric) DO UPDATE SET count = count + excluded.count',
        ).bind(day, name, n));
      }
      metrics.clear();
      stats.queries = 0; stats.rows_read = 0; stats.rows_written = 0;
      if (stmts.length) await D.batch(stmts);
    },
  };
  return ctx;
}

// ---------- Configurações ----------

export async function getSettings(ctx, force = false) {
  if (ctx._settings && !force) return ctx._settings;
  const rows = await ctx.all('SELECT key, value FROM settings');
  const saved = Object.fromEntries(rows.map((r) => [r.key, safeJson(r.value)]));
  const merged = {};
  for (const [k, def] of Object.entries(DEFAULT_SETTINGS)) {
    const v = saved[k];
    merged[k] = (def && typeof def === 'object' && !Array.isArray(def) && v && typeof v === 'object' && !Array.isArray(v))
      ? { ...def, ...v }
      : (v === undefined || v === null ? def : v);
  }
  for (const [k, v] of Object.entries(saved)) if (!(k in merged)) merged[k] = v;
  ctx._settings = merged;
  return merged;
}

export function settingStmt(ctx, key, value) {
  return ctx.stmt(
    'INSERT INTO settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    key, JSON.stringify(value), nowIso(),
  );
}

export async function setSetting(ctx, key, value) {
  await settingStmt(ctx, key, value).run();
  ctx.stats.queries++;
  ctx._settings = null;
}

// ---------- Auditoria e histórico ----------

export function auditStmt(ctx, userId, action, entity = null, entityId = null, data = null) {
  return ctx.stmt(
    'INSERT INTO audit_log (user_id, action, entity, entity_id, data, ip, created_at) VALUES (?,?,?,?,?,?,?)',
    userId, action, entity, entityId == null ? null : String(entityId), data == null ? null : truncate(JSON.stringify(data), 4000), ctx.ip, nowIso(),
  );
}

/** Statements para mudar a etapa do lead e registrar o histórico. */
export function stageStmts(ctx, lead, toStage, reason, actor = ctx.actor, extra = {}) {
  const ts = nowIso();
  const sets = ['stage = ?', 'updated_at = ?'];
  const vals = [toStage, ts];
  for (const [k, v] of Object.entries(extra)) { sets.push(`${k} = ?`); vals.push(v); }
  const out = [ctx.stmt(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`, ...vals, lead.id)];
  if (lead.stage !== toStage) {
    out.push(ctx.stmt(
      'INSERT INTO lead_stage_history (lead_id, from_stage, to_stage, reason, actor, created_at) VALUES (?,?,?,?,?,?)',
      lead.id, lead.stage ?? null, toStage, truncate(reason, 500), actor, ts,
    ));
  }
  return out;
}

export async function usageToday(ctx, metric) {
  const r = await ctx.first('SELECT count FROM usage_metrics WHERE day = ? AND metric = ?', nowIso(ctx.now).slice(0, 10), metric);
  return (r?.count || 0) + ctx.pendingMetric(metric);
}
