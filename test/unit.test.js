// Testes das regras puras (rodam no runtime dos Workers, com HTMLRewriter de verdade).
import { describe, it, expect } from 'vitest';
import { normalize, inWindow, zonedToUtc, localDate, isValidCnpjExport } from './helpers.js';
import { compileRules, checkExclusion } from '../src/exclusion.js';
import { defaultExclusionRules, DEFAULT_SETTINGS } from '../src/defaults.js';
import { classifyReply, stripQuoted } from '../src/agents/inbox.js';
import { scoreLead, priorityFor, pickService } from '../src/agents/scorer.js';
import { composeInitial, observationPhrase } from '../src/agents/copywriter.js';
import { computeSlots } from '../src/agents/scheduler.js';
import { buildMime } from '../src/google.js';
import { classifyEmail, evaluateLegalBasis } from '../src/agents/contacts.js';
import { normalizeWebsite, parseOverpass, buildOverpassQuery, validateDiscoverRequest, parseManualImport } from '../src/agents/finder.js';
import { robotsAllows, isValidCnpj, extractSignals, deriveSignals, buildFindings } from '../src/agents/investigator.js';

const rules = compileRules(defaultExclusionRules().map(([type, value, reason]) => ({ type, value, reason })));
const ex = (s) => checkExclusion(rules, { tags: {}, cnaes: [], ...s }).verdict;

describe('texto e fuso', () => {
  it('normaliza acentos e pontuação', () => expect(normalize('Clínica Odontológica São-José!')).toBe('clinica odontologica sao jose'));
  it('converte horário de São Paulo para UTC (UTC-3)', () => expect(zonedToUtc(2026, 11, 9, 9, 0, 'America/Sao_Paulo').toISOString()).toBe('2026-11-09T12:00:00.000Z'));
  it('janela de envio respeita dia e horário', () => {
    const segunda10h = new Date('2026-11-09T13:00:00Z');
    const sabado10h = new Date('2026-11-07T13:00:00Z');
    const segunda20h = new Date('2026-11-09T23:00:00Z');
    expect(inWindow(segunda10h, 'America/Sao_Paulo', [1, 2, 3, 4, 5], '09:00', '17:00')).toBe(true);
    expect(inWindow(sabado10h, 'America/Sao_Paulo', [1, 2, 3, 4, 5], '09:00', '17:00')).toBe(false);
    expect(inWindow(segunda20h, 'America/Sao_Paulo', [1, 2, 3, 4, 5], '09:00', '17:00')).toBe(false);
    expect(localDate(new Date('2026-11-10T01:00:00Z'), 'America/Sao_Paulo')).toBe('2026-11-09');
  });
});

describe('lista de exclusão (contrato Arco)', () => {
  it('bloqueia saúde pelo nome', () => {
    for (const name of ['Clínica Sorriso', 'Consultório Dr. Silva', 'Hospital Santa Maria', 'Laboratório Bio', 'OdontoPrime', 'Espaço Estética Bella', 'Drogaria Central', 'Fisioterapia Movimento', 'Clinica Veterinaria Pet']) {
      expect(ex({ name }), name).toBe('block');
    }
  });
  it('bloqueia categorias OSM de saúde', () => {
    expect(ex({ name: 'Sorriso', tags: { amenity: 'dentist' } })).toBe('block');
    expect(ex({ name: 'Centro X', tags: { healthcare: 'centre' } })).toBe('block');
  });
  it('bloqueia CNAE de saúde (86, 87, 75, estética 9602502)', () => {
    expect(ex({ name: 'Empresa Alfa', cnaes: ['8630503'] })).toBe('block');
    expect(ex({ name: 'Empresa Beta', cnaes: ['9602502'] })).toBe('block');
    expect(ex({ name: 'Empresa Gama', cnaes: ['7500100'] })).toBe('block');
  });
  it('bloqueia concorrentes da Arco por nome e domínio', () => {
    expect(ex({ name: 'Feegow Tecnologia' })).toBe('block');
    expect(ex({ name: 'Software XYZ', domain: 'clinicorp.com' })).toBe('block');
    expect(ex({ name: 'Qualquer', email: 'contato@arco.ag' })).toBe('block');
  });
  it('em dúvida segura para revisão', () => {
    expect(ex({ name: 'Salão Beleza Pura' })).toBe('review');
    expect(ex({ name: 'Academia Força Total' })).toBe('review');
    expect(ex({ name: 'Arco Construções' })).toBe('review');
    expect(ex({ name: 'Webhaus', tags: { office: 'it' } })).toBe('review');
    expect(ex({ name: 'Empresa Y', cnaes: ['6201501'] })).toBe('review');
  });
  it('termo de saúde no texto do site vira revisão, não bloqueio', () => {
    expect(ex({ name: 'Construtora Alfa', text: 'Engenharia de saúde e segurança do trabalho' })).toBe('review');
    expect(ex({ name: 'Construtora Alfa', text: 'Apartamentos com academia e salão de festas' })).toBe('allow');
  });
  it('libera empresas fora da saúde', () => {
    for (const name of ['Civilcon Construtora', 'Imobiliária Lar Doce Lar', 'Silva Advogados', 'Contabilidade Exata', 'Transportadora Rápida']) expect(ex({ name }), name).toBe('allow');
  });
});

describe('Inbox: classificação determinística', () => {
  const c = (text, extra = {}) => classifyReply({ from: 'contato@empresa.com.br', subject: 'Re: Empresa', text, headers: {}, ...extra });
  it('descadastro vence tudo', () => {
    expect(c('Por favor, me descadastrem da lista').classification).toBe('unsubscribe');
    expect(c('Tenho interesse, mas não quero receber mais e-mails desse tipo').classification).toBe('unsubscribe');
  });
  it('recusa (sem confundir com "tenho interesse")', () => {
    const r = c('Não tenho interesse, obrigado.');
    expect(r.classification).toBe('refusal');
    expect(r.needs_review).toBe(false);
    expect(c('Já temos fornecedor para isso.').classification).toBe('refusal');
    expect(c('Não estou interessado').classification).toBe('refusal');
  });
  it('interesse em reunião e positivo são elegíveis a resposta automática', () => {
    expect(c('Podemos conversar sim. Qual horário você tem?')).toMatchObject({ classification: 'meeting', auto_ok: true });
    expect(c('Tenho interesse!')).toMatchObject({ classification: 'positive', auto_ok: true });
    expect(c('Sim')).toMatchObject({ classification: 'positive', auto_ok: true });
    expect(c('Pode me enviar a análise?')).toMatchObject({ classification: 'info_request', auto_ok: true });
  });
  it('preço, objeção, dúvida e ambíguo vão para revisão', () => {
    expect(c('Quanto custa um site?')).toMatchObject({ needs_review: true, auto_ok: false });
    expect(c('Achei interessante mas agora não é o momento')).toMatchObject({ classification: 'objection', needs_review: true });
    expect(c('Vocês atendem fora de SC?')).toMatchObject({ classification: 'question', needs_review: true });
    expect(c('Recebido.')).toMatchObject({ classification: 'inconclusive', needs_review: true });
    expect(c('Não temos interesse agora, mas podemos conversar ano que vem')).toMatchObject({ needs_review: true, auto_ok: false });
  });
  it('mensagens automáticas e falhas de entrega', () => {
    expect(c('Estou de férias', { headers: { 'Auto-Submitted': 'auto-replied' } }).classification).toBe('auto');
    expect(c('Estou fora do escritório até segunda').classification).toBe('auto');
    expect(classifyReply({ from: 'mailer-daemon@googlemail.com', subject: 'Delivery Status Notification (Failure)', text: '', headers: {} }).classification).toBe('bounce');
  });
  it('ignora o texto citado da mensagem original', () => {
    const text = 'Sim, vamos marcar.\n\nEm seg., 9 de nov. de 2026 às 10:00, Matheus escreveu:\n> Faria sentido conversar? Para não receber, responda descadastrar';
    expect(stripQuoted(text)).toBe('Sim, vamos marcar.');
    expect(c(text).classification).toBe('meeting');
  });
});

describe('Scorer', () => {
  const settings = DEFAULT_SETTINGS;
  const company = { id: 1, name: 'Civilcon', segment: 'construcao', phone: '47 3333', exclusion_status: 'allow' };
  const best = { type: 'email', norm: 'contato@civilcon.com.br', evidence: 'mailto', ev: { status: 'valid' } };
  const findings = [
    { kind: 'confirmed', code: 'no_viewport', title: 'Sem viewport', service: 'site' },
    { kind: 'confirmed', code: 'no_https', title: 'Sem HTTPS', service: 'site' },
    { kind: 'probable', code: 'form_without_crm', title: 'Form sem CRM', service: 'crm' },
    { kind: 'unknown', code: 'speed_unknown', title: 'Velocidade', service: null },
  ];
  const analysis = { http_status: 200, signals: { title: 'Civilcon', social: ['https://instagram.com/x'], derived: { tools: [{ name: 'Google Analytics', category: 'analytics' }] } } };
  it('faixas de prioridade', () => {
    expect(priorityFor(85)).toBe('alta'); expect(priorityFor(60)).toBe('media'); expect(priorityFor(40)).toBe('baixa'); expect(priorityFor(39)).toBe('nao_automatico');
  });
  it('pontuação explicável e serviço compatível', () => {
    const r = scoreLead({ company, findings, best, analysis, settings });
    expect(r.score).toBeGreaterThanOrEqual(80);
    expect(r.priority).toBe('alta');
    expect(r.service).toBe('site');
    expect(r.breakdown).toHaveLength(6);
    expect(r.explanation).toMatch(/Canal comercial: 20\/20/);
    expect(r.breakdown.reduce((s, b) => s + b.points, 0)).toBe(r.score);
  });
  it('sem canal e sem achados não prospecta', () => {
    const r = scoreLead({ company: { ...company, phone: null }, findings: [], best: null, analysis: {}, settings });
    expect(r.priority).toBe('nao_automatico');
  });
  it('empresa em revisão nunca entra no automático', () => {
    expect(scoreLead({ company: { ...company, exclusion_status: 'review' }, findings, best, analysis, settings }).priority).toBe('nao_automatico');
  });
  it('respeita serviços desativados', () => {
    expect(pickService(findings, { site: false, crm: true }).service).toBe('crm');
  });
});

describe('Contact Finder: base legal', () => {
  it('e-mail institucional no domínio = legítimo interesse B2B', () => {
    expect(evaluateLegalBasis('contato@empresa.com.br', 'empresa.com.br', 'website').status).toBe('valid');
    expect(evaluateLegalBasis('comercial@empresa.com.br', 'empresa.com.br', 'website').legal_basis).toBe('legitimate_interest_b2b');
  });
  it('pessoal, gratuito ou outro domínio vai para revisão', () => {
    expect(evaluateLegalBasis('joao.silva@empresa.com.br', 'empresa.com.br', 'website').status).toBe('pending_review');
    expect(evaluateLegalBasis('empresa@gmail.com', 'empresa.com.br', 'website').status).toBe('pending_review');
    expect(evaluateLegalBasis('contato@outra.com', 'empresa.com.br', 'website').status).toBe('pending_review');
  });
  it('não usa RH, privacidade ou no-reply', () => {
    expect(classifyEmail('rh@empresa.com.br', 'empresa.com.br').usable).toBe(false);
    expect(classifyEmail('noreply@empresa.com.br', 'empresa.com.br').usable).toBe(false);
    expect(classifyEmail('lgpd@empresa.com.br', 'empresa.com.br').usable).toBe(false);
  });
});

describe('Copywriter', () => {
  const sender = { name: 'Matheus', company: 'Estúdio M', email: 'm@estudio.com', phone: '', website: 'https://estudio.com' };
  const company = { id: 7, name: 'Civilcon Construtora', domain: 'civilcon.com.br' };
  const findings = [
    { kind: 'confirmed', code: 'no_viewport', title: 'x', evidence: 'Tag ausente', service: 'site' },
    { kind: 'probable', code: 'no_analytics', title: 'x', evidence: 'x', service: 'landing' },
  ];
  const m = composeInitial({ company, findings, service: 'site', sender, unsubUrl: 'https://app/u/abc' });
  it('identifica a empresa, explica a finalidade e oferece descadastro', () => {
    expect(m.subject).toContain('Civilcon Construtora');
    expect(m.body).toContain('Civilcon Construtora');
    expect(m.body).toMatch(/contato comercial|proposta comercial/);
    expect(m.body).toContain('https://app/u/abc');
    expect(m.body).toMatch(/descadastrar/);
  });
  it('usa a evidência observada e não inventa nem promete', () => {
    expect(m.body).toContain('não está configurada para celular');
    expect(m.subject).toContain('celular');
    expect(m.body).not.toMatch(/R\$|garant|conforme combinamos|como conversamos|nossa última conversa/i);
  });
  it('é curta', () => expect(m.body.split(/\s+/).length).toBeLessThan(190));
  it('toda observação tem frase', () => {
    for (const code of ['no_website', 'only_social', 'no_https', 'no_contact_channel', 'form_without_crm', 'manual_whatsapp']) expect(observationPhrase({ code, evidence: '', title: '' }, company)).toBeTruthy();
  });
});

describe('Scheduler: horários livres', () => {
  const availability = { days: [1, 2, 3, 4, 5], start: '09:00', end: '12:00', duration_minutes: 30, buffer_minutes: 0, min_notice_hours: 24, horizon_days: 3 };
  const now = new Date('2026-11-09T12:00:00Z'); // segunda 09:00 em SP
  it('respeita antecedência mínima, dias e ocupados', () => {
    const busy = [{ start: new Date('2026-11-10T13:00:00Z'), end: new Date('2026-11-10T14:00:00Z') }]; // terça 10h–11h SP
    const slots = computeSlots({ now, availability, timezone: 'America/Sao_Paulo', busy });
    expect(slots[0].start).toBe('2026-11-10T12:00:00.000Z'); // terça 09:00 (24h depois)
    expect(slots.some((s) => s.start === '2026-11-10T13:00:00.000Z' || s.start === '2026-11-10T13:30:00.000Z')).toBe(false);
    expect(slots.every((s) => new Date(s.start) >= new Date(now.getTime() + 86_400_000))).toBe(true);
  });
  it('pula fim de semana', () => {
    const slots = computeSlots({ now: new Date('2026-11-06T12:00:00Z'), availability: { ...availability, min_notice_hours: 0 }, timezone: 'America/Sao_Paulo', busy: [] });
    const weekdays = slots.map((s) => new Date(new Date(s.start).getTime() - 3 * 3600_000).getUTCDay());
    expect(weekdays.includes(0) || weekdays.includes(6)).toBe(false);
  });
});

describe('Gmail MIME', () => {
  it('monta cabeçalhos com descadastro em um clique e acentos codificados', () => {
    const mime = buildMime({ from: 'm@x.com', fromName: 'Matheus Ação', to: 'contato@y.com', subject: 'Olá, ação', text: 'Corpo ç', listUnsubscribe: 'https://app/u/t' });
    expect(mime).toContain('List-Unsubscribe: <https://app/u/t>, <mailto:m@x.com?subject=descadastrar>');
    expect(mime).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
    expect(mime).toMatch(/Subject: =\?UTF-8\?B\?/);
    expect(mime).not.toMatch(/\r\n\r\n.*Corpo ç/);
  });
  it('remove quebras de linha de cabeçalhos (injeção)', () => {
    const mime = buildMime({ from: 'm@x.com', to: 'a@b.com\r\nBcc: vitima@z.com', subject: 's', text: 't' });
    expect(mime).not.toMatch(/\r\nBcc:/);
  });
});

describe('Finder', () => {
  it('trata rede social como "sem site próprio"', () => {
    expect(normalizeWebsite('https://www.instagram.com/empresa')).toMatchObject({ website: null, social: 'https://www.instagram.com/empresa' });
    expect(normalizeWebsite('www.Empresa.com.br')).toMatchObject({ domain: 'empresa.com.br' });
  });
  it('valida pedidos e monta consulta Overpass por UF/cidade', () => {
    expect(() => validateDiscoverRequest({ country: 'BR', segment: 'construcao' })).toThrow(/UF/);
    const q = buildOverpassQuery(validateDiscoverRequest({ state: 'sc', city: 'Joinville', segment: 'advocacia', keywords: 'tributário', max: 10 }));
    expect(q).toContain('area["ISO3166-2"="BR-SC"]');
    expect(q).toContain('["name"="Joinville"]');
    expect(q).toContain('nwr.w["office"="lawyer"]["name"~"tributário",i]');
    expect(q).toContain('out tags center 10;');
  });
  it('converte elementos OSM e guarda a origem', () => {
    const list = parseOverpass({ elements: [{ type: 'node', id: 9, tags: { name: 'Lima Advogados', office: 'lawyer', website: 'lima.adv.br', email: 'contato@lima.adv.br' } }, { type: 'node', id: 10, tags: {} }] }, { segment: 'auto', country: 'BR', state: 'SC', city: 'Joinville' });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ segment: 'advocacia', source_ref: 'osm:node/9', domain: 'lima.adv.br', source_url: 'https://www.openstreetmap.org/node/9' });
  });
  it('importação manual', () => {
    const rows = parseManualImport('Construtora X; construtorax.com.br; Curitiba; PR; construcao; contato@construtorax.com.br\n;\nY');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Construtora X', domain: 'construtorax.com.br', state: 'PR', source: 'manual' });
  });
});

describe('Investigator', () => {
  it('respeita robots.txt', () => {
    expect(robotsAllows('User-agent: *\nDisallow: /')).toBe(false);
    expect(robotsAllows('User-agent: *\nDisallow:')).toBe(true);
    expect(robotsAllows('User-agent: *\nDisallow: /admin')).toBe(true);
    expect(robotsAllows('User-agent: AureonSalesEngine\nDisallow: /\n\nUser-agent: *\nAllow: /')).toBe(false);
  });
  it('valida CNPJ pelos dígitos', () => {
    expect(isValidCnpj('00.000.000/0001-91')).toBe(true);
    expect(isValidCnpj('11.111.111/1111-11')).toBe(false);
    expect(isValidCnpjExport).toBeDefined();
  });
  it('extrai sinais com HTMLRewriter e gera achados com evidência', async () => {
    const html = `<!doctype html><html lang="pt-BR"><head><title>Construtora Alfa</title>
      <script src="https://www.googletagmanager.com/gtag/js?id=G-1"></script></head>
      <body><h1>Construímos seu sonho</h1><p>Fale conosco: <a href="mailto:contato@alfa.com.br">contato@alfa.com.br</a></p>
      <form action="/enviar"><input type="email" name="email"><textarea></textarea></form>
      <a href="https://wa.me/5547999999999">WhatsApp</a><footer>© 2019 Construtora Alfa · CNPJ 00.000.000/0001-91</footer></body></html>`;
    const s = await extractSignals(new TextEncoder().encode(html), 'https://alfa.com.br/');
    expect(s.title).toBe('Construtora Alfa');
    expect(s.viewport).toBe(null);
    expect(s.forms).toBe(1);
    expect(s.mailto).toEqual(['contato@alfa.com.br']);
    expect(s.whatsapp_links).toBe(1);
    const d = deriveSignals(s, html);
    expect(d.tools.map((t) => t.name)).toContain('Google Analytics');
    expect(d.cnpjs).toEqual(['00000000000191']);
    expect(d.copyright_year).toBe(2019);
    const findings = buildFindings({ website: 'https://alfa.com.br/', domain: 'alfa.com.br' }, { url: 'https://alfa.com.br/', final_url: 'https://alfa.com.br/', http_status: 200, response_ms: 300, page_bytes: html.length, signals: s, derived: d }, new Date('2026-11-07T00:00:00Z'));
    const codes = findings.map((f) => f.code);
    expect(codes).toContain('no_viewport');
    expect(codes).toContain('no_description');
    expect(codes).toContain('form_without_crm');
    expect(codes).toContain('old_copyright');
    expect(codes).not.toContain('no_https');
    expect(codes).not.toContain('no_analytics');
    expect(findings.every((f) => f.evidence)).toBe(true);
  });
  it('sem site: achado confirmado só sobre a fonte', () => {
    const f = buildFindings({ website: null, social_url: null, source_ref: 'osm:node/1' }, {});
    expect(f[0]).toMatchObject({ kind: 'confirmed', code: 'no_website' });
    expect(f.some((x) => x.kind === 'unknown')).toBe(true);
  });
});
