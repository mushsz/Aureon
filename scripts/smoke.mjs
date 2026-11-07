// Teste de fumaça ponta a ponta contra um Worker rodando (local ou publicado).
// Uso: node scripts/smoke.mjs [BASE_URL]   (lê SETUP_TOKEN de .dev.vars se precisar criar o admin)
// Faz consultas reais (OpenStreetMap, sites das empresas). E-mails ficam em modo simulação.

import { readFileSync } from 'node:fs';

const BASE = process.argv[2] || 'http://localhost:8787';
const env = Object.fromEntries(readFileSync('.dev.vars', 'utf8').split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const ADMIN = { email: process.env.SMOKE_EMAIL || 'admin@aureon.local', password: process.env.SMOKE_PASSWORD || 'senha-de-teste-123', name: 'Admin Teste' };

let cookie = '';
let csrf = '';
async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf, origin: BASE },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (data?.csrf) csrf = data.csrf;
  return { status: res.status, data };
}
const ok = (label, cond, extra = '') => { console.log(`${cond ? '✔' : '✘'} ${label}${extra ? ' — ' + extra : ''}`); if (!cond) process.exitCode = 1; };

const status = await call('GET', '/api/setup/status');
if (status.data.needsSetup) {
  const r = await call('POST', '/api/setup', { setup_token: env.SETUP_TOKEN, ...ADMIN });
  ok('cria administrador', r.status === 201, JSON.stringify(r.data));
} else {
  const r = await call('POST', '/api/login', ADMIN);
  ok('login', r.status === 200, r.status === 200 ? '' : JSON.stringify(r.data));
}
const me = await call('GET', '/api/me');
ok('sessão ativa', me.status === 200 && me.data.user?.email === ADMIN.email);
const noCsrf = await fetch(BASE + '/api/system/pause', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{"paused":true}' });
ok('bloqueia POST sem CSRF', noCsrf.status === 403);
const anon = await fetch(BASE + '/api/dashboard');
ok('bloqueia API sem login', anon.status === 401);

const sender = await call('PUT', '/api/settings/sender', { name: 'Matheus Teste', company: 'Estúdio Teste', email: 'teste@example.com', website: 'https://example.com', phone: '' });
ok('salva remetente', sender.status === 200, sender.status === 200 ? '' : JSON.stringify(sender.data));

const disc = await call('POST', '/api/discover', { country: 'BR', state: 'SC', city: 'Joinville', segment: 'construcao', max: 6, run_now: true });
const ran = disc.data.summary?.ran?.[0];
ok('Finder: descoberta real no OSM', disc.status === 200 && ran?.ok, JSON.stringify(ran?.result || ran?.error || disc.data));

const health = await call('POST', '/api/discover', { country: 'BR', state: 'SC', city: 'Joinville', segment: 'auto', company_type: 'amenity=dentist', max: 5, require_website: false, run_now: true });
const hr = health.data.summary?.ran?.[0]?.result;
ok('Filtro de saúde: dentistas reais bloqueados', hr && hr.inserted > 0 ? hr.blocked === hr.inserted : true, JSON.stringify(hr));

for (let i = 0; i < 4; i++) {
  const inv = await call('POST', '/api/jobs/run', { type: 'investigate' });
  const j = inv.data.summary?.ran?.[0];
  ok(`Investigator rodada ${i + 1}`, j?.ok, JSON.stringify(j?.result || j?.error));
  if (!j?.result?.processed) break;
}
const sc = await call('POST', '/api/jobs/run', { type: 'score' });
ok('Scorer + Contact Finder', sc.data.summary?.ran?.[0]?.ok, JSON.stringify(sc.data.summary?.ran?.[0]?.result));

const prep = await call('POST', '/api/jobs/run', { type: 'prepare' });
ok('Copywriter', prep.data.summary?.ran?.[0]?.ok, JSON.stringify(prep.data.summary?.ran?.[0]?.result || prep.data.summary?.ran?.[0]?.error));

const settings = (await call('GET', '/api/settings')).data.settings;
const o = settings.outreach;
const out1 = await call('POST', '/api/jobs/run', { type: 'outreach' });
console.log('  outreach com a janela padrão:', JSON.stringify(out1.data.summary?.ran?.[0]?.result));
// abre a janela temporariamente só para testar a simulação, e restaura depois
await call('PUT', '/api/settings/outreach', { ...o, days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:59', min_minutes_between: 2 });
const out2 = await call('POST', '/api/jobs/run', { type: 'outreach' });
ok('Outreach em simulação', out2.data.summary?.ran?.[0]?.ok, JSON.stringify(out2.data.summary?.ran?.[0]?.result));
await call('PUT', '/api/settings/outreach', o);

const dash = await call('GET', '/api/dashboard');
ok('Dashboard com dados reais', dash.status === 200, JSON.stringify(dash.data.metrics));
const companies = await call('GET', '/api/companies?sort=score');
ok('Lista de empresas', companies.data.items?.length > 0, `${companies.data.total} empresas`);
const first = companies.data.items?.find((c) => c.score != null);
if (first) {
  const det = await call('GET', `/api/companies/${first.id}`);
  ok('Detalhe com evidências e pontuação', !!det.data.analysis && !!det.data.score, `${det.data.company.name}: ${det.data.score?.score} pts, ${det.data.analysis?.findings?.length} achados`);
  console.log('\n' + det.data.score?.explanation + '\n');
  const msg = det.data.messages?.[0];
  if (msg) console.log(`--- ${msg.status.toUpperCase()} para ${msg.to_addr}\nAssunto: ${msg.subject}\n\n${msg.body_text}\n---\n`);
}
const conv = await call('GET', '/api/conversations');
ok('Conversas', conv.status === 200, `${conv.data.items?.length} conversa(s)`);
const usage = await call('GET', '/api/usage');
ok('Painel de uso', usage.status === 200, `${usage.data.rows?.length} métricas`);
const emerg = await call('POST', '/api/system/emergency', { on: true });
const blocked = await call('POST', '/api/jobs/run', { type: 'investigate' });
ok('Pausa emergencial bloqueia execução', emerg.status === 200 && blocked.status === 409);
await call('POST', '/api/system/emergency', { on: false });
await call('POST', '/api/system/pause', { paused: false });
