// CONTACT FINDER — reúne canais comerciais publicados e avalia a base legal de uso de cada um.
// Prioridade: e-mail institucional no domínio da empresa > formulário > telefone > outros.
// Não procura e-mails escondidos, não adivinha endereços, não acessa áreas privadas.

import { nowIso } from '../util.js';

const ROLE_PREFIXES = ['contato', 'contact', 'comercial', 'vendas', 'sales', 'atendimento', 'faleconosco', 'fale', 'sac',
  'info', 'informacoes', 'orcamento', 'orcamentos', 'marketing', 'adm', 'administrativo', 'administracao', 'empresa',
  'negocios', 'projetos', 'escritorio', 'secretaria', 'recepcao', 'geral', 'hello', 'ola', 'oi', 'suporte', 'loja',
  'diretoria', 'gerencia', 'parcerias', 'financeiro', 'compras'];
const AVOID_PREFIXES = ['rh', 'curriculo', 'curriculos', 'vagas', 'trabalheconosco', 'jobs', 'noreply', 'no-reply',
  'nao-responda', 'naoresponda', 'privacidade', 'dpo', 'lgpd', 'ouvidoria', 'abuse', 'postmaster', 'webmaster', 'nfe', 'nf-e', 'fiscal'];
const FREE_PROVIDERS = ['gmail.com', 'hotmail.com', 'outlook.com', 'live.com', 'yahoo.com', 'yahoo.com.br', 'bol.com.br',
  'uol.com.br', 'terra.com.br', 'icloud.com', 'ig.com.br', 'msn.com', 'protonmail.com', 'globo.com', 'globomail.com'];

export function classifyEmail(email, companyDomain) {
  const e = String(email || '').toLowerCase().trim();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}$/.test(e)) return { usable: false, reason: 'formato inválido' };
  const [local, domain] = e.split('@');
  const localKey = local.replace(/[^a-z]/g, '');
  if (AVOID_PREFIXES.some((p) => localKey === p.replace(/[^a-z]/g, '') || local.startsWith(p + '.') || local.startsWith(p + '-')))
    return { usable: false, reason: 'endereço não comercial (RH, privacidade, sistema)' };
  const sameDomain = !!companyDomain && (domain === companyDomain || domain.endsWith('.' + companyDomain) || companyDomain.endsWith('.' + domain));
  const role = ROLE_PREFIXES.some((p) => localKey === p || localKey.startsWith(p));
  const free = FREE_PROVIDERS.includes(domain);
  const looksPersonal = /^[a-z]+[._-][a-z]+$/.test(local) && !role;
  return { usable: true, role, sameDomain, free, looksPersonal };
}

/** Base legal avaliada (LGPD art. 7º IX — legítimo interesse — para contato B2B com endereço institucional). */
export function evaluateLegalBasis(email, companyDomain, sourceType) {
  const c = classifyEmail(email, companyDomain);
  if (!c.usable) return { status: 'invalid', legal_basis: 'none', notes: `Não usar: ${c.reason}.`, role: false };
  if (c.role && c.sameDomain) {
    return {
      status: 'valid', legal_basis: 'legitimate_interest_b2b', role: true,
      notes: `Endereço institucional (${email}) publicado pela própria empresa (${sourceType}). Contato B2B ligado à atividade da empresa, ` +
        'com identificação do remetente e opção de descadastro em toda mensagem (LGPD art. 7º IX e art. 10). Não é consentimento.',
    };
  }
  if (c.free) return { status: 'pending_review', legal_basis: 'needs_review', role: c.role, notes: 'E-mail em provedor gratuito: pode ser pessoal do dono. Revisar antes de usar.' };
  if (c.looksPersonal) return { status: 'pending_review', legal_basis: 'needs_review', role: false, notes: 'Parece e-mail pessoal de colaborador (nome.sobrenome). Revisar antes de usar.' };
  if (!c.sameDomain) return { status: 'pending_review', legal_basis: 'needs_review', role: c.role, notes: 'Domínio do e-mail diferente do site da empresa. Revisar.' };
  return { status: 'pending_review', legal_basis: 'needs_review', role: false, notes: 'Endereço no domínio da empresa mas sem cara de caixa comercial. Revisar.' };
}

/**
 * Monta os statements que gravam os contatos encontrados para uma empresa.
 * Retorna { stmts, best } — best = melhor canal (para o score) sem tocar o banco.
 */
export function contactStatements(ctx, company, analysis, suppressed = new Set()) {
  const ts = nowIso();
  const signals = analysis?.signals || {};
  const derived = signals.derived || {};
  const found = []; // {type, value, source_type, source_url, evidence}
  for (const e of derived.emails || []) found.push({ type: 'email', value: e, source_type: 'website', source_url: analysis.final_url || company.website, evidence: signals.mailto?.includes(e) ? 'link mailto na página inicial' : 'texto da página inicial' });
  if (company.email) found.push({ type: 'email', value: company.email, source_type: company.source, source_url: company.source_url, evidence: 'tag de e-mail na fonte' });
  if (signals.forms > 0) found.push({ type: 'form', value: analysis.final_url || company.website, source_type: 'website', source_url: analysis.final_url || company.website, evidence: `${signals.forms} formulário(s) na página inicial` });
  if (company.phone) found.push({ type: 'phone', value: company.phone, source_type: company.source, source_url: company.source_url, evidence: 'telefone na fonte' });
  if (signals.whatsapp_links > 0) found.push({ type: 'whatsapp', value: 'link na página inicial', source_type: 'website', source_url: analysis.final_url || company.website, evidence: `${signals.whatsapp_links} link(s) de WhatsApp` });

  const stmts = [];
  const seen = new Set();
  const evaluated = [];
  for (const f of found) {
    const norm = f.type === 'email' ? f.value.toLowerCase().trim() : f.type === 'phone' ? f.value.replace(/\D/g, '') : f.value;
    const key = `${f.type}:${norm}`;
    if (!norm || seen.has(key)) continue;
    seen.add(key);
    let ev = { status: 'valid', legal_basis: 'legitimate_interest_b2b', notes: 'Canal institucional publicado pela empresa.', role: false };
    if (f.type === 'email') {
      ev = evaluateLegalBasis(norm, company.domain, f.source_type);
      if (suppressed.has(norm) || suppressed.has(norm.split('@')[1])) ev = { ...ev, status: 'suppressed', notes: 'Na lista de supressão (descadastro, recusa ou bounce).' };
    }
    evaluated.push({ ...f, norm, ev });
    stmts.push(ctx.stmt(
      `INSERT INTO contacts (company_id, type, value, normalized_value, is_role_address, legal_basis, legal_basis_notes, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(company_id, type, normalized_value) DO UPDATE SET
         status = CASE WHEN contacts.status IN ('suppressed','invalid') THEN contacts.status ELSE excluded.status END,
         legal_basis = excluded.legal_basis, legal_basis_notes = excluded.legal_basis_notes, updated_at = excluded.updated_at`,
      company.id, f.type, f.value, norm, ev.role ? 1 : 0, ev.legal_basis, ev.notes, ev.status, ts, ts,
    ));
    stmts.push(ctx.stmt(
      `INSERT OR IGNORE INTO contact_sources (contact_id, source_type, source_url, evidence, collected_at)
       SELECT id, ?, ?, ?, ? FROM contacts WHERE company_id = ? AND type = ? AND normalized_value = ?`,
      f.source_type, f.source_url || '', f.evidence, ts, company.id, f.type, norm,
    ));
  }
  const rank = (x) => {
    if (x.type === 'email' && x.ev.status === 'valid') return 100 + (x.source_type === 'website' ? 1 : 0);
    if (x.type === 'email' && x.ev.status === 'pending_review') return 60;
    if (x.type === 'form') return 40;
    if (x.type === 'phone') return 20;
    if (x.type === 'whatsapp') return 15;
    return 0;
  };
  const best = evaluated.filter((x) => x.ev.status !== 'suppressed' && x.ev.status !== 'invalid').sort((a, b) => rank(b) - rank(a))[0] || null;
  return { stmts, best, evaluated };
}
