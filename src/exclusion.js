// Verificação obrigatória de exclusão comercial (saúde e concorrentes da Arco).
// Resultado: { verdict: 'allow' | 'review' | 'block', reasons: [...] }.
// Em dúvida → 'review' (nunca prospecta automaticamente).

import { normalize, nowIso } from './util.js';
import { defaultExclusionRules, SEED_VERSION } from './defaults.js';

export async function loadRules(ctx) {
  if (ctx._rules) return ctx._rules;
  const rows = await ctx.all('SELECT type, value, reason FROM exclusion_rules WHERE active = 1');
  ctx._rules = compileRules(rows);
  return ctx._rules;
}

export function compileRules(rows) {
  const c = { keyword: [], review_keyword: [], category: [], review_category: [], cnae: [], review_cnae: [], domain: [], company: [] };
  for (const r of rows) {
    if (!c[r.type]) continue;
    if (r.type === 'keyword' || r.type === 'review_keyword' || r.type === 'company') {
      const raw = String(r.value).trim();
      const prefix = raw.endsWith('*');
      const norm = normalize(prefix ? raw.slice(0, -1) : raw);
      if (!norm) continue;
      const esc = norm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      c[r.type].push({ value: r.value, reason: r.reason, re: new RegExp(`(^| )${esc}${prefix ? '' : '( |$)'}`) , compact: norm.replace(/ /g, '') });
    } else if (r.type === 'category' || r.type === 'review_category') {
      const [k, v] = String(r.value).toLowerCase().split('=');
      c[r.type].push({ value: r.value, reason: r.reason, k: k?.trim(), v: (v ?? '*').trim() });
    } else if (r.type === 'cnae' || r.type === 'review_cnae') {
      c[r.type].push({ value: r.value, reason: r.reason, code: String(r.value).replace(/\D/g, '') });
    } else if (r.type === 'domain') {
      c.domain.push({ value: r.value, reason: r.reason, d: String(r.value).toLowerCase().replace(/^www\./, '').trim() });
    }
  }
  return c;
}

const domainOf = (s) => {
  if (!s) return null;
  s = String(s).toLowerCase().trim();
  if (s.includes('@')) s = s.split('@').pop();
  try { if (!s.includes('://')) s = 'http://' + s; return new URL(s).hostname.replace(/^www\./, ''); } catch { return null; }
};

/**
 * subject: { name, segment, company_type, website, domain, email, tags: {k:v}, text, cnaes: [] }
 * text = conteúdo do site (título, descrição, h1, trecho) quando já investigado.
 */
export function checkExclusion(rules, subject) {
  const reasons = [];
  const add = (level, rule, field) => reasons.push({ level, rule: rule.value, reason: rule.reason, field });

  const fields = {
    nome: subject.name, segmento: subject.segment, tipo: subject.company_type, site: subject.text,
  };
  const normFields = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, normalize(v)]));

  for (const [field, text] of Object.entries(normFields)) {
    if (!text) continue;
    // texto do site é ruidoso ("saúde e segurança do trabalho"): termo de saúde ali vira revisão, não bloqueio
    for (const rule of rules.keyword) if (rule.re.test(text)) add(field === 'site' ? 'review' : 'block', rule, field);
    // termos de dúvida (academia, salão, beleza…) só valem no nome/segmento: no texto do site de uma construtora
    // eles aparecem como "academia do condomínio" e "salão de festas"
    if (field !== 'site') for (const rule of rules.review_keyword) if (rule.re.test(text)) add('review', rule, field);
    for (const rule of rules.company) if (rule.re.test(text) && field !== 'site') add('block', rule, field);
  }

  // domínios (site e e-mail): regra de domínio e nome de concorrente no rótulo do domínio
  const doms = [subject.domain, domainOf(subject.website), domainOf(subject.email)].filter(Boolean);
  for (const d of new Set(doms)) {
    for (const rule of rules.domain) if (d === rule.d || d.endsWith('.' + rule.d)) add('block', rule, 'dominio');
    const label = d.split('.')[0].replace(/[^a-z0-9]/g, '');
    for (const rule of rules.company) if (rule.compact.length >= 5 && label.includes(rule.compact)) add('block', rule, 'dominio');
    const labelNorm = normalize(d.replace(/\.[a-z.]+$/, '').replace(/[-_.]/g, ' '));
    for (const rule of rules.keyword) if (rule.re.test(labelNorm)) add('block', rule, 'dominio');
  }

  // tags/categorias (OSM e afins)
  const tags = subject.tags || {};
  for (const [k0, v0] of Object.entries(tags)) {
    const k = String(k0).toLowerCase(); const v = String(v0).toLowerCase();
    for (const rule of rules.category) if (rule.k === k && (rule.v === '*' || rule.v === v)) add('block', rule, `tag ${k}=${v}`);
    for (const rule of rules.review_category) if (rule.k === k && (rule.v === '*' || rule.v === v)) add('review', rule, `tag ${k}=${v}`);
  }

  // CNAE
  for (const code0 of subject.cnaes || []) {
    const code = String(code0).replace(/\D/g, '');
    if (!code) continue;
    for (const rule of rules.cnae) if (code.startsWith(rule.code)) add('block', rule, `CNAE ${code}`);
    for (const rule of rules.review_cnae) if (code.startsWith(rule.code)) add('review', rule, `CNAE ${code}`);
  }

  const verdict = reasons.some((r) => r.level === 'block') ? 'block' : reasons.length ? 'review' : 'allow';
  return { verdict, reasons };
}

export function describeExclusion(result) {
  if (!result.reasons.length) return null;
  return result.reasons.slice(0, 4).map((r) => `${r.level === 'block' ? 'Bloqueado' : 'Revisar'}: "${r.rule}" em ${r.field}`).join('; ');
}

/** Monta o "subject" a partir de uma linha de companies (+ texto do site e tags). */
export function subjectFromCompany(company, extraText = '') {
  const tags = (() => { try { return JSON.parse(company.source_tags || '{}'); } catch { return {}; } })();
  const cnaes = [company.cnae_code, ...(JSON.parse(company.cnae_secondary || '[]'))].filter(Boolean);
  return {
    name: company.name, segment: company.segment, company_type: company.company_type,
    website: company.website, domain: company.domain, email: company.email, tags, cnaes, text: extraText,
  };
}

/** Grava as regras padrão (idempotente). Uma única chamada em batch. */
export async function seedExclusionRules(ctx) {
  const ts = nowIso();
  const stmts = defaultExclusionRules().map(([type, value, reason]) => ctx.stmt(
    'INSERT OR IGNORE INTO exclusion_rules (type, value, reason, is_system, active, created_at, updated_at) VALUES (?,?,?,1,1,?,?)',
    type, value, reason, ts, ts,
  ));
  stmts.push(ctx.stmt(
    "INSERT INTO settings (key, value, updated_at) VALUES ('seed_version', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    String(SEED_VERSION), ts,
  ));
  await ctx.batch(stmts);
  ctx._rules = null;
}

/** Verdade se o e-mail ou o domínio estão na lista de supressão (descadastro, recusa, bounce). */
export async function isSuppressed(ctx, email) {
  const e = String(email || '').toLowerCase().trim();
  const d = e.split('@')[1] || '';
  const row = await ctx.first(
    "SELECT reason FROM suppression_list WHERE (type = 'email' AND value = ?) OR (type = 'domain' AND value = ?) LIMIT 1", e, d,
  );
  return row ? row.reason : null;
}
