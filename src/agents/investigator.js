// INVESTIGATOR — visita a página inicial (respeitando robots.txt), observa sinais e transforma em
// achados com evidência. Três tipos: confirmed (observado), probable (indício), unknown (não dá para saber).
// Nunca inventa problema: todo achado aponta o que foi visto.

import { nowIso, truncate } from '../util.js';
import { getSettings, usageToday, stageStmts } from '../db.js';
import { loadRules, checkExclusion, describeExclusion, subjectFromCompany } from '../exclusion.js';

export const USER_AGENT = 'AureonSalesEngine/1.0 (analise de presenca digital; respeita robots.txt)';

const TOOL_PATTERNS = [
  // [nome, categoria, regex]
  ['Google Analytics', 'analytics', /google-analytics\.com|googletagmanager\.com\/gtag|gtag\(/i],
  ['Google Tag Manager', 'analytics', /googletagmanager\.com\/gtm\.js|GTM-[A-Z0-9]{4,}/],
  ['Meta Pixel', 'analytics', /connect\.facebook\.net\/[^"']*fbevents|fbq\(/i],
  ['Hotjar', 'analytics', /static\.hotjar\.com|hotjar/i],
  ['Microsoft Clarity', 'analytics', /clarity\.ms/i],
  ['RD Station', 'crm', /rdstation|d335luupugsy2\.cloudfront\.net/i],
  ['HubSpot', 'crm', /hs-scripts\.com|js\.hsforms\.net|hubspot/i],
  ['Pipedrive', 'crm', /pipedrive|leadbooster/i],
  ['Salesforce/Pardot', 'crm', /pardot|salesforce/i],
  ['Kommo', 'crm', /kommo|amocrm/i],
  ['Zoho', 'crm', /zoho\.com|salesiq/i],
  ['PipeRun', 'crm', /piperun/i],
  ['Ploomes', 'crm', /ploomes/i],
  ['ActiveCampaign', 'crm', /activecampaign|trackcmp\.net/i],
  ['Mailchimp', 'crm', /chimpstatic|list-manage\.com/i],
  ['Leadster', 'chat', /leadster/i],
  ['JivoChat', 'chat', /jivosite|jivochat/i],
  ['Tawk.to', 'chat', /tawk\.to/i],
  ['Zendesk', 'chat', /zdassets|zopim|zendesk/i],
  ['Intercom', 'chat', /intercom/i],
  ['Crisp', 'chat', /crisp\.chat/i],
  ['Octadesk', 'chat', /octadesk/i],
  ['Blip', 'chat', /blip\.ai|take\.net/i],
  ['Tidio', 'chat', /tidio/i],
  ['Botão de WhatsApp', 'chat', /joinchat|getbutton\.io|wa\.me\/|api\.whatsapp\.com/i],
  ['WordPress', 'platform', /wp-content|wp-includes/i],
  ['Wix', 'platform', /static\.parastorage\.com|wix\.com/i],
  ['Shopify', 'platform', /cdn\.shopify\.com/i],
  ['Nuvemshop', 'platform', /nuvemshop|tiendanube/i],
  ['Loja Integrada', 'platform', /lojaintegrada/i],
  ['VTEX', 'platform', /vtex/i],
  ['Webflow', 'platform', /webflow/i],
  ['Squarespace', 'platform', /squarespace/i],
];

const CTA_RE = /or[cç]amento|fale conosco|entre em contato|solicite|agende|agendar|comprar|simul[ae]|cota[cç][aã]o|pe[cç]a j[aá]|quero|contrate|saiba mais/i;
const EMAIL_RE = /[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,24}/gi;
const CNPJ_RE = /\b(\d{2})\.?(\d{3})\.?(\d{3})\/?(\d{4})-?(\d{2})\b/g;

export function isValidCnpj(c) {
  c = String(c).replace(/\D/g, '');
  if (c.length !== 14 || /^(\d)\1+$/.test(c)) return false;
  const calc = (len) => {
    const w = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const s = w.reduce((acc, wi, i) => acc + wi * +c[i], 0);
    const r = s % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === +c[12] && calc(13) === +c[13];
}

// ---------- robots.txt ----------

export function robotsAllows(robotsTxt, path = '/', ua = 'aureonsalesengine') {
  if (!robotsTxt) return true;
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of robotsTxt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === 'user-agent') {
      if (!lastWasAgent || !cur) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (cur && (field === 'allow' || field === 'disallow')) cur.rules.push({ allow: field === 'allow', path: value });
    }
  }
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && ua.includes(a)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes('*'));
  let best = null;
  for (const g of chosen) for (const r of g.rules) {
    if (!r.path) continue; // "Disallow:" vazio = tudo liberado
    const pattern = r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$');
    if (new RegExp('^' + pattern).test(path)) {
      if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
    }
  }
  return best ? best.allow : true;
}

// ---------- leitura da página ----------

async function readLimited(res, maxBytes) {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  try { await reader.cancel(); } catch { /* já terminou */ }
  const out = new Uint8Array(Math.min(total, maxBytes));
  let off = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, out.length - off);
    out.set(c.subarray(0, take), off);
    off += take;
    if (off >= out.length) break;
  }
  return out;
}

/** Extrai sinais do HTML com o HTMLRewriter nativo (streaming, barato em CPU). */
export async function extractSignals(htmlBytes, pageUrl) {
  const s = {
    lang: null, title: '', description: '', viewport: null, generator: null, og: false,
    h1: [], nav_count: 0, links_internal: 0, links_external: 0,
    tel_links: 0, mailto: [], whatsapp_links: 0, social: [],
    forms: 0, form_actions: [], email_inputs: 0, tel_inputs: 0, textareas: 0,
    images: 0, images_without_alt: 0, manifest: false, scripts: [], inline_script_sample: '', text: '',
  };
  let host = '';
  try { host = new URL(pageUrl).hostname.replace(/^www\./, ''); } catch { /* sem host */ }
  let inTitle = '';
  let curH1 = null;
  const textParts = [];
  let textLen = 0;
  const addText = (t) => { if (textLen < 30_000 && t) { textParts.push(t); textLen += t.length; } };

  const rw = new HTMLRewriter()
    .on('html', { element(e) { s.lang = e.getAttribute('lang'); } })
    .on('title', { text(t) { if (inTitle.length < 300) inTitle += t.text; } })
    .on('meta', {
      element(e) {
        const name = (e.getAttribute('name') || '').toLowerCase();
        const prop = (e.getAttribute('property') || '').toLowerCase();
        const content = e.getAttribute('content') || '';
        if (name === 'viewport') s.viewport = content;
        else if (name === 'description') s.description = truncate(content, 400);
        else if (name === 'generator') s.generator = truncate(content, 100);
        if (prop.startsWith('og:')) s.og = true;
      },
    })
    .on('h1', {
      element() { curH1 = ''; s.h1.push(''); },
      text(t) { if (curH1 !== null && s.h1.length && s.h1[s.h1.length - 1].length < 200) s.h1[s.h1.length - 1] += t.text; },
    })
    .on('nav', { element() { s.nav_count++; } })
    .on('a[href]', {
      element(e) {
        const href = (e.getAttribute('href') || '').trim();
        const low = href.toLowerCase();
        if (low.startsWith('tel:')) s.tel_links++;
        else if (low.startsWith('mailto:')) { const m = low.slice(7).split('?')[0]; if (m && s.mailto.length < 20) s.mailto.push(decodeURIComponent(m)); }
        else if (/wa\.me\/|api\.whatsapp\.com|whatsapp:\/\//.test(low)) s.whatsapp_links++;
        else if (/instagram\.com|facebook\.com|linkedin\.com|youtube\.com|tiktok\.com/.test(low)) { if (s.social.length < 10) s.social.push(truncate(href, 200)); }
        else if (low.startsWith('/') || low.startsWith('#') || (host && low.includes(host))) s.links_internal++;
        else if (low.startsWith('http')) s.links_external++;
      },
    })
    .on('form', { element(e) { s.forms++; if (s.form_actions.length < 5) s.form_actions.push(truncate(e.getAttribute('action') || '', 200)); } })
    .on('input', {
      element(e) {
        const t = (e.getAttribute('type') || '').toLowerCase();
        const n = ((e.getAttribute('name') || '') + ' ' + (e.getAttribute('id') || '')).toLowerCase();
        if (t === 'email' || /e-?mail/.test(n)) s.email_inputs++;
        if (t === 'tel' || /phone|telefone|celular|whats/.test(n)) s.tel_inputs++;
      },
    })
    .on('textarea', { element() { s.textareas++; } })
    .on('img', { element(e) { s.images++; if (!(e.getAttribute('alt') || '').trim()) s.images_without_alt++; } })
    .on('link[rel]', {
      element(e) {
        const rel = (e.getAttribute('rel') || '').toLowerCase();
        if (rel.includes('manifest')) s.manifest = true;
        const href = e.getAttribute('href') || '';
        if (s.scripts.length < 60 && /stylesheet|preload|preconnect|dns-prefetch/.test(rel)) s.scripts.push(truncate(href, 200));
      },
    })
    .on('script', {
      element(e) { const src = e.getAttribute('src'); if (src && s.scripts.length < 60) s.scripts.push(truncate(src, 200)); },
      text(t) { if (s.inline_script_sample.length < 20_000) s.inline_script_sample += t.text; },
    })
    .on('p, h2, h3, li, footer, address, small, span, strong, label, button, td', { text(t) { addText(t.text); } })
    .on('h1, a', { text(t) { addText(t.text); } });

  await rw.transform(new Response(htmlBytes, { headers: { 'content-type': 'text/html; charset=utf-8' } })).arrayBuffer();
  s.title = truncate(inTitle.replace(/\s+/g, ' ').trim(), 200);
  s.h1 = s.h1.map((h) => h.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 5);
  s.text = truncate(textParts.join(' ').replace(/\s+/g, ' '), 30_000);
  return s;
}

/** Deriva sinais secundários (ferramentas, CNPJ, e-mails, ano do copyright, CTA). */
export function deriveSignals(s, html = '') {
  const haystack = [s.scripts.join(' '), s.inline_script_sample, s.generator || '', html.slice(0, 200_000)].join(' ');
  const tools = [];
  for (const [name, cat, re] of TOOL_PATTERNS) if (re.test(haystack)) tools.push({ name, category: cat });
  const text = s.text || '';
  const emails = new Set(s.mailto.map((e) => e.toLowerCase()));
  for (const m of text.matchAll(EMAIL_RE)) { if (emails.size < 20) emails.add(m[0].toLowerCase()); }
  const cnpjs = [];
  for (const m of text.matchAll(CNPJ_RE)) {
    const c = m.slice(1).join('');
    if (isValidCnpj(c) && !cnpjs.includes(c)) cnpjs.push(c);
    if (cnpjs.length >= 3) break;
  }
  let copyrightYear = null;
  for (const m of text.matchAll(/(?:©|copyright|todos os direitos reservados)[^0-9]{0,40}(?:(\d{4})\s*[-–]\s*)?(\d{4})/gi)) {
    const y = +m[2];
    if (y >= 1995 && y <= 2100) copyrightYear = Math.max(copyrightYear || 0, y);
  }
  const jqueryOld = /jquery[-.\/]?(1\.\d+|2\.\d+)/i.test(s.scripts.join(' '));
  return {
    tools,
    emails: [...emails].filter((e) => !/\.(png|jpe?g|gif|webp|svg)$/.test(e) && !/sentry|wixpress|example\./.test(e)),
    cnpjs,
    copyright_year: copyrightYear,
    has_cta: CTA_RE.test(text) || s.h1.some((h) => CTA_RE.test(h)),
    jquery_old: jqueryOld,
  };
}

// ---------- achados ----------

const F = (kind, code, title, evidence, service) => ({ kind, code, title, evidence, service });

export function buildFindings(company, a, now = new Date()) {
  const f = [];
  if (!company.website) {
    if (company.social_url) f.push(F('confirmed', 'only_social', 'Sem site próprio: o endereço cadastrado é um perfil de rede social', `Endereço na fonte: ${company.social_url}`, 'site'));
    else f.push(F('confirmed', 'no_website', 'Nenhum site encontrado na fonte consultada', `Registro ${company.source_ref || company.source} sem endereço de site`, 'site'));
    f.push(F('unknown', 'site_elsewhere', 'Pode existir um site não listado na fonte', 'A fonte pública pode estar desatualizada', null));
    return f;
  }
  if (a.robots_allowed === false) {
    f.push(F('unknown', 'robots_blocked', 'Análise não feita: o robots.txt do site pede para não ser lido por robôs', `robots.txt de ${company.domain}`, null));
    return f;
  }
  if (a.fetch_error || !a.http_status || a.http_status >= 400) {
    const ev = a.fetch_error ? `Erro ao abrir ${a.url}: ${a.fetch_error}` : `HTTP ${a.http_status} ao abrir ${a.url}`;
    f.push(F('probable', 'site_unreachable', 'Site não respondeu corretamente na visita', `${ev} em ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC (uma tentativa)`, 'site'));
    return f;
  }
  const s = a.signals;
  const finalUrl = a.final_url || a.url;
  if (!finalUrl.startsWith('https://')) f.push(F('confirmed', 'no_https', 'Site sem HTTPS (navegador mostra "não seguro")', `Endereço final: ${finalUrl}`, 'site'));
  if (!s.viewport || !/width\s*=\s*device-width/i.test(s.viewport)) {
    f.push(F('confirmed', 'no_viewport', 'Página não está configurada para celular (sem meta viewport responsiva)', s.viewport ? `meta viewport = "${s.viewport}"` : 'Tag <meta name="viewport"> ausente', 'site'));
  }
  if (a.psi?.performance != null) {
    const p = Math.round(a.psi.performance * 100);
    if (p < 50) f.push(F('confirmed', 'psi_slow', `Desempenho mobile baixo no PageSpeed (${p}/100)`, `PageSpeed Insights, estratégia mobile${a.psi.lcp_ms ? `, LCP ${(a.psi.lcp_ms / 1000).toFixed(1)}s` : ''}`, 'site'));
    else if (p < 70) f.push(F('probable', 'psi_medium', `Desempenho mobile mediano no PageSpeed (${p}/100)`, 'PageSpeed Insights, estratégia mobile', 'site'));
  } else if (a.response_ms != null && a.response_ms > 3000) {
    f.push(F('probable', 'slow_response', 'Servidor demorou para responder', `Primeira resposta em ${(a.response_ms / 1000).toFixed(1)}s (uma medição)`, 'site'));
  } else {
    f.push(F('unknown', 'speed_unknown', 'Velocidade real de carregamento não medida', 'PageSpeed desativado ou indisponível', null));
  }
  if (a.page_bytes > 3_000_000) f.push(F('probable', 'heavy_page', 'Página inicial pesada', `${(a.page_bytes / 1e6).toFixed(1)} MB lidos`, 'site'));
  if (!s.title) f.push(F('confirmed', 'no_title', 'Página sem título (prejudica Google e compartilhamento)', 'Tag <title> vazia ou ausente', 'site'));
  if (!s.description) f.push(F('confirmed', 'no_description', 'Página sem descrição para buscadores', 'Tag <meta name="description"> ausente', 'site'));
  if (!s.h1.length) f.push(F('probable', 'no_h1', 'Sem título principal (H1) na página inicial', 'Nenhuma tag <h1> encontrada', 'landing'));

  const d = a.derived;
  const hasDirectChannel = s.forms > 0 || s.mailto.length > 0 || s.whatsapp_links > 0 || s.tel_links > 0;
  if (!hasDirectChannel) f.push(F('confirmed', 'no_contact_channel', 'Página inicial sem formulário, link de e-mail, WhatsApp ou telefone clicável', `0 formulários, 0 links mailto/tel/WhatsApp em ${finalUrl}`, 'landing'));
  else if (s.forms === 0 && s.whatsapp_links === 0) f.push(F('probable', 'no_form', 'Sem formulário de contato na página inicial', `Canais vistos: ${s.mailto.length} e-mail, ${s.tel_links} telefone`, 'landing'));
  if (!d.has_cta) f.push(F('probable', 'no_cta', 'Chamada para ação pouco clara', 'Nenhum termo como "orçamento", "fale conosco", "agende" no texto lido', 'landing'));

  const crm = d.tools.filter((t) => t.category === 'crm');
  const chat = d.tools.filter((t) => t.category === 'chat');
  const analytics = d.tools.filter((t) => t.category === 'analytics');
  if (s.forms > 0 && !crm.length) f.push(F('probable', 'form_without_crm', 'Formulário sem integração aparente com CRM', `${s.forms} formulário(s); nenhuma ferramenta de CRM detectada no HTML`, 'crm'));
  if (s.whatsapp_links > 0 && !chat.some((t) => t.name !== 'Botão de WhatsApp') && !crm.length) {
    f.push(F('probable', 'manual_whatsapp', 'Atendimento parece depender de WhatsApp manual', `${s.whatsapp_links} link(s) de WhatsApp; nenhuma ferramenta de atendimento/CRM detectada`, 'automation'));
  }
  if (!analytics.length) f.push(F('probable', 'no_analytics', 'Nenhuma ferramenta de análise de visitas detectada', 'Sem Google Analytics, Tag Manager, Pixel, Hotjar ou Clarity no HTML da página inicial', 'landing'));
  if (d.tools.length >= 4 && crm.length) f.push(F('probable', 'many_tools', 'Várias ferramentas em uso — potencial para integração', d.tools.map((t) => t.name).join(', '), 'api'));
  const year = now.getUTCFullYear();
  if (d.copyright_year && d.copyright_year <= year - 3) f.push(F('probable', 'old_copyright', 'Site possivelmente desatualizado', `Rodapé indica © ${d.copyright_year}`, 'site'));
  if (d.jquery_old) f.push(F('probable', 'old_stack', 'Tecnologia antiga no site', 'jQuery 1.x/2.x carregado', 'site'));
  if (s.images > 5 && s.images_without_alt / s.images > 0.5) f.push(F('confirmed', 'img_no_alt', 'Maioria das imagens sem texto alternativo (acessibilidade e SEO)', `${s.images_without_alt} de ${s.images} imagens sem alt`, 'site'));
  f.push(F('unknown', 'backend_integrations', 'Integrações internas (ERP, planilhas, processos) não são visíveis de fora', 'Só a conversa revela', null));
  return f;
}

// ---------- PageSpeed (opcional) e CNPJ ----------

async function runPageSpeed(ctx, url) {
  const key = ctx.env.PSI_API_KEY ? `&key=${encodeURIComponent(ctx.env.PSI_API_KEY)}` : '';
  const fields = encodeURIComponent('lighthouseResult/categories/*/score,lighthouseResult/audits/largest-contentful-paint/numericValue');
  const api = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=mobile&category=performance&category=accessibility&category=seo&fields=${fields}${key}`;
  ctx.metric('pagespeed_requests'); ctx.metric('subrequests');
  const res = await ctx.fetch(api, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const j = await res.json();
  const c = j?.lighthouseResult?.categories || {};
  return {
    performance: c.performance?.score ?? null,
    accessibility: c.accessibility?.score ?? null,
    seo: c.seo?.score ?? null,
    lcp_ms: j?.lighthouseResult?.audits?.['largest-contentful-paint']?.numericValue ?? null,
  };
}

export async function lookupCnpj(ctx, cnpj) {
  ctx.metric('brasilapi_requests'); ctx.metric('subrequests');
  const res = await ctx.fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return null;
  const d = await res.json();
  // Guardamos só dados da empresa. O quadro societário (dados pessoais) é descartado.
  return {
    razao_social: d.razao_social || null,
    nome_fantasia: d.nome_fantasia || null,
    cnae_code: d.cnae_fiscal ? String(d.cnae_fiscal) : null,
    cnae_description: d.cnae_fiscal_descricao || null,
    cnae_secondary: (d.cnaes_secundarios || []).map((x) => String(x.codigo)).filter((x) => x && x !== '0'),
    situacao: d.descricao_situacao_cadastral || null,
    municipio: d.municipio || null,
    uf: d.uf || null,
  };
}

// ---------- execução ----------

export async function analyzeCompany(ctx, company, settings) {
  const a = { url: company.website, final_url: null, http_status: null, response_ms: null, page_bytes: 0, fetch_error: null, robots_allowed: null, signals: null, derived: null, psi: null, cnpj: null };
  if (!company.website) return a;
  const origin = new URL(company.website).origin;

  try {
    ctx.metric('site_fetches'); ctx.metric('subrequests');
    const r = await ctx.fetch(`${origin}/robots.txt`, { headers: { 'user-agent': USER_AGENT }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
    const txt = r.ok ? truncate(await r.text(), 50_000) : '';
    a.robots_allowed = robotsAllows(txt, new URL(company.website).pathname || '/');
  } catch { a.robots_allowed = true; /* sem robots.txt acessível = sem restrição declarada */ }
  if (!a.robots_allowed) return a;

  try {
    ctx.metric('site_fetches'); ctx.metric('subrequests');
    const t0 = Date.now();
    const res = await ctx.fetch(company.website, {
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml', 'accept-language': 'pt-BR,pt;q=0.9' },
      redirect: 'follow', signal: AbortSignal.timeout(15_000),
    });
    a.response_ms = Date.now() - t0;
    a.http_status = res.status;
    a.final_url = res.url || company.website;
    const type = res.headers.get('content-type') || '';
    if (res.ok && /html/i.test(type)) {
      const bytes = await readLimited(res, (settings.investigator.max_page_kb || 400) * 1024);
      a.page_bytes = Number(res.headers.get('content-length')) || bytes.byteLength;
      a.signals = await extractSignals(bytes, a.final_url);
      const htmlHead = new TextDecoder().decode(bytes.subarray(0, 60_000));
      a.derived = deriveSignals(a.signals, htmlHead);
    } else if (res.ok) {
      a.fetch_error = `conteúdo não é HTML (${truncate(type, 60)})`;
      try { await res.body?.cancel(); } catch { /* ok */ }
    } else {
      try { await res.body?.cancel(); } catch { /* ok */ }
    }
  } catch (e) {
    a.fetch_error = truncate(e?.name === 'TimeoutError' ? 'tempo esgotado (15s)' : (e?.message || String(e)), 200);
  }

  if (a.signals && settings.investigator.use_pagespeed && (await usageToday(ctx, 'pagespeed_requests')) < settings.limits.pagespeed_daily) {
    try { a.psi = await runPageSpeed(ctx, a.final_url); } catch (e) { a.psi = { error: truncate(e.message, 100) }; }
  }

  if (a.derived?.cnpjs?.length && settings.investigator.cnpj_lookup && !company.cnpj
      && (await usageToday(ctx, 'brasilapi_requests')) < settings.limits.brasilapi_daily) {
    try { const info = await lookupCnpj(ctx, a.derived.cnpjs[0]); if (info) a.cnpj = { number: a.derived.cnpjs[0], ...info }; } catch { /* consulta opcional */ }
  }
  return a;
}

/** Processa até `batch` empresas pendentes. */
export async function runInvestigate(ctx, batch = 2) {
  const settings = await getSettings(ctx);
  const used = await usageToday(ctx, 'site_fetches');
  if (used >= settings.limits.site_fetch_daily) {
    const e = new Error(`Limite diário de visitas a sites atingido (${used}/${settings.limits.site_fetch_daily}).`);
    e.limitReached = 'investigate';
    throw e;
  }
  const ts = nowIso();
  const claimed = await ctx.all(
    `UPDATE companies SET research_status = 'investigating', research_attempts = research_attempts + 1, updated_at = ?
     WHERE id IN (SELECT id FROM companies WHERE research_status = 'pending' AND exclusion_status != 'block' ORDER BY id LIMIT ?)
     RETURNING *`, ts, batch,
  );
  if (!claimed.length) return { processed: 0 };
  const rules = await loadRules(ctx);
  let processed = 0;
  for (const company of claimed) {
    const lead = await ctx.first('SELECT * FROM leads WHERE company_id = ?', company.id);
    const a = await analyzeCompany(ctx, company, settings);
    const findings = buildFindings(company, a, ctx.now);
    const stmts = [];
    let cnpjNote = null;
    const upd = { research_status: 'investigated' };
    if (a.cnpj) {
      const dup = await ctx.first('SELECT id FROM companies WHERE cnpj = ? AND id != ?', a.cnpj.number, company.id);
      if (dup) cnpjNote = `CNPJ ${a.cnpj.number} já pertence à empresa #${dup.id}`;
      else Object.assign(upd, { cnpj: a.cnpj.number, cnae_code: a.cnpj.cnae_code, cnae_description: a.cnpj.cnae_description, cnae_secondary: JSON.stringify(a.cnpj.cnae_secondary || []) });
      if (a.cnpj.situacao && a.cnpj.situacao !== 'ATIVA') findings.unshift(F('confirmed', 'cnpj_inactive', `CNPJ com situação cadastral ${a.cnpj.situacao}`, `BrasilAPI (Receita Federal), CNPJ ${a.cnpj.number}`, null));
    }
    // nova verificação de exclusão com o que o site revelou (título, descrição, H1, texto, CNAE)
    const siteText = a.signals ? [a.signals.title, a.signals.description, a.signals.h1.join(' '), a.signals.text.slice(0, 4000)].join(' ') : '';
    const merged = { ...company, ...upd };
    const ex = checkExclusion(rules, subjectFromCompany(merged, siteText));
    if (company.exclusion_status !== 'approved' || ex.verdict === 'block') {
      if (ex.verdict === 'block') Object.assign(upd, { exclusion_status: 'block', exclusion_reason: describeExclusion(ex) });
      else if (ex.verdict === 'review' && company.exclusion_status === 'allow') Object.assign(upd, { exclusion_status: 'review', exclusion_reason: describeExclusion(ex) });
    }
    upd.exclusion_checked_at = nowIso();
    upd.updated_at = nowIso();
    const keys = Object.keys(upd);
    stmts.push(ctx.stmt(`UPDATE companies SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => upd[k]), company.id));
    const signalsToStore = a.signals ? { ...a.signals, inline_script_sample: undefined, text: truncate(a.signals.text, 3000), derived: a.derived, cnpj: a.cnpj, cnpj_note: cnpjNote } : { cnpj: a.cnpj };
    stmts.push(ctx.stmt(
      `INSERT INTO lead_analyses (company_id, url, final_url, http_status, response_ms, page_bytes, fetch_error, robots_allowed, signals, findings, psi, analyzed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      company.id, a.url, a.final_url, a.http_status, a.response_ms, a.page_bytes, a.fetch_error,
      a.robots_allowed == null ? null : a.robots_allowed ? 1 : 0, JSON.stringify(signalsToStore), JSON.stringify(findings),
      a.psi ? JSON.stringify(a.psi) : null, nowIso(),
    ));
    if (lead) {
      if (upd.exclusion_status === 'block') stmts.push(...stageStmts(ctx, lead, 'nao_contatar', `Exclusão: ${upd.exclusion_reason}`, 'investigator'));
      else if (lead.stage === 'descoberto') stmts.push(...stageStmts(ctx, lead, 'em_analise', 'Site analisado', 'investigator', upd.exclusion_status === 'review' ? { needs_review: 1 } : {}));
      else if (upd.exclusion_status === 'review') stmts.push(ctx.stmt('UPDATE leads SET needs_review = 1, updated_at = ? WHERE id = ?', nowIso(), lead.id));
    }
    await ctx.batch(stmts);
    processed++;
    ctx.metric('companies_investigated');
    ctx.log('info', 'investigator', `${company.name}: ${findings.filter((x) => x.kind !== 'unknown').length} achados${upd.exclusion_status ? ` · exclusão: ${upd.exclusion_status}` : ''}`, { company_id: company.id, http: a.http_status, error: a.fetch_error });
    if (ctx.budgetLeft() < 8) break;
  }
  // devolve à fila o que foi reservado e não processado (ex.: orçamento de consultas)
  const left = claimed.slice(processed).map((c) => c.id);
  if (left.length) await ctx.run(`UPDATE companies SET research_status = 'pending', research_attempts = research_attempts - 1 WHERE id IN (${left.map(() => '?').join(',')})`, ...left);
  return { processed };
}
