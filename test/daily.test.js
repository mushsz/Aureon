// Rotina diária: canais manuais, mini-auditoria, planner, tela Hoje, sequência de e-mails e lembretes.
import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:workers';
import { client, fakeFetch, setupAdmin, q } from './helpers.js';
import { createContext } from '../src/db.js';
import { encryptText, nowIso, b64urlToUtf8 } from '../src/util.js';
import { normalizePhone, whatsappFromUrl, instagramHandle, waLink, formatPhone } from '../src/channels.js';
import { personNameFor, evaluateLegalBasis } from '../src/agents/contacts.js';
import { composeManual, composeSequenceEmail, composeInitial } from '../src/agents/copywriter.js';
import { extractSignals } from '../src/agents/investigator.js';
import { saveCandidates } from '../src/agents/finder.js';
import { runPlan, pickChannel } from '../src/agents/planner.js';
import { runFollowup } from '../src/agents/outreach.js';
import { runReminders } from '../src/agents/scheduler.js';

const sender = { name: 'Matheus Krigger', company: 'Estúdio M', email: 'eu@estudio.com', phone: '(47) 99999-0000', website: 'https://estudio.com', instagram: 'estudiom' };

describe('canais manuais', () => {
  it('normaliza telefone e lê WhatsApp/Instagram de links', () => {
    expect(normalizePhone('(47) 99988-7766')).toBe('5547999887766');
    expect(normalizePhone('+55 47 3333-4444')).toBe('554733334444');
    expect(normalizePhone('123')).toBe(null);
    expect(whatsappFromUrl('https://wa.me/5547999887766?text=oi')).toBe('5547999887766');
    expect(whatsappFromUrl('https://api.whatsapp.com/send?phone=5547999887766')).toBe('5547999887766');
    expect(instagramHandle('https://www.instagram.com/Construtora.Alfa/')).toBe('construtora.alfa');
    expect(instagramHandle('https://instagram.com/p/abc123/')).toBe(null);
    expect(instagramHandle('@lar_imoveis')).toBe('lar_imoveis');
    expect(waLink('5547999887766', 'Olá, tudo bem?')).toBe('https://wa.me/5547999887766?text=Ol%C3%A1%2C%20tudo%20bem%3F');
    expect(formatPhone('5547999887766')).toBe('(47) 99988-7766');
  });
  it('escolhe o canal pela preferência, sem repetir o último e respeitando a supressão', () => {
    const co = { whatsapp: '5547999887766', instagram: 'alfa', phone_norm: '554733334444' };
    expect(pickChannel(co, ['whatsapp', 'instagram'])).toBe('whatsapp');
    expect(pickChannel(co, ['whatsapp', 'instagram'], 'whatsapp')).toBe('instagram');
    expect(pickChannel(co, ['whatsapp', 'phone'], null, new Set(['phone:5547999887766']))).toBe('phone');
    expect(pickChannel({}, ['whatsapp'])).toBe(null);
  });
  it('lê WhatsApp, Instagram e páginas de contato do HTML', async () => {
    const html = `<html><body><a href="https://wa.me/5547999887766">Zap</a><a href="https://instagram.com/construtoraalfa">IG</a>
      <a href="/contato">Contato</a><a href="/sobre-nos">Sobre</a><a href="/obras">Obras</a></body></html>`;
    const s = await extractSignals(new TextEncoder().encode(html), 'https://alfa.com.br/');
    expect(s.whatsapp_numbers).toEqual(['5547999887766']);
    expect(s.instagram_handles).toEqual(['construtoraalfa']);
    expect(s.contact_pages).toEqual(['/contato', '/sobre-nos']);
  });
});

describe('e-mail do responsável', () => {
  it('nome só quando está escrito na página', () => {
    expect(personNameFor('joao.silva@alfa.com.br', 'Fale com João Silva, diretor comercial')).toBe('João');
    expect(personNameFor('joao.silva@alfa.com.br', 'Fale conosco')).toBe(null);
  });
  it('nominal no domínio da empresa só vale com a opção ligada', () => {
    expect(evaluateLegalBasis('joao.silva@alfa.com.br', 'alfa.com.br', 'website').status).toBe('pending_review');
    const ok = evaluateLegalBasis('joao.silva@alfa.com.br', 'alfa.com.br', 'website', { allowNamed: true });
    expect(ok).toMatchObject({ status: 'valid', named: true, legal_basis: 'legitimate_interest_b2b' });
    expect(evaluateLegalBasis('joao.silva@gmail.com', 'alfa.com.br', 'website', { allowNamed: true }).status).toBe('pending_review');
    expect(evaluateLegalBasis('joao.silva@alfa.com.br', 'alfa.com.br', 'osm', { allowNamed: true }).status).toBe('pending_review');
  });
});

describe('textos', () => {
  const company = { id: 3, name: 'Construtora Alfa', domain: 'alfa.com.br' };
  const findings = [{ kind: 'confirmed', code: 'no_viewport', title: 'x', evidence: 'x', service: 'site' }, { kind: 'probable', code: 'form_without_crm', title: 'x', evidence: 'x', service: 'crm' }];
  it('e-mail inicial com nome, link da análise e Instagram na assinatura', () => {
    const m = composeInitial({ company, findings, service: 'site', sender, unsubUrl: 'https://app/u/x', auditLink: 'https://app/analise/tok', personName: 'João' });
    expect(m.body.startsWith('Olá, João, tudo bem?')).toBe(true);
    expect(m.body).toContain('https://app/analise/tok');
    expect(m.body).toContain('instagram.com/estudiom');
    expect(m.template).toContain(':audit:nome');
  });
  it('sequência: 2º e-mail traz a agenda; o último encerra', () => {
    const s2 = composeSequenceEmail({ step: 1, isLast: false, company, findings, service: 'site', sender, unsubUrl: 'u', firstSentAt: nowIso(), timezone: 'America/Sao_Paulo', bookingLink: 'https://app/agendar/b', auditLink: 'https://app/analise/t' });
    expect(s2.body).toContain('https://app/agendar/b');
    expect(s2.body).toContain('descadastrar');
    const s3 = composeSequenceEmail({ step: 2, isLast: true, company, sender, unsubUrl: 'u', firstSentAt: nowIso(), timezone: 'America/Sao_Paulo' });
    expect(s3.body).toMatch(/último e-mail/);
  });
  it('mensagens manuais curtas, com saída fácil e sem preço', () => {
    for (const kind of ['first', 'followup', 'hot']) {
      const t = composeManual({ channel: 'whatsapp', kind, company, findings, service: 'site', sender, auditLink: 'https://app/analise/t' });
      expect(t).toContain('Construtora Alfa');
      expect(t).toMatch(/não volto a chamar/);
      expect(t).not.toMatch(/R\$|garant/i);
      expect(t.length).toBeLessThan(420);
    }
    expect(composeManual({ channel: 'phone', kind: 'first', company, findings, service: 'site', sender })).toMatch(/Roteiro/);
  });
});

describe('rotina diária ponta a ponta', () => {
  let api;
  beforeAll(async () => {
    api = client();
    const st = await api('GET', '/api/setup/status');
    if (st.data.needsSetup) await setupAdmin(api);
    else await api('POST', '/api/login', { email: 'admin@teste.com', password: 'senha-forte-123' });
    await api('PUT', '/api/settings/sender', sender);
  });

  async function manualLead(name, extra = {}) {
    const ctx = createContext(env);
    await saveCandidates(ctx, [{ name, segment: 'construcao', company_type: null, country: 'BR', state: 'SC', city: 'Joinville', website: null, domain: null, social_url: null, email: null, phone: null, instagram: null, whatsapp: null, source: 'manual', source_ref: `manual:${name}`, source_url: null, tags: {}, ...extra }]);
    const c = (await q('SELECT c.id, l.id AS lead_id FROM companies c JOIN leads l ON l.company_id = c.id WHERE c.name = ?', name))[0];
    // simula a pontuação feita pelo Scorer (lead qualificado sem e-mail)
    await env.DB.prepare("UPDATE leads SET stage = 'qualificado', score = 62, priority = 'media', service_fit = 'site', contact_pending = 1 WHERE id = ?").bind(c.lead_id).run();
    await env.DB.prepare("UPDATE companies SET research_status = 'investigated' WHERE id = ?").bind(c.id).run();
    return c;
  }

  it('lead só com WhatsApp vira cartão com texto pronto; "Feito" registra e avança', async () => {
    const c = await manualLead('Construtora Zap', { whatsapp: '5547999887766', instagram: 'construtorazap' });
    const plan = await api('POST', '/api/today/plan');
    expect(plan.data.created.touch).toBeGreaterThanOrEqual(1);
    const t = await api('GET', '/api/today');
    const card = t.data.cards.find((x) => x.company_id === c.id);
    expect(card).toMatchObject({ kind: 'touch', channel: 'whatsapp' });
    expect(card.links.whatsapp).toMatch(/^https:\/\/wa\.me\/5547999887766\?text=/);
    expect(card.links.instagram).toBe('https://ig.me/m/construtorazap');
    expect(card.message).toContain('Construtora Zap');
    expect(card.audit_url).toMatch(/\/analise\/[\w-]+$/);
    // não duplica ao montar de novo
    await api('POST', '/api/today/plan');
    expect(await q("SELECT id FROM tasks WHERE lead_id = ? AND status = 'open'", c.lead_id)).toHaveLength(1);
    const done = await api('POST', `/api/tasks/${card.id}/done`, { channel: 'whatsapp' });
    expect(done.status).toBe(200);
    const lead = (await q('SELECT stage, manual_step, last_manual_at FROM leads WHERE id = ?', c.lead_id))[0];
    expect(lead).toMatchObject({ stage: 'contatado', manual_step: 1 });
    expect(await q("SELECT channel FROM messages WHERE lead_id = ? AND kind = 'manual_touch'", c.lead_id)).toEqual([{ channel: 'whatsapp' }]);
    // próximo toque só depois do intervalo configurado
    await api('POST', '/api/today/plan');
    expect(await q("SELECT id FROM tasks WHERE lead_id = ? AND status = 'open'", c.lead_id)).toHaveLength(0);
    await env.DB.prepare("UPDATE leads SET last_manual_at = ? WHERE id = ?").bind(new Date(Date.now() - 5 * 86_400_000).toISOString(), c.lead_id).run();
    await api('POST', '/api/today/plan');
    const next = (await q("SELECT channel, step FROM tasks WHERE lead_id = ? AND status = 'open'", c.lead_id))[0];
    expect(next).toMatchObject({ step: 2, channel: 'instagram' });
  });

  it('mini-auditoria: abre, conta só a visita real e vira cartão quente', async () => {
    const c = await manualLead('Imobiliária Visita', { whatsapp: '5547988887777' });
    await env.DB.prepare("INSERT INTO lead_analyses (company_id, url, signals, findings, analyzed_at) VALUES (?, NULL, '{}', ?, ?)")
      .bind(c.id, JSON.stringify([{ kind: 'confirmed', code: 'no_website', title: 'Sem site', evidence: 'Registro sem site', service: 'site' }]), nowIso()).run();
    const det = await api('GET', `/api/companies/${c.id}`);
    const path = new URL(det.data.channels.audit_url).pathname;
    const pub = client();
    const page = await pub('GET', path, null, { raw: true });
    const text = await page.text();
    expect(page.status).toBe(200);
    expect(text).toContain('Imobiliária Visita');
    expect(text).toContain('Escolher um horário');
    expect(text).toContain('wa.me/5547999990000');
    // visita sua (logado) não conta
    await api('POST', `${path}/visto`, {});
    expect((await q('SELECT audit_views FROM leads WHERE id = ?', c.lead_id))[0].audit_views).toBe(0);
    await pub('POST', `${path}/visto`, {});
    expect((await q('SELECT audit_views FROM leads WHERE id = ?', c.lead_id))[0].audit_views).toBe(1);
    expect((await q("SELECT kind, channel FROM tasks WHERE lead_id = ? AND kind = 'hot'", c.lead_id))[0]).toMatchObject({ kind: 'hot', channel: 'whatsapp' });
    const book = await pub('GET', `${path}/agendar`, null, { raw: true });
    expect(book.status).toBe(303);
    expect(book.headers.get('location')).toMatch(/^\/agendar\/[\w-]+$/);
    expect((await pub('GET', '/analise/token-que-nao-existe-123', null, { raw: true })).status).toBe(404);
  });

  it('"Não contatar" suprime todos os canais e some da lista', async () => {
    const c = await manualLead('Loja Pare', { whatsapp: '5547977776666', instagram: 'lojapare' });
    await api('POST', '/api/today/plan');
    const task = (await q("SELECT id FROM tasks WHERE lead_id = ? AND status = 'open'", c.lead_id))[0];
    expect((await api('POST', `/api/tasks/${task.id}/block`)).status).toBe(200);
    const sup = await q("SELECT type, value FROM suppression_list WHERE value IN ('5547977776666','lojapare') ORDER BY type");
    expect(sup).toEqual([{ type: 'instagram', value: 'lojapare' }, { type: 'phone', value: '5547977776666' }]);
    expect((await q('SELECT stage FROM leads WHERE id = ?', c.lead_id))[0].stage).toBe('nao_contatar');
    await api('POST', '/api/today/plan');
    expect(await q("SELECT id FROM tasks WHERE lead_id = ? AND status = 'open'", c.lead_id)).toHaveLength(0);
  });

  it('"Amanhã" adia e a tela respeita o limite de cartões', async () => {
    for (let i = 0; i < 4; i++) await manualLead(`Empresa Fila ${i}`, { whatsapp: `55479666655${10 + i}` });
    const s = (await api('GET', '/api/settings')).data.settings;
    await api('PUT', '/api/settings/planner', { ...s.planner, max_cards: 3, new_manual_per_day: 10 });
    await api('POST', '/api/today/plan');
    const t = await api('GET', '/api/today');
    expect(t.data.cards.length).toBe(3);
    expect(t.data.more).toBeGreaterThanOrEqual(1);
    const first = t.data.cards[0];
    await api('POST', `/api/tasks/${first.id}/snooze`);
    expect((await q('SELECT due_date, status FROM tasks WHERE id = ?', first.id))[0].status).toBe('open');
    expect((await api('GET', '/api/today')).data.cards.some((x) => x.id === first.id)).toBe(false);
    await api('PUT', '/api/settings/planner', s.planner);
  });
});

describe('sequência de e-mails e lembretes (Gmail simulado)', () => {
  it('2º e-mail com agenda no dia 4, encerramento no dia 12, perdido depois', async () => {
    const ctx0 = createContext(env);
    await saveCandidates(ctx0, [{ name: 'Construtora Sequência', segment: 'construcao', country: 'BR', state: 'SC', city: 'Joinville', website: 'https://seq.com.br/', domain: 'seq.com.br', email: null, phone: null, source: 'manual', source_ref: 'manual:seq', tags: {} }]);
    const c = (await q("SELECT c.id, l.id AS lead_id FROM companies c JOIN leads l ON l.company_id = c.id WHERE c.name = 'Construtora Sequência'"))[0];
    const ts = nowIso();
    const ct = await env.DB.prepare("INSERT INTO contacts (company_id, type, value, normalized_value, status, created_at, updated_at) VALUES (?, 'email', 'contato@seq.com.br', 'contato@seq.com.br', 'valid', ?, ?)").bind(c.id, ts, ts).run();
    const contactId = ct.meta.last_row_id;
    const cv = await env.DB.prepare("INSERT INTO conversations (lead_id, contact_id, subject, gmail_thread_id, created_at, updated_at) VALUES (?, ?, 'Construtora Sequência: o site no celular', 'thread-seq', ?, ?)").bind(c.lead_id, contactId, ts, ts).run();
    const five = new Date(Date.now() - 5 * 86_400_000).toISOString();
    await env.DB.prepare("INSERT INTO messages (conversation_id, lead_id, direction, kind, status, subject, body_text, to_addr, sent_at, dedupe_key, created_at, updated_at) VALUES (?, ?, 'out', 'initial', 'simulated', 's', 'b', 'contato@seq.com.br', ?, ?, ?, ?)")
      .bind(cv.meta.last_row_id, c.lead_id, five, `initial:${c.lead_id}`, five, five).run();
    await env.DB.prepare("UPDATE leads SET stage = 'contatado', contact_id = ?, last_contact_at = ?, service_fit = 'site' WHERE id = ?").bind(contactId, five, c.lead_id).run();
    const api = client();
    await api('POST', '/api/login', { email: 'admin@teste.com', password: 'senha-forte-123' });
    const s = (await api('GET', '/api/settings')).data.settings;
    await api('PUT', '/api/settings/outreach', { ...s.outreach, days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:59', min_minutes_between: 2 });
    await env.DB.prepare("UPDATE messages SET sent_at = '2020-01-01T00:00:00.000Z' WHERE lead_id != ? AND status IN ('sent','simulated')").bind(c.lead_id).run();

    let r = await runFollowup(createContext(env, { fetchFn: fakeFetch([]) }), 5);
    const m2 = (await q("SELECT template, body_text, status FROM messages WHERE lead_id = ? AND kind = 'followup'", c.lead_id))[0];
    expect(m2).toMatchObject({ template: 'sequence:1:agenda', status: 'simulated' });
    expect(m2.body_text).toMatch(/\/agendar\/[\w-]+/);
    // dia 12: encerramento
    await env.DB.prepare("UPDATE messages SET sent_at = ? WHERE lead_id = ? AND kind = 'initial'").bind(new Date(Date.now() - 13 * 86_400_000).toISOString(), c.lead_id).run();
    await env.DB.prepare("UPDATE messages SET sent_at = '2020-01-01T00:00:00.000Z', created_at = '2020-01-01T00:00:00.000Z' WHERE kind = 'followup'").run();
    r = await runFollowup(createContext(env, { fetchFn: fakeFetch([]) }), 5);
    const m3 = (await q("SELECT template FROM messages WHERE lead_id = ? AND kind = 'followup' ORDER BY id", c.lead_id)).map((x) => x.template);
    expect(m3).toEqual(['sequence:1:agenda', 'sequence:2:encerramento']);
    // sem resposta depois do último → perdido
    await env.DB.prepare('UPDATE leads SET last_contact_at = ? WHERE id = ?').bind(new Date(Date.now() - 9 * 86_400_000).toISOString(), c.lead_id).run();
    r = await runFollowup(createContext(env, { fetchFn: fakeFetch([]) }), 5);
    expect(r.lost).toBeGreaterThanOrEqual(1);
    expect((await q('SELECT stage FROM leads WHERE id = ?', c.lead_id))[0].stage).toBe('perdido');
    await api('PUT', '/api/settings/outreach', s.outreach);
  });

  it('lembrete 1 h antes sai uma vez só, mesmo em modo simulação', async () => {
    const ts = nowIso();
    await env.DB.prepare(`INSERT INTO integrations (provider, status, account_email, refresh_token_enc, access_token_enc, access_token_expires_at, updated_at)
      VALUES ('google','connected','eu@estudio.com',?,?,?,?) ON CONFLICT(provider) DO UPDATE SET status='connected', access_token_enc=excluded.access_token_enc, access_token_expires_at=excluded.access_token_expires_at`)
      .bind(await encryptText(env, 'r'), await encryptText(env, 'a'), new Date(Date.now() + 3600_000).toISOString(), ts).run();
    const lead = (await q("SELECT id FROM leads LIMIT 1"))[0];
    const start = new Date(Date.now() + 60 * 60_000).toISOString();
    await env.DB.prepare("INSERT INTO appointments (lead_id, token_hash, status, starts_at, ends_at, timezone, attendee_email, meet_link, token_expires_at, created_at, updated_at) VALUES (?, 'h-lembrete', 'booked', ?, ?, 'America/Sao_Paulo', 'cliente@empresa.com', 'https://meet.google.com/x', ?, ?, ?)")
      .bind(lead.id, start, start, start, ts, ts).run();
    const sent = [];
    const f = fakeFetch([['messages/send', (url, init) => { sent.push(b64urlToUtf8(JSON.parse(init.body).raw)); return { id: 'g', threadId: 't' }; }]]);
    expect((await runReminders(createContext(env, { fetchFn: f }))).sent).toBe(1);
    expect((await runReminders(createContext(env, { fetchFn: f }))).sent).toBe(0);
    expect(sent[0]).toContain('To: cliente@empresa.com');
  });
});
