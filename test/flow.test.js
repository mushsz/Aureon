// Integração: API + D1 + agentes, com as APIs externas (Overpass, sites, Gmail, Calendar) simuladas.
import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:workers';
import { createScheduledController, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index.js';
import { client, fakeFetch, htmlResponse, setupAdmin, q } from './helpers.js';
import { encryptText, b64urlToUtf8, nowIso } from '../src/util.js';
import { createContext } from '../src/db.js';
import { tick } from '../src/engine.js';

const SITE_RUIM = `<!doctype html><html><head><title>Construtora Horizonte</title></head><body>
  <h1>Obras com qualidade</h1><p>Solicite um orçamento: <a href="mailto:contato@horizonteconstrutora.com.br">contato@horizonteconstrutora.com.br</a></p>
  <form action="/contato"><input type="email" name="email"><textarea name="msg"></textarea></form><p>Telefone (47) 3333-3333</p></body></html>`;
const SITE_BOM = (name, email) => `<!doctype html><html lang="pt-BR"><head><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${name}</title><meta name="description" content="${name}"></head><body><h1>${name}</h1>
  <p>Fale conosco: <a href="mailto:${email}">${email}</a></p><a href="https://wa.me/5547999999999">WhatsApp</a></body></html>`;

function overpass(elements) {
  return ['overpass-api.de', () => ({ elements })];
}
const robots404 = [/\/robots\.txt$/, () => new Response('', { status: 404 })];
const site = (host, body) => [new RegExp(`^https?://(www\\.)?${host.replace(/\./g, '\\.')}/?$`), (url) => htmlResponse(body, url)];

async function openWindow(api) {
  const s = (await api('GET', '/api/settings')).data.settings;
  await api('PUT', '/api/settings/outreach', { ...s.outreach, days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:59', min_minutes_between: 2 });
}
async function connectFakeGoogle(email = 'eu@estudio.com') {
  const ts = nowIso();
  await env.DB.prepare(`INSERT INTO integrations (provider, status, account_email, scopes, refresh_token_enc, access_token_enc, access_token_expires_at, verified_at, connected_at, updated_at, inbox_cursor)
    VALUES ('google','connected',?,?,?,?,?,?,?,?,?) ON CONFLICT(provider) DO UPDATE SET status='connected', account_email=excluded.account_email, refresh_token_enc=excluded.refresh_token_enc,
    access_token_enc=excluded.access_token_enc, access_token_expires_at=excluded.access_token_expires_at, verified_at=excluded.verified_at`)
    .bind(email, 'gmail.send', await encryptText(env, 'refresh-falso'), await encryptText(env, 'access-falso'), new Date(Date.now() + 3600_000).toISOString(), ts, ts, ts, String(Math.floor(Date.now() / 1000) - 3600)).run();
}
const decodeRaw = (init) => b64urlToUtf8(JSON.parse(init.body).raw);
const bodyOfMime = (mime) => { const b64 = mime.split('\r\n\r\n')[1].replace(/\r\n/g, ''); return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))); };

let api;
beforeAll(async () => {
  api = client();
  const status = await api('GET', '/api/setup/status');
  if (status.data.needsSetup) await setupAdmin(api);
  else await api('POST', '/api/login', { email: 'admin@teste.com', password: 'senha-forte-123' });
});

describe('segurança e autenticação', () => {
  it('setup só uma vez, login, sessão, CSRF e limite de tentativas', async () => {
    const other = client();
    expect((await other('POST', '/api/setup', { setup_token: env.SETUP_TOKEN, email: 'x@y.com', name: 'X', password: 'outra-senha-123' })).status).toBe(409);
    expect((await other('GET', '/api/dashboard')).status).toBe(401);
    expect((await other('POST', '/api/login', { email: 'admin@teste.com', password: 'errada-123456' })).status).toBe(401);
    const ok = await other('POST', '/api/login', { email: 'admin@teste.com', password: 'senha-forte-123' });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('set-cookie')).toMatch(/HttpOnly; SameSite=Lax/);
    expect((await other('GET', '/api/dashboard')).status).toBe(200);
    // sem token CSRF
    const res = await worker.fetch(new Request('http://localhost/api/system/pause', { method: 'POST', headers: { cookie: other.cookie(), 'content-type': 'application/json' }, body: '{"paused":true}' }), env, { waitUntil() {} });
    expect(res.status).toBe(403);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    // limite de tentativas por e-mail
    const brute = client();
    let last;
    for (let i = 0; i < 10; i++) last = await brute('POST', '/api/login', { email: 'alvo@teste.com', password: 'tentativa-' + i });
    expect(last.status).toBe(429);
    // senha fraca recusada
    expect((await api('POST', '/api/me/password', { current: 'senha-forte-123', next: 'curta' })).status).toBe(400);
  });

  it('não expõe tokens Google nem segredos na API', async () => {
    await connectFakeGoogle();
    const s = await api('GET', '/api/settings');
    const text = JSON.stringify(s.data);
    expect(text).not.toContain('refresh');
    expect(text).not.toContain('access-falso');
    expect(s.data.google.status).toBe('connected');
  });
});

describe('fluxo em simulação', () => {
  it('descobre, exclui saúde/concorrente, analisa, pontua, escreve e simula envio sem duplicar', async () => {
    const elements = [
      { type: 'node', id: 101, tags: { name: 'Construtora Horizonte', office: 'construction_company', website: 'https://horizonteconstrutora.com.br', phone: '+55 47 3333-3333' } },
      { type: 'node', id: 102, tags: { name: 'Clínica Sorriso Feliz', amenity: 'dentist', website: 'https://sorrisofeliz.com.br' } },
      { type: 'node', id: 103, tags: { name: 'Feegow Sistemas', office: 'company', website: 'https://feegow.com.br' } },
      { type: 'node', id: 104, tags: { name: 'Salão Glamour', shop: 'hairdresser', email: 'glamour@gmail.com' } },
      { type: 'node', id: 105, tags: { name: 'Lima Advogados', office: 'lawyer', website: 'https://limaadvogados.com.br' } },
    ];
    const f = fakeFetch([overpass(elements), robots404, site('horizonteconstrutora.com.br', SITE_RUIM), site('limaadvogados.com.br', SITE_BOM('Lima Advogados', 'joao.lima@limaadvogados.com.br'))]);
    api.setFetch(f);
    const d = await api('POST', '/api/discover', { state: 'SC', city: 'Joinville', segment: 'auto', max: 20, run_now: true });
    expect(d.data.summary.ran[0]).toMatchObject({ ok: true, result: { found: 5, inserted: 5, blocked: 2, review: 1 } });
    // repetir a mesma descoberta não duplica
    const d2 = await api('POST', '/api/discover', { state: 'SC', city: 'Joinville', segment: 'auto', max: 20, run_now: true });
    expect(d2.data.summary.ran[0].result).toMatchObject({ inserted: 0, duplicates: 5 });
    const blocked = await q("SELECT name FROM companies WHERE exclusion_status = 'block' ORDER BY name");
    expect(blocked.map((b) => b.name)).toEqual(['Clínica Sorriso Feliz', 'Feegow Sistemas']);
    expect(await q("SELECT l.id FROM leads l JOIN companies c ON c.id = l.company_id WHERE c.exclusion_status = 'block'")).toHaveLength(0);

    for (let i = 0; i < 3; i++) await api('POST', '/api/jobs/run', { type: 'investigate' });
    expect(await q("SELECT id FROM companies WHERE research_status = 'pending' AND exclusion_status != 'block'")).toHaveLength(0);
    // nenhum site bloqueado foi visitado
    expect(f.calls.some((c) => c.url.includes('sorrisofeliz') || c.url.includes('feegow'))).toBe(false);

    await api('POST', '/api/jobs/run', { type: 'score' });
    const horizonte = (await q("SELECT c.id, l.score, l.priority, l.service_fit, l.contact_pending FROM companies c JOIN leads l ON l.company_id = c.id WHERE c.name = 'Construtora Horizonte'"))[0];
    expect(horizonte.priority).toBe('alta');
    expect(horizonte.service_fit).toBe('site');
    expect(horizonte.contact_pending).toBe(0);
    const lima = (await q("SELECT l.contact_pending FROM companies c JOIN leads l ON l.company_id = c.id WHERE c.name = 'Lima Advogados'"))[0];
    expect(lima.contact_pending).toBe(1); // e-mail pessoal: pendente de revisão
    const det = await api('GET', `/api/companies/${horizonte.id}`);
    expect(det.data.analysis.findings.find((x) => x.code === 'no_viewport')).toMatchObject({ kind: 'confirmed' });
    expect(det.data.score.explanation).toMatch(/Canal comercial: 20\/20/);
    expect(det.data.contacts[0]).toMatchObject({ normalized_value: 'contato@horizonteconstrutora.com.br', status: 'valid', legal_basis: 'legitimate_interest_b2b' });
    expect(det.data.contacts[0].sources[0].source_url).toContain('horizonteconstrutora.com.br');

    await api('POST', '/api/jobs/run', { type: 'prepare' });
    const draft = (await q("SELECT * FROM messages WHERE kind = 'initial' AND to_addr = 'contato@horizonteconstrutora.com.br'"))[0];
    expect(draft.status).toBe('draft');
    expect(draft.body_text).toContain('Construtora Horizonte');
    expect(draft.body_text).toMatch(/\/u\/[\w-]+\.[\w-]+/);

    await openWindow(api);
    const o = await api('POST', '/api/jobs/run', { type: 'outreach' });
    expect(o.data.summary.ran[0].result).toMatchObject({ sent: 1 });
    expect((await q('SELECT status FROM messages WHERE id = ?', draft.id))[0].status).toBe('simulated');
    expect(f.calls.some((c) => c.url.includes('gmail.googleapis.com'))).toBe(false); // simulação não chama o Gmail
    await api('POST', '/api/jobs/run', { type: 'outreach' });
    expect(await q("SELECT id FROM messages WHERE kind = 'initial' AND to_addr = 'contato@horizonteconstrutora.com.br'")).toHaveLength(1);

    const dash = await api('GET', '/api/dashboard');
    expect(dash.data.mode).toBe('simulation');
    expect(dash.data.metrics.contacted_simulated).toBeGreaterThanOrEqual(1);
    expect(dash.data.metrics.blocked).toBeGreaterThanOrEqual(2);
  });

  it('não envia fora da janela configurada', async () => {
    const s = (await api('GET', '/api/settings')).data.settings;
    const now = new Date();
    const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hourCycle: 'h23' }).format(now));
    const start = `${String((hour + 2) % 24).padStart(2, '0')}:00`;
    const end = `${String((hour + 3) % 24).padStart(2, '0')}:00`;
    if (end > start) {
      await api('PUT', '/api/settings/outreach', { ...s.outreach, start, end });
      const ctx = createContext(env);
      const { sendGate } = await import('../src/agents/outreach.js');
      const { getSettings } = await import('../src/db.js');
      expect(await sendGate(ctx, await getSettings(ctx))).toBe('fora da janela de envio configurada');
      await api('PUT', '/api/settings/outreach', s.outreach);
    }
  });
});

describe('envio real, resposta e descadastro (Gmail simulado)', () => {
  it('aprovação, envio, leitura da resposta, descadastro e bloqueio de novos contatos', async () => {
    await connectFakeGoogle('eu@estudio.com');
    const sent = [];
    const f = fakeFetch([
      robots404,
      site('construtorareal.com.br', SITE_BOM('Construtora Real', 'comercial@construtorareal.com.br').replace('<meta name="viewport" content="width=device-width, initial-scale=1">', '')),
      ['gmail.googleapis.com/gmail/v1/users/me/messages/send', (url, init) => { sent.push(decodeRaw(init)); return { id: `g${sent.length}`, threadId: 'thread-real' }; }],
      [/messages\?/, () => ({ messages: [{ id: 'in-1' }, { id: 'in-2' }] })],
      [/messages\/in-1/, () => ({ id: 'in-1', threadId: 'thread-real', internalDate: String(Date.now()), snippet: '', payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'Comercial <comercial@construtorareal.com.br>' }, { name: 'Subject', value: 'Re: Construtora Real' }, { name: 'Message-ID', value: '<abc@mail>' }], body: { data: btoa('Por favor, me descadastrem dessa lista.').replace(/\+/g, '-').replace(/\//g, '_') } } })],
      [/messages\/in-2/, () => ({ id: 'in-2', threadId: 'outro-fio', internalDate: String(Date.now()), payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'amigo@pessoal.com' }, { name: 'Subject', value: 'Churrasco sábado' }], body: { data: btoa('Vamos?') } } })],
    ]);
    api.setFetch(f);
    // sem aprovação o modo continua simulação
    expect((await api('POST', '/api/outreach/approve-live', { confirm: 'sim' })).status).toBe(400);
    const ap = await api('POST', '/api/outreach/approve-live', { confirm: 'ATIVAR' });
    expect(ap.status).toBe(200);
    expect((await api('GET', '/api/dashboard')).data.mode).toBe('live');

    await api('POST', '/api/import', { text: 'Construtora Real; construtorareal.com.br; Joinville; SC; construcao' });
    await api('POST', '/api/jobs/run', { type: 'investigate' });
    await api('POST', '/api/jobs/run', { type: 'score' });
    await api('POST', '/api/jobs/run', { type: 'prepare' });
    await openWindow(api);
    await env.DB.prepare("UPDATE messages SET sent_at = '2020-01-01T00:00:00.000Z', created_at = '2020-01-01T00:00:00.000Z' WHERE status IN ('sent','simulated')").run();
    const o = await api('POST', '/api/jobs/run', { type: 'outreach' });
    expect(o.data.summary.ran[0].result).toMatchObject({ sent: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('To: comercial@construtorareal.com.br');
    expect(sent[0]).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
    expect(bodyOfMime(sent[0])).toContain('Construtora Real');
    const msg = (await q("SELECT * FROM messages WHERE to_addr = 'comercial@construtorareal.com.br' AND kind = 'initial'"))[0];
    expect(msg).toMatchObject({ status: 'sent', gmail_message_id: 'g1' });
    expect((await q('SELECT gmail_thread_id FROM conversations WHERE id = ?', msg.conversation_id))[0].gmail_thread_id).toBe('thread-real');

    const ib = await api('POST', '/api/jobs/run', { type: 'inbox' });
    expect(ib.data.summary.ran[0].result).toMatchObject({ ingested: 1, ignored: 1 });
    expect(await q("SELECT * FROM messages WHERE gmail_message_id = 'in-2'")).toHaveLength(0); // e-mail pessoal não é guardado
    const inbound = (await q("SELECT classification FROM messages WHERE gmail_message_id = 'in-1'"))[0];
    expect(inbound.classification).toBe('unsubscribe');
    expect(await q("SELECT * FROM suppression_list WHERE value = 'comercial@construtorareal.com.br'")).toHaveLength(1);
    const lead = (await q('SELECT stage FROM leads WHERE id = ?', msg.lead_id))[0];
    expect(lead.stage).toBe('nao_contatar');
    // rodar o inbox de novo não duplica
    await api('POST', '/api/jobs/run', { type: 'inbox' });
    expect(await q("SELECT id FROM messages WHERE gmail_message_id = 'in-1'")).toHaveLength(1);
    // follow-up e novos envios não acontecem para quem pediu para sair
    await env.DB.prepare("UPDATE leads SET last_contact_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").bind(msg.lead_id).run();
    await api('POST', '/api/jobs/run', { type: 'followup' });
    expect(sent).toHaveLength(1);
    // resposta manual também é barrada
    expect((await api('POST', `/api/conversations/${msg.conversation_id}/reply`, { body: 'Oi de novo' })).status).toBe(400);
  });

  it('link de descadastro (GET mostra, POST confirma)', async () => {
    const draft = (await q("SELECT body_text FROM messages WHERE to_addr = 'contato@horizonteconstrutora.com.br' AND kind = 'initial'"))[0];
    const path = /\/u\/[\w.-]+/.exec(draft.body_text)[0];
    const page = await api('GET', path, null, { raw: true });
    expect(await page.text()).toContain('Confirmar descadastro');
    const done = await api('POST', path, '', { raw: true });
    expect(done.status).toBe(200);
    expect(await q("SELECT reason FROM suppression_list WHERE value = 'contato@horizonteconstrutora.com.br'")).toEqual([{ reason: 'unsubscribe' }]);
    const bad = await api('GET', '/u/forjado.assinatura', null, { raw: true });
    expect(bad.status).toBe(400);
  });
});

describe('interesse → Closer → agendamento (Calendar simulado)', () => {
  it('responde com link, reserva horário real, confere o evento e permite cancelar', async () => {
    await connectFakeGoogle('eu@estudio.com');
    const sent = [];
    const events = [];
    const f = fakeFetch([
      robots404,
      site('larimoveis.com.br', SITE_BOM('Lar Imóveis', 'contato@larimoveis.com.br').replace('<meta name="description" content="Lar Imóveis">', '')),
      ['gmail.googleapis.com/gmail/v1/users/me/messages/send', (url, init) => { sent.push(decodeRaw(init)); return { id: `s${sent.length}`, threadId: 'thread-lar' }; }],
      [/messages\?/, () => ({ messages: [{ id: 'lar-1' }] })],
      [/messages\/lar-1/, () => ({ id: 'lar-1', threadId: 'thread-lar', internalDate: String(Date.now()), payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'contato@larimoveis.com.br' }, { name: 'Subject', value: 'Re: Lar Imóveis' }, { name: 'Message-ID', value: '<lar@mail>' }], body: { data: btoa('Podemos conversar sim. Qual horario voce tem?') } } })],
      ['calendar/v3/freeBusy', () => ({ calendars: { primary: { busy: [] } } })],
      [/calendar\/v3\/calendars\/primary\/events\?/, (url, init) => { events.push(JSON.parse(init.body)); return { id: 'evt-1', status: 'confirmed' }; }],
      [/calendar\/v3\/calendars\/primary\/events\/evt-1\?sendUpdates/, () => new Response(null, { status: 204 })],
      [/calendar\/v3\/calendars\/primary\/events\/evt-1$/, () => ({ id: 'evt-1', status: 'confirmed', htmlLink: 'https://calendar.google.com/evt-1', hangoutLink: 'https://meet.google.com/abc' })],
    ]);
    api.setFetch(f);
    const s = (await api('GET', '/api/settings')).data.settings;
    await api('PUT', '/api/settings/closer', { auto_reply_meeting: true });
    if (s.outreach.mode !== 'live') await api('POST', '/api/outreach/approve-live', { confirm: 'ATIVAR' });
    await api('POST', '/api/import', { text: 'Lar Imóveis; larimoveis.com.br; Joinville; SC; imobiliaria' });
    await api('POST', '/api/jobs/run', { type: 'investigate' });
    await api('POST', '/api/jobs/run', { type: 'score' });
    await api('POST', '/api/jobs/run', { type: 'prepare' });
    await openWindow(api);
    await env.DB.prepare("UPDATE messages SET sent_at = '2020-01-01T00:00:00.000Z', created_at = '2020-01-01T00:00:00.000Z' WHERE status IN ('sent','simulated')").run();
    await api('POST', '/api/jobs/run', { type: 'outreach' });
    expect(sent).toHaveLength(1);
    await env.DB.prepare("UPDATE integrations SET inbox_cursor = ?").bind(String(Math.floor(Date.now() / 1000) - 600)).run();
    const ib = await api('POST', '/api/jobs/run', { type: 'inbox' });
    expect(ib.data.summary.ran[0].result).toMatchObject({ ingested: 1, auto_replied: 1 });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('In-Reply-To: <lar@mail>');
    const reply = bodyOfMime(sent[1]);
    expect(reply).not.toMatch(/R\$/);
    const token = /\/agendar\/([\w-]+)/.exec(reply)[1];
    const leadId = (await q("SELECT l.id FROM leads l JOIN companies c ON c.id = l.company_id WHERE c.name = 'Lar Imóveis'"))[0].id;
    expect((await q('SELECT stage FROM leads WHERE id = ?', leadId))[0].stage).toBe('interessado');

    const page = await (await api('GET', `/agendar/${token}`, null, { raw: true })).text();
    const slot = /name="slot" value="([^"]+)"/.exec(page)[1];
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)[1];
    // formulário sem o código do formulário é recusado
    expect((await api('POST', `/agendar/${token}`, `slot=${encodeURIComponent(slot)}&email=contato%40larimoveis.com.br`, { raw: true })).status).toBe(403);
    const book = await api('POST', `/agendar/${token}`, `csrf=${encodeURIComponent(csrf)}&slot=${encodeURIComponent(slot)}&email=contato%40larimoveis.com.br`, { raw: true });
    expect(book.status).toBe(303);
    expect(events[0]).toMatchObject({ attendees: [{ email: 'contato@larimoveis.com.br' }], start: { dateTime: slot } });
    const appt = (await q('SELECT * FROM appointments WHERE lead_id = ?', leadId))[0];
    expect(appt).toMatchObject({ status: 'booked', calendar_event_id: 'evt-1', starts_at: slot });
    expect((await q('SELECT stage FROM leads WHERE id = ?', leadId))[0].stage).toBe('reuniao_agendada');
    expect(sent.length).toBe(3); // confirmação por e-mail
    const confirmed = await (await api('GET', `/agendar/${token}`, null, { raw: true })).text();
    expect(confirmed).toContain('Reunião confirmada');

    const cancel = await api('POST', `/agendar/${token}/cancelar`, `csrf=${encodeURIComponent(csrf)}`, { raw: true });
    expect(cancel.status).toBe(303);
    expect(f.calls.some((c) => c.init?.method === 'DELETE' && c.url.includes('events/evt-1'))).toBe(true);
    expect((await q('SELECT status FROM appointments WHERE id = ?', appt.id))[0].status).toBe('offered');
    expect((await q('SELECT stage FROM leads WHERE id = ?', leadId))[0].stage).toBe('interessado');
    await api('POST', '/api/outreach/simulation');
  });

  it('não confirma reunião se o evento não existir na agenda', async () => {
    const leadId = (await q("SELECT l.id FROM leads l JOIN companies c ON c.id = l.company_id WHERE c.name = 'Lar Imóveis'"))[0].id;
    const { createBookingOffer } = await import('../src/agents/closer.js');
    const ctx = createContext(env, { fetchFn: fakeFetch([
      ['oauth2.googleapis.com/token', () => ({ access_token: 'x', expires_in: 3600 })],
      ['calendar/v3/freeBusy', () => ({ calendars: { primary: { busy: [] } } })],
      [/events\?/, () => ({ id: 'evt-fantasma' })],
      [/events\/evt-fantasma$/, () => ({ id: 'evt-fantasma', status: 'cancelled' })],
    ]) });
    const url = await createBookingOffer(ctx, { id: leadId }, null, 'America/Sao_Paulo');
    const token = url.split('/agendar/')[1];
    const { findAppointment, availableSlots, bookSlot } = await import('../src/agents/scheduler.js');
    const { getSettings } = await import('../src/db.js');
    const appt = await findAppointment(ctx, token);
    const slots = await availableSlots(ctx, await getSettings(ctx));
    const r = await bookSlot(ctx, appt, slots[0].start, 'contato@larimoveis.com.br');
    expect(r.ok).toBe(false);
    expect((await q('SELECT status FROM appointments WHERE id = ?', appt.id))[0].status).toBe('offered');
  });
});

describe('cron e execução autônoma', () => {
  it('agendador central roda a tarefa vencida uma vez por dia (com recuperação de atraso)', async () => {
    await env.DB.prepare("UPDATE schedules SET enabled = 0").run();
    await env.DB.prepare("UPDATE schedules SET enabled = 1, days = '0,1,2,3,4,5,6', start_time = '00:00', end_time = NULL, interval_minutes = 0, last_run_date = NULL, paused_until = NULL WHERE task = 'report'").run();
    const run = async () => {
      const ctx = createExecutionContext();
      await worker.scheduled(createScheduledController({ scheduledTime: Date.now(), cron: '* * * * *' }), env, ctx);
      await waitOnExecutionContext(ctx);
    };
    await run();
    const jobs = await q("SELECT status FROM automation_jobs WHERE type = 'report'");
    expect(jobs.map((j) => j.status)).toContain('done');
    await run();
    expect(await q("SELECT id FROM automation_jobs WHERE type = 'report'")).toHaveLength(jobs.length);
  });

  it('pausa não roda prospecção; pausa emergencial não roda nada', async () => {
    await env.DB.prepare("UPDATE schedules SET enabled = 1, days = '0,1,2,3,4,5,6', start_time = '00:00', end_time = '23:59', interval_minutes = 1, last_run_at = NULL WHERE task IN ('outreach','inbox')").run();
    await api('POST', '/api/system/pause', { paused: true });
    let summary = await tick(createContext(env, { fetchFn: fakeFetch([]) }));
    expect(summary.enqueued).not.toContain('outreach');
    expect(summary.enqueued).toContain('inbox');
    await api('POST', '/api/system/emergency', { on: true });
    summary = await tick(createContext(env, { fetchFn: fakeFetch([]) }));
    expect(summary.skipped).toBe('pausa emergencial');
    expect((await api('POST', '/api/jobs/run', { type: 'inbox' })).status).toBe(409);
    await api('POST', '/api/system/emergency', { on: false });
    await api('POST', '/api/system/pause', { paused: false });
    await env.DB.prepare("UPDATE schedules SET enabled = 0").run();
  });

  it('recupera tarefas interrompidas', async () => {
    const old = new Date(Date.now() - 3600_000).toISOString();
    await env.DB.prepare("INSERT INTO automation_jobs (type, payload, status, attempts, run_after, locked_at, created_at, updated_at) VALUES ('report', '{}', 'running', 1, ?, ?, ?, ?)").bind(old, old, old, old).run();
    await env.DB.prepare("INSERT INTO companies (name, normalized_name, source, research_status, research_attempts, discovered_at, created_at, updated_at) VALUES ('Travada Ltda', 'travada ltda', 'manual', 'investigating', 1, ?, ?, ?)").bind(old, old, old).run();
    await tick(createContext(env, { fetchFn: fakeFetch([robots404]) }), { maxJobs: 0 });
    expect((await q("SELECT status FROM automation_jobs WHERE locked_at IS NULL AND created_at = ?", old))[0].status).toBe('pending');
    expect((await q("SELECT research_status FROM companies WHERE name = 'Travada Ltda'"))[0].research_status).toBe('pending');
  });

  it('ao atingir um limite pausa só a tarefa afetada e avisa', async () => {
    const s = (await api('GET', '/api/settings')).data.settings;
    await api('PUT', '/api/settings/limits', { ...s.limits, overpass_daily: 0 });
    await api('POST', '/api/discover', { state: 'SC', city: 'Blumenau', segment: 'advocacia', run_now: true });
    const sched = (await q("SELECT paused_until, paused_reason FROM schedules WHERE task = 'discover'"))[0];
    expect(sched.paused_until).toBeTruthy();
    expect(sched.paused_reason).toMatch(/Limite diário/);
    expect((await q("SELECT paused_until FROM schedules WHERE task = 'inbox'"))[0].paused_until).toBe(null);
    expect((await q("SELECT id FROM automation_logs WHERE level = 'alert' AND message LIKE '%discover%pausada%'")).length).toBeGreaterThan(0);
    await api('PUT', '/api/settings/limits', s.limits);
    await api('POST', '/api/schedules/discover/resume');
  });
});

describe('lista de exclusão pelo painel', () => {
  it('nova regra reaplica nas empresas ainda não contatadas', async () => {
    const r = await api('POST', '/api/exclusions', { type: 'keyword', value: 'advogados', reason: 'teste' });
    expect(r.data.affected).toBeGreaterThanOrEqual(1);
    expect((await q("SELECT exclusion_status FROM companies WHERE name = 'Lima Advogados'"))[0].exclusion_status).toBe('block');
    const t = await api('POST', '/api/exclusions/test', { name: 'Clínica Odonto Vida' });
    expect(t.data.verdict).toBe('block');
    const sys = (await q("SELECT id FROM exclusion_rules WHERE is_system = 1 LIMIT 1"))[0];
    expect((await api('DELETE', `/api/exclusions/${sys.id}`)).status).toBe(400);
  });
});

describe('saúde para o vigia externo', () => {
  it('aponta Cron parado, Google expirado e pausa emergencial', async () => {
    const pub = client();
    await env.DB.prepare("UPDATE settings SET updated_at = '2020-01-01T00:00:00.000Z' WHERE key = 'engine_lock'").run();
    await env.DB.prepare("UPDATE integrations SET status = 'expired' WHERE provider = 'google'").run();
    let h = (await pub('GET', '/api/health')).data;
    expect(h.ok).toBe(true);
    expect(h.attention).toEqual(expect.arrayContaining(['cron_parado', 'google_expirado']));
    await tick(createContext(env, { fetchFn: fakeFetch([]) }), { maxJobs: 0 });
    await env.DB.prepare("UPDATE integrations SET status = 'connected' WHERE provider = 'google'").run();
    h = (await pub('GET', '/api/health')).data;
    expect(h.attention).toEqual([]);
    expect(JSON.stringify(h)).not.toMatch(/token|@/);
  });
});
