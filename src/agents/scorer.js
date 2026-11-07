// SCORER — pontuação própria de 0 a 100, explicável critério a critério.
// 80–100 alta · 60–79 média · 40–59 baixa · <40 não prospectar automaticamente.

import { nowIso, safeJson } from '../util.js';
import { getSettings, stageStmts } from '../db.js';
import { contactStatements } from './contacts.js';
import { SERVICES } from '../defaults.js';

const SEGMENT_WEIGHT = {
  construcao: 6, engenharia: 6, imobiliaria: 6, industria: 6, distribuidora: 6, logistica: 6, b2b: 6, concessionaria: 6,
  advocacia: 5, contabilidade: 5, arquitetura: 5, educacao: 5, comercio: 4, servicos: 4,
};

export function priorityFor(score, thresholds = { high: 80, medium: 60, low: 40 }) {
  if (score >= thresholds.high) return 'alta';
  if (score >= thresholds.medium) return 'media';
  if (score >= thresholds.low) return 'baixa';
  return 'nao_automatico';
}

/** Serviço mais compatível: soma dos achados por serviço (confirmado 2, provável 1), só serviços ativos. */
export function pickService(findings, enabledServices = {}) {
  const w = {};
  for (const f of findings) {
    if (!f.service || f.kind === 'unknown') continue;
    w[f.service] = (w[f.service] || 0) + (f.kind === 'confirmed' ? 2 : 1);
  }
  const ranked = Object.entries(w).filter(([k]) => enabledServices[k] !== false).sort((a, b) => b[1] - a[1]);
  if (ranked.length) return { service: ranked[0][0], weight: ranked[0][1] };
  const fallback = ['custom', 'internal', 'automation', 'site'].find((k) => enabledServices[k] !== false) || 'custom';
  return { service: fallback, weight: 0 };
}

export function scoreLead({ company, findings, best, analysis, settings }) {
  const breakdown = [];
  const add = (criterion, points, max, reason) => breakdown.push({ criterion, points: Math.max(0, Math.min(max, Math.round(points))), max, reason });
  const signals = analysis?.signals || {};

  // 1. Canal comercial
  if (best?.type === 'email' && best.ev.status === 'valid') add('Canal comercial', 20, 20, `E-mail institucional ${best.norm} publicado (${best.evidence})`);
  else if (best?.type === 'email') add('Canal comercial', 10, 20, `E-mail ${best.norm} precisa de revisão: ${best.ev.notes}`);
  else if (best?.type === 'form') add('Canal comercial', 8, 20, 'Só formulário no site (envio automático não é feito por formulário)');
  else if (best?.type === 'phone') add('Canal comercial', 5, 20, 'Só telefone institucional');
  else if (best?.type === 'whatsapp') add('Canal comercial', 4, 20, 'Só WhatsApp');
  else add('Canal comercial', 0, 20, 'Nenhum canal comercial publicado encontrado');

  // 2. Oportunidades identificadas
  const real = findings.filter((f) => f.kind !== 'unknown' && f.service);
  const conf = real.filter((f) => f.kind === 'confirmed');
  const prob = real.filter((f) => f.kind === 'probable');
  add('Oportunidades identificadas', conf.length * 8 + prob.length * 4, 30,
    real.length ? `${conf.length} confirmada(s), ${prob.length} provável(is): ${real.slice(0, 4).map((f) => f.title).join('; ')}` : 'Nenhuma oportunidade observável');

  // 3. Compatibilidade com os serviços
  const fit = pickService(findings, settings.services);
  add('Compatibilidade com serviços', fit.weight * 4, 15, fit.weight ? `Mais compatível: ${SERVICES[fit.service]?.label} (peso ${fit.weight})` : 'Sem sinal claro de serviço; proposta genérica sob medida');

  // 4. Clareza das necessidades
  const clarity = conf.length >= 2 ? 10 : conf.length === 1 ? 6 : prob.length >= 2 ? 4 : prob.length === 1 ? 2 : 0;
  add('Clareza das necessidades', clarity, 10, conf.length ? `${conf.length} problema(s) confirmado(s) com evidência` : prob.length ? 'Só indícios, nenhum problema confirmado' : 'Nada claro');

  // 5. Presença e atividade verificáveis
  let pres = 0; const why = [];
  if (analysis?.http_status && analysis.http_status < 400 && signals.title !== undefined) { pres += 6; why.push('site no ar'); }
  else if (company.social_url) { pres += 4; why.push('perfil em rede social'); }
  const cnpj = signals.cnpj;
  if (cnpj?.situacao === 'ATIVA') { pres += 4; why.push('CNPJ ativo'); }
  if ((signals.social || []).length) { pres += 3; why.push('redes sociais no site'); }
  if (company.phone) { pres += 2; why.push('telefone publicado'); }
  add('Presença verificável', pres, 15, why.length ? why.join(', ') : 'Pouca evidência de atividade');

  // 6. Potencial de compra
  let pot = SEGMENT_WEIGHT[company.segment] ?? 3;
  const potWhy = [`segmento ${company.segment || 'não informado'}`];
  const tools = signals.derived?.tools || [];
  if (tools.some((t) => t.category === 'analytics')) { pot += 2; potWhy.push('já investe em marketing digital (rastreamento instalado)'); }
  if (tools.some((t) => t.category === 'crm' || t.category === 'chat')) { pot += 2; potWhy.push('já usa ferramentas comerciais pagas'); }
  add('Potencial de compra', pot, 10, potWhy.join(', '));

  let score = breakdown.reduce((s, b) => s + b.points, 0);
  const notes = [];
  if (cnpj?.situacao && cnpj.situacao !== 'ATIVA') { score = 0; notes.push(`CNPJ ${cnpj.situacao}: não prospectar`); }
  let priority = priorityFor(score, settings.scoring?.thresholds);
  if (company.exclusion_status === 'review') { priority = 'nao_automatico'; notes.push('Em revisão na lista de exclusão: não prospectar automaticamente'); }
  if (company.exclusion_status === 'block') { score = 0; priority = 'nao_automatico'; notes.push('Bloqueada pela lista de exclusão'); }
  const explanation = [
    `Pontuação ${score}/100 → prioridade ${priority.replace('_', ' ')}.`,
    ...breakdown.map((b) => `${b.criterion}: ${b.points}/${b.max} — ${b.reason}`),
    ...notes,
  ].join('\n');
  return { score, priority, service: fit.service, breakdown, explanation };
}

/** Lê leads analisados, grava contatos e pontuação, move para "qualificado". */
export async function runScore(ctx, batch = 15) {
  const settings = await getSettings(ctx);
  const rows = await ctx.all(
    `SELECT l.id AS lead_id, l.stage, c.*,
            (SELECT a.id FROM lead_analyses a WHERE a.company_id = c.id ORDER BY a.analyzed_at DESC, a.id DESC LIMIT 1) AS analysis_id
     FROM leads l JOIN companies c ON c.id = l.company_id
     WHERE l.stage = 'em_analise' AND c.research_status = 'investigated' AND c.exclusion_status != 'block'
     ORDER BY l.id LIMIT ?`, batch,
  );
  if (!rows.length) return { scored: 0 };
  const ids = rows.map((r) => r.analysis_id).filter(Boolean);
  const analyses = ids.length ? await ctx.all(`SELECT * FROM lead_analyses WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids) : [];
  const byId = new Map(analyses.map((a) => [a.id, { ...a, signals: safeJson(a.signals, {}), findings: safeJson(a.findings, []) }]));
  const supp = await ctx.all("SELECT value FROM suppression_list");
  const suppressed = new Set(supp.map((s) => s.value));

  const stmts = [];
  const ts = nowIso();
  for (const r of rows) {
    const analysis = byId.get(r.analysis_id) || { signals: {}, findings: [] };
    const company = { ...r, id: r.id };
    const { stmts: cs, best } = contactStatements(ctx, company, analysis, suppressed);
    stmts.push(...cs);
    const result = scoreLead({ company, findings: analysis.findings, best, analysis, settings });
    stmts.push(ctx.stmt(
      'INSERT INTO lead_scores (company_id, analysis_id, score, priority, service_fit, breakdown, explanation, created_at) VALUES (?,?,?,?,?,?,?,?)',
      company.id, analysis.id ?? null, result.score, result.priority, result.service, JSON.stringify(result.breakdown), result.explanation, ts,
    ));
    const hasEmail = best?.type === 'email' && best.ev.status === 'valid';
    stmts.push(...stageStmts(ctx, { id: r.lead_id, stage: r.stage }, 'qualificado', `Pontuação ${result.score} (${result.priority})`, 'scorer', {
      score: result.score, priority: result.priority, service_fit: result.service, contact_pending: hasEmail ? 0 : 1,
    }));
    if (hasEmail) {
      stmts.push(ctx.stmt(
        "UPDATE leads SET contact_id = (SELECT id FROM contacts WHERE company_id = ? AND type = 'email' AND normalized_value = ?) WHERE id = ?",
        company.id, best.norm, r.lead_id,
      ));
      stmts.push(ctx.stmt("UPDATE contacts SET is_primary = (normalized_value = ?) WHERE company_id = ? AND type = 'email'", best.norm, company.id));
    }
  }
  await ctx.batch(stmts);
  ctx.metric('leads_scored', rows.length);
  ctx.log('info', 'scorer', `${rows.length} lead(s) classificados`);
  return { scored: rows.length };
}
