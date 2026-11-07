// Publicação e vigilância automáticas (usado pelo GitHub Actions).
//
//   node scripts/ci-deploy.mjs deploy   cria o D1 se faltar, gera a config, aplica migrations, publica,
//                                       sincroniza segredos e confere a saúde
//   node scripts/ci-deploy.mjs check    só confere a saúde (vigia agendado)
//
// Precisa de CLOUDFLARE_API_TOKEN e CLOUDFLARE_ACCOUNT_ID no ambiente.
// Opcionais: APP_URL (domínio próprio), SETUP_TOKEN, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, PSI_API_KEY.
// Nenhum valor de segredo é impresso.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const NAME = 'aureon-sales-engine';
const DB = 'aureon';
const CONFIG = 'wrangler.ci.jsonc';
const { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT } = process.env;
const mode = process.argv[2] || 'deploy';

const log = (m) => console.log(`» ${m}`);
const die = (m) => { console.log(`::error::${m}`); process.exit(1); };
if (!TOKEN || !ACCOUNT) die('Faltam os segredos CLOUDFLARE_API_TOKEN e/ou CLOUDFLARE_ACCOUNT_ID no repositório (Settings → Secrets and variables → Actions).');

async function cf(path, init = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${path}`, {
    ...init, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
  });
  const j = await res.json().catch(() => ({}));
  if (!j.success) {
    const err = new Error(`Cloudflare API ${path} → HTTP ${res.status}: ${JSON.stringify(j.errors || [])}`);
    err.status = res.status;
    throw err;
  }
  return j.result;
}

function wrangler(args, input) {
  const r = spawnSync('npx', ['wrangler', ...args], { stdio: input ? ['pipe', 'inherit', 'inherit'] : 'inherit', input, env: process.env, shell: process.platform === 'win32' });
  if (r.status !== 0) die(`wrangler ${args.join(' ')} falhou (código ${r.status}).`);
}

async function appUrl() {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  let sub;
  try { sub = (await cf('/workers/subdomain')).subdomain; } catch (e) { sub = null; }
  if (!sub) die('A conta ainda não tem subdomínio workers.dev. Abra dash.cloudflare.com → Workers & Pages uma vez (ele é criado no primeiro acesso) e rode o workflow de novo.');
  return `https://${NAME}.${sub}.workers.dev`;
}

async function ensureDatabase() {
  const list = await cf(`/d1/database?name=${DB}`);
  const found = (list || []).find((d) => d.name === DB);
  if (found) { log(`Banco D1 "${DB}" já existe`); return found.uuid; }
  const created = await cf('/d1/database', { method: 'POST', body: JSON.stringify({ name: DB }) });
  log(`Banco D1 "${DB}" criado`);
  return created.uuid;
}

function writeConfig(dbId, url) {
  let c = readFileSync('wrangler.jsonc', 'utf8');
  c = c.replace(/"database_id":\s*"[^"]*"/, `"database_id": "${dbId}"`);
  c = c.replace(/"APP_URL":\s*"[^"]*"/, `"APP_URL": "${url}"`);
  writeFileSync(CONFIG, c);
}

async function syncSecrets() {
  let existing = [];
  try { existing = (await cf(`/workers/scripts/${NAME}/secrets`)).map((s) => s.name); } catch { existing = []; }
  const bulk = {};
  // chave de criptografia: gerada uma única vez e nunca trocada (trocar invalida tokens e links já enviados)
  if (!existing.includes('ENCRYPTION_KEY')) { bulk.ENCRYPTION_KEY = randomBytes(32).toString('base64'); log('ENCRYPTION_KEY gerada (primeira publicação)'); }
  for (const k of ['SETUP_TOKEN', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'PSI_API_KEY']) {
    if (process.env[k]) bulk[k] = process.env[k];
  }
  const names = Object.keys(bulk);
  if (!names.length) { log('Segredos já configurados'); return existing; }
  const file = '.secrets.ci.json';
  writeFileSync(file, JSON.stringify(bulk), { mode: 0o600 });
  try { wrangler(['secret', 'bulk', file, '--config', CONFIG]); } finally { rmSync(file, { force: true }); }
  log(`Segredos sincronizados: ${names.join(', ')}`);
  return [...new Set([...existing, ...names])];
}

async function health(url, { attempts = 12 } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(`${url}/api/health`, { headers: { 'cache-control': 'no-cache' } });
      last = await r.json();
      if (r.ok && last.ok) return last;
    } catch (e) { last = { error: e.message }; }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return last || { ok: false };
}

const url = await appUrl();

if (mode === 'check') {
  const h = await health(url, { attempts: 3 });
  console.log(JSON.stringify(h, null, 2));
  if (!h.ok) die(`O sistema não respondeu em ${url}/api/health.`);
  const problems = h.attention || [];
  if (problems.length) die(`Atenção em ${url}: ${problems.join(', ')}. Abra o painel para resolver.`);
  log(`Tudo certo em ${url} (último ciclo do Cron: ${h.last_tick_at})`);
  process.exit(0);
}

const dbId = await ensureDatabase();
writeConfig(dbId, url);
try {
  wrangler(['d1', 'migrations', 'apply', DB, '--remote', '--config', CONFIG]);
  wrangler(['deploy', '--config', CONFIG]);
  const secrets = await syncSecrets();
  const h = await health(url);
  if (!h.ok) die(`Publicado, mas ${url}/api/health não respondeu ok: ${JSON.stringify(h)}`);
  const missing = ['SETUP_TOKEN', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'].filter((k) => !secrets.includes(k));
  if (missing.length) console.log(`::warning::Publicado, mas faltam segredos no GitHub: ${missing.join(', ')}. Sem SETUP_TOKEN não dá para criar o administrador; sem Google não há envio nem agenda.`);
  console.log(`::notice::Aureon publicado em ${url}`);
  log(`URL: ${url}`);
} finally {
  rmSync(CONFIG, { force: true });
}
