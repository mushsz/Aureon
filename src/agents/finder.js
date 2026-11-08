// FINDER — descobre empresas em fontes abertas.
// Fonte principal: OpenStreetMap via Overpass API (dados ODbL, reutilização permitida com atribuição).
// Uso leve e identificado (User-Agent), uma consulta por vez, sem scraping de Google Maps.
// Fonte secundária: importação manual (lista colada pelo administrador).

import { normalize, nowIso, truncate } from '../util.js';
import { loadRules, checkExclusion, describeExclusion } from '../exclusion.js';
import { getSettings, usageToday } from '../db.js';
import { normalizePhone, instagramHandle } from '../channels.js';

// Segmentos → filtros de tags OSM. "auto" pega qualquer escritório/ofício e deriva o segmento da tag.
export const SEGMENTS = {
  construcao: { label: 'Construção civil', filters: ['["office"="construction_company"]', '["craft"="builder"]', '["office"]["name"~"construtora|incorporadora",i]', '["shop"="doityourself"]', '["shop"="hardware"]'] },
  arquitetura: { label: 'Arquitetura', filters: ['["office"="architect"]'] },
  engenharia: { label: 'Engenharia', filters: ['["office"="engineer"]', '["office"]["name"~"engenharia",i]'] },
  imobiliaria: { label: 'Imobiliárias', filters: ['["office"="estate_agent"]', '["shop"="estate_agent"]'] },
  concessionaria: { label: 'Concessionárias', filters: ['["shop"="car"]', '["shop"="motorcycle"]', '["shop"="truck"]'] },
  comercio: { label: 'Comércio', filters: ['["shop"]["shop"!~"chemist|medical_supply|optician|hearing_aids|beauty|cosmetics|hairdresser"]'] },
  industria: { label: 'Indústrias', filters: ['["man_made"="works"]["name"]', '["industrial"]["name"]', '["office"]["name"~"industria|indústria",i]'] },
  distribuidora: { label: 'Distribuidoras', filters: ['["shop"="wholesale"]', '["office"]["name"~"distribuidora",i]', '["shop"]["name"~"distribuidora",i]'] },
  advocacia: { label: 'Advocacia', filters: ['["office"="lawyer"]'] },
  contabilidade: { label: 'Contabilidade', filters: ['["office"="accountant"]', '["office"="tax_advisor"]'] },
  educacao: { label: 'Educação', filters: ['["amenity"="school"]', '["amenity"="college"]', '["amenity"="language_school"]', '["amenity"="driving_school"]', '["amenity"="music_school"]', '["office"="educational_institution"]'] },
  servicos: { label: 'Prestadores de serviços', filters: ['["craft"]', '["office"="company"]', '["office"="consulting"]'] },
  b2b: { label: 'Empresas B2B', filters: ['["office"="company"]', '["office"="consulting"]', '["office"="insurance"]', '["office"="financial"]', '["office"="coworking"]'] },
  logistica: { label: 'Logística', filters: ['["office"="logistics"]', '["office"="courier"]', '["office"="moving_company"]', '["office"]["name"~"transport|logistica|logística",i]'] },
  auto: { label: 'Descoberta automática', filters: ['["office"]["office"!~"^(religion|government|political_party|student_union|diplomatic|quango|parish|union|ngo)$"]', '["craft"]'] },
};

const SOCIAL_HOSTS = ['facebook.com', 'instagram.com', 'linktr.ee', 'wa.me', 'api.whatsapp.com', 'whatsapp.com', 'linkedin.com', 'twitter.com', 'x.com', 'youtube.com', 'tiktok.com', 'google.com', 'goo.gl', 'g.page', 'sites.google.com', 'bit.ly'];

const quote = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const regexEscape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Valida e normaliza o pedido de descoberta. Lança erro com mensagem amigável. */
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

export function validateDiscoverRequest(p) {
  const out = {
    country: String(p.country || 'BR').toUpperCase().slice(0, 2),
    state: String(p.state || '').toUpperCase().trim().slice(0, 3),
    city: String(p.city || '').trim().slice(0, 80),
    segment: String(p.segment || 'auto'),
    company_type: String(p.company_type || '').trim().slice(0, 40),
    keywords: (Array.isArray(p.keywords) ? p.keywords : String(p.keywords || '').split(','))
      .map((k) => String(k).trim()).filter(Boolean).slice(0, 8).map((k) => k.slice(0, 40)),
    max: Math.max(1, Math.min(200, parseInt(p.max, 10) || 30)),
    require_website: p.require_website !== false && p.require_website !== 'false',
  };
  if (!/^[A-Z]{2}$/.test(out.country)) throw bad('País inválido (use o código ISO, ex.: BR).');
  if (!SEGMENTS[out.segment]) throw bad('Segmento desconhecido.');
  if (out.country === 'BR' && !/^[A-Z]{2}$/.test(out.state)) throw bad('Informe a UF (ex.: SC). Buscar o Brasil inteiro sobrecarrega a fonte pública.');
  if (out.country !== 'BR' && !out.city) throw bad('Fora do Brasil, informe a cidade.');
  if (out.company_type && !/^[a-z_]+=[a-z_*]+$/i.test(out.company_type)) throw bad('Tipo de empresa deve ser uma tag OSM, ex.: office=lawyer.');
  return out;
}

export function buildOverpassQuery(req) {
  const lines = ['[out:json][timeout:90];'];
  if (req.country === 'BR') {
    lines.push(`area["ISO3166-2"="BR-${quote(req.state)}"]->.st;`);
    if (req.city) {
      lines.push(`rel(area.st)["boundary"="administrative"]["admin_level"="8"]["name"="${quote(req.city)}"];`);
      lines.push('map_to_area->.a;');
    } else {
      lines.push('(.st;)->.a;');
    }
  } else {
    lines.push(`area["ISO3166-1"="${quote(req.country)}"]->.c;`);
    lines.push(`rel(area.c)["boundary"="administrative"]["name"="${quote(req.city)}"];`);
    lines.push('map_to_area->.a;');
  }
  let filters = SEGMENTS[req.segment].filters;
  if (req.company_type) {
    const [k, v] = req.company_type.split('=');
    filters = [v === '*' ? `["${quote(k)}"]` : `["${quote(k)}"="${quote(v)}"]`];
  }
  const kw = req.keywords.length ? `["name"~"${quote(req.keywords.map(regexEscape).join('|'))}",i]` : '';
  // Uma varredura da área (só registros com canal publicado) e depois filtros sobre esse conjunto:
  // bem mais leve para o servidor público do que um filtro por segmento varrendo a área inteira.
  const contact = req.require_website ? ['["website"]', '["contact:website"]'] : ['["website"]', '["contact:website"]', '["email"]', '["contact:email"]'];
  lines.push(`(${contact.map((c) => `nwr(area.a)${c}["name"];`).join(' ')})->.w;`);
  lines.push('(');
  for (const f of filters) lines.push(`  nwr.w${f}${kw};`);
  lines.push(');');
  lines.push(`out tags center ${req.max};`);
  return lines.join('\n');
}

export function normalizeWebsite(raw) {
  if (!raw) return { website: null, domain: null, social: null };
  let s = String(raw).trim().split(/[\s;,]+/)[0];
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  let u;
  try { u = new URL(s); } catch { return { website: null, domain: null, social: null }; }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (!host.includes('.') || host.length > 253) return { website: null, domain: null, social: null };
  if (SOCIAL_HOSTS.some((h) => host === h || host.endsWith('.' + h))) return { website: null, domain: null, social: u.href };
  return { website: `${u.protocol}//${u.hostname.toLowerCase()}${u.pathname === '/' ? '/' : u.pathname}`, domain: host, social: null };
}

const SEGMENT_FROM_TAG = {
  'office=architect': 'arquitetura', 'office=engineer': 'engenharia', 'office=estate_agent': 'imobiliaria',
  'shop=estate_agent': 'imobiliaria', 'shop=car': 'concessionaria', 'shop=motorcycle': 'concessionaria',
  'shop=truck': 'concessionaria', 'office=lawyer': 'advocacia', 'office=accountant': 'contabilidade',
  'office=tax_advisor': 'contabilidade', 'office=construction_company': 'construcao', 'craft=builder': 'construcao',
  'office=logistics': 'logistica', 'office=courier': 'logistica', 'office=moving_company': 'logistica',
  'shop=wholesale': 'distribuidora', 'man_made=works': 'industria', 'amenity=school': 'educacao',
  'amenity=college': 'educacao', 'amenity=language_school': 'educacao', 'amenity=driving_school': 'educacao',
  'office=educational_institution': 'educacao',
};

function deriveSegment(tags, requested) {
  for (const k of ['office', 'shop', 'craft', 'amenity', 'man_made']) {
    if (tags[k]) {
      const key = `${k}=${tags[k]}`;
      if (SEGMENT_FROM_TAG[key]) return { segment: SEGMENT_FROM_TAG[key], type: key };
      if (requested !== 'auto') return { segment: requested, type: key };
      // descoberta automática: segmento novo nomeado pela própria tag (ex.: office=insurance → "insurance")
      return { segment: String(tags[k]).toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 40) || 'outros', type: key };
    }
  }
  return { segment: requested === 'auto' ? 'outros' : requested, type: null };
}

const KEEP_TAGS = ['office', 'shop', 'craft', 'amenity', 'healthcare', 'healthcare:speciality', 'man_made', 'industrial',
  'leisure', 'social_facility', 'emergency', 'brand', 'operator', 'description', 'opening_hours', 'contact:instagram', 'contact:whatsapp'];

export function parseOverpass(json, req) {
  const out = [];
  for (const el of json?.elements || []) {
    const t = el.tags || {};
    const name = String(t.name || '').trim();
    if (!name) continue;
    const site = normalizeWebsite(t.website || t['contact:website'] || t.url);
    const email = String(t.email || t['contact:email'] || '').trim().toLowerCase().split(/[;,\s]+/)[0] || null;
    const phone = String(t.phone || t['contact:phone'] || '').trim().split(';')[0] || null;
    const seg = deriveSegment(t, req.segment);
    const instagram = instagramHandle(t['contact:instagram'] || '') || instagramHandle(site.social || '');
    const whatsapp = normalizePhone(t['contact:whatsapp'] || t.whatsapp || '');
    const tags = {};
    for (const k of KEEP_TAGS) if (t[k]) tags[k] = truncate(t[k], 200);
    out.push({
      name: truncate(name, 200),
      segment: seg.segment,
      company_type: seg.type,
      country: req.country,
      state: req.country === 'BR' ? req.state : (t['addr:state'] || null),
      city: req.city || t['addr:city'] || null,
      website: site.website, domain: site.domain, social_url: site.social,
      email: email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null,
      phone: phone ? truncate(phone, 40) : null,
      instagram, whatsapp,
      source: 'osm',
      source_ref: `osm:${el.type}/${el.id}`,
      source_url: `https://www.openstreetmap.org/${el.type}/${el.id}`,
      tags,
    });
  }
  return out;
}

/**
 * Passa cada candidato pela exclusão e grava (sem duplicar) em companies + leads.
 * Um único batch para tudo. Retorna contagens.
 */
export async function saveCandidates(ctx, candidates, actor = 'finder') {
  const rules = await loadRules(ctx);
  const ts = nowIso();
  const stmts = [];
  const meta = [];
  const FIELDS = ['segment', 'company_type', 'country', 'state', 'city', 'website', 'domain', 'social_url', 'email', 'phone', 'instagram', 'whatsapp', 'source_url'];
  for (const c0 of candidates) {
    // campos ausentes viram NULL (o D1 não aceita undefined)
    const c = { ...c0 };
    for (const k of FIELDS) if (c[k] === undefined) c[k] = null;
    if (!c.country) c.country = 'BR';
    const ex = checkExclusion(rules, { ...c, text: '' });
    const exStatus = ex.verdict === 'block' ? 'block' : ex.verdict === 'review' ? 'review' : 'allow';
    stmts.push(ctx.stmt(
      `INSERT OR IGNORE INTO companies (name, normalized_name, segment, company_type, country, state, city, normalized_city,
        website, domain, social_url, email, phone, instagram, whatsapp, source, source_ref, source_url, source_tags,
        research_status, exclusion_status, exclusion_reason, exclusion_checked_at, discovered_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      c.name, normalize(c.name), c.segment, c.company_type, c.country, c.state, c.city, normalize(c.city),
      c.website, c.domain, c.social_url, c.email, c.phone, c.instagram || null, c.whatsapp || null, c.source, c.source_ref, c.source_url, JSON.stringify(c.tags || {}),
      exStatus === 'block' ? 'skipped' : 'pending', exStatus, describeExclusion(ex), ts, ts, ts, ts,
    ));
    meta.push({ c, exStatus });
    if (exStatus !== 'block') {
      stmts.push(ctx.stmt(
        `INSERT OR IGNORE INTO leads (company_id, stage, needs_review, created_at, updated_at)
         SELECT id, 'descoberto', ?, ?, ? FROM companies WHERE source_ref = ? AND created_at = ?`,
        exStatus === 'review' ? 1 : 0, ts, ts, c.source_ref, ts,
      ));
      stmts.push(ctx.stmt(
        `INSERT INTO lead_stage_history (lead_id, from_stage, to_stage, reason, actor, created_at)
         SELECT l.id, NULL, 'descoberto', ?, ?, ? FROM leads l JOIN companies co ON co.id = l.company_id
         WHERE co.source_ref = ? AND l.created_at = ? AND NOT EXISTS (SELECT 1 FROM lead_stage_history h WHERE h.lead_id = l.id)`,
        `Fonte: ${c.source}`, actor, ts, c.source_ref, ts,
      ));
    }
  }
  const results = await ctx.batch(stmts);
  const counts = { found: candidates.length, inserted: 0, duplicates: 0, blocked: 0, review: 0 };
  let i = 0;
  for (const m of meta) {
    const changed = results[i]?.meta?.changes || 0;
    i += m.exStatus === 'block' ? 1 : 3;
    if (!changed) { counts.duplicates++; continue; }
    counts.inserted++;
    if (m.exStatus === 'block') counts.blocked++;
    if (m.exStatus === 'review') counts.review++;
  }
  return counts;
}

/** Executa um pedido de descoberta (um job). */
export async function runDiscover(ctx, payload) {
  const settings = await getSettings(ctx);
  const req = validateDiscoverRequest(payload);
  const used = await usageToday(ctx, 'overpass_requests');
  if (used >= settings.limits.overpass_daily) {
    const e = new Error(`Limite diário de consultas à Overpass atingido (${used}/${settings.limits.overpass_daily}).`);
    e.limitReached = 'discover';
    throw e;
  }
  const query = buildOverpassQuery(req);
  ctx.metric('overpass_requests');
  ctx.metric('subrequests');
  const res = await ctx.fetch(settings.finder.overpass_url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': `AureonSalesEngine/1.0 (+${ctx.env.APP_URL || 'self-hosted'})`,
      accept: 'application/json',
    },
    body: 'data=' + encodeURIComponent(query),
    signal: AbortSignal.timeout(120_000),
  });
  if (res.status === 429 || res.status === 504) {
    const e = new Error(`Overpass ocupada (HTTP ${res.status}); nova tentativa mais tarde.`);
    e.retryAfterMinutes = 10;
    throw e;
  }
  if (!res.ok) throw new Error(`Overpass respondeu HTTP ${res.status}`);
  const json = await res.json();
  const candidates = parseOverpass(json, req);
  const counts = await saveCandidates(ctx, candidates);
  ctx.metric('companies_discovered', counts.inserted);
  ctx.log('info', 'finder', `Descoberta ${SEGMENTS[req.segment].label} em ${req.city || req.state}/${req.country}: ${counts.inserted} novas, ${counts.duplicates} repetidas, ${counts.blocked} bloqueadas, ${counts.review} para revisão.`, { req, counts });
  return counts;
}

/**
 * Importação manual. Cada linha: nome; site; cidade; UF; segmento; e-mail; telefone
 * (só o nome é obrigatório). Fonte registrada como "manual".
 */
export function parseManualImport(text, defaults = {}) {
  const rows = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 200);
  const out = [];
  for (const line of rows) {
    const [name, site, city, state, segment, email, phone] = line.split(/[;\t]/).map((s) => (s ?? '').trim());
    if (!name || name.length < 2) continue;
    const w = normalizeWebsite(site);
    const em = (email || '').toLowerCase();
    out.push({
      name: truncate(name, 200), segment: normalize(segment || defaults.segment || 'outros').replace(/ /g, '_') || 'outros', company_type: null,
      country: 'BR', state: (state || defaults.state || '').toUpperCase().slice(0, 2) || null, city: city || defaults.city || null,
      website: w.website, domain: w.domain, social_url: w.social,
      email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em) ? em : null, phone: phone ? truncate(phone, 40) : null,
      instagram: instagramHandle(w.social || '') || null, whatsapp: null,
      source: 'manual', source_ref: `manual:${normalize(name).replace(/ /g, '-')}:${normalize(city || '').replace(/ /g, '-')}`,
      source_url: null, tags: {},
    });
  }
  return out;
}
