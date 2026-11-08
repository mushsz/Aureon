// Casca do app: login/instalação, navegação (hash), registro do service worker.
import { api, html, raw, mount, icon, markSvg, setCsrf, setMeta, toast, fail, formData, busy, closeSheet } from './core.js';
import * as V from './views.js';
import { today } from './today.js';

const app = document.getElementById('app');
const ROUTES = {
  '': ['Hoje', today, 'sun'],
  hoje: ['Hoje', today, 'sun'],
  resultados: ['Resultados', V.dashboard, 'chart'],
  empresas: ['Empresas', V.companies, 'building'],
  pipeline: ['Pipeline', V.pipeline, 'pipeline'],
  conversas: ['Conversas', V.conversations, 'chat'],
  mais: ['Mais', V.more, 'more'],
  agenda: ['Agenda', V.agenda, 'calendar'],
  automacao: ['Automação', V.automation, 'bolt'],
  exclusao: ['Lista de exclusão', V.exclusions, 'shield'],
  configuracoes: ['Configurações', V.settings, 'gear'],
  uso: ['Uso e limites', V.usage, 'gauge'],
};
const TABS = ['', 'resultados', 'empresas', 'conversas', 'mais'];
const SIDE = ['', 'resultados', 'empresas', 'pipeline', 'conversas', 'agenda', null, 'automacao', 'exclusao', 'configuracoes', 'uso'];
const MORE = new Set(['mais', 'pipeline', 'agenda', 'automacao', 'exclusao', 'configuracoes', 'uso']);

let user = null;
let reviewCount = 0;
let taskCount = 0;

function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = h.split('?');
  const [section = '', id] = path.split('/');
  const params = Object.fromEntries(new URLSearchParams(query));
  if (id) params.id = id;
  return { section: ROUTES[section] ? (section === 'hoje' ? '' : section) : '', params };
}

function shell(section) {
  const n = (k) => (k === 'conversas' ? reviewCount : k === '' ? taskCount : 0);
  const badge = (k) => (n(k) ? html`<span class="dot">${n(k) > 99 ? '99+' : n(k)}</span>` : '');
  mount(app, html`<div class="app">
    <nav class="sidebar" aria-label="Navegação">
      <div class="brand"><span class="brand-mark">${markSvg}</span><span>Aureon<br><small>Sales Engine</small></span></div>
      ${SIDE.map((k) => (k === null ? html`<div class="sep"></div>` : html`<a href="#/${k}" ${k === section ? raw('aria-current="page"') : ''}>${icon(ROUTES[k][2])}<span>${ROUTES[k][0]}</span>${badge(k)}</a>`))}
    </nav>
    <div>
      <header class="topbar"><div class="brand"><span class="brand-mark">${markSvg}</span><span>Aureon</span></div><div class="spacer"></div>
        <span class="small muted ellipsis">${user?.name || ''}</span></header>
      <main class="main" id="view" tabindex="-1"></main>
    </div>
    <nav class="tabbar" aria-label="Navegação principal">${TABS.map((k) => html`<a href="#/${k}" ${(k === section || (k === 'mais' && MORE.has(section))) ? raw('aria-current="page"') : ''}>${icon(ROUTES[k][2])}<span>${ROUTES[k][0]}</span>${badge(k)}</a>`)}</nav>
  </div>`);
}

async function route() {
  closeSheet(true);
  const { section, params } = parseHash();
  shell(section);
  document.title = `${ROUTES[section][0]} · Aureon`;
  const view = document.getElementById('view');
  try { await ROUTES[section][1](view, params); } catch (e) { fail(e); }
  view.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

async function refreshBadge() {
  try {
    const d = await api('GET', '/api/dashboard');
    const n = (d.metrics.needs_review || 0) + (d.metrics.conversations_review || 0);
    const t = d.metrics.tasks_open || 0;
    if (n !== reviewCount || t !== taskCount) { reviewCount = n; taskCount = t; updateBadges(); }
  } catch { /* silencioso */ }
}

// Atualiza só os selos das abas (sem redesenhar a tela, que perderia os cliques já ligados)
function updateBadges() {
  const counts = { '#/': taskCount, '#/conversas': reviewCount };
  app.querySelectorAll('.tabbar a, .sidebar a').forEach((a) => {
    const href = a.getAttribute('href');
    const n = counts[href] || 0;
    let dot = a.querySelector('.dot');
    if (!n) { dot?.remove(); return; }
    if (!dot) { dot = document.createElement('span'); dot.className = 'dot'; a.append(dot); }
    dot.textContent = n > 99 ? '99+' : String(n);
  });
}

function authScreen(needsSetup) {
  mount(app, html`<div class="auth"><div class="auth-card">
    <div class="auth-mark">${markSvg}</div>
    <div><h1>${needsSetup ? 'Instalar o Aureon' : 'Entrar'}</h1><p class="muted small">${needsSetup ? 'Crie o administrador. O código de instalação é o segredo SETUP_TOKEN configurado no Worker.' : 'Autonomous Sales Engine'}</p></div>
    <form class="card stack" id="authform">
      ${needsSetup ? html`<label class="field"><span>Código de instalação</span><input type="password" name="setup_token" required autocomplete="off"></label>
        <label class="field"><span>Seu nome</span><input type="text" name="name" required autocomplete="name"></label>` : ''}
      <label class="field"><span>E-mail</span><input type="email" name="email" required autocomplete="username"></label>
      <label class="field"><span>Senha ${needsSetup ? html`<span class="hint">12+ caracteres, letras e números</span>` : ''}</span><input type="password" name="password" required minlength="${needsSetup ? 12 : 1}" autocomplete="${needsSetup ? 'new-password' : 'current-password'}"></label>
      <button class="btn accent block" type="submit">${needsSetup ? 'Criar administrador' : 'Entrar'}</button>
    </form></div></div>`);
  const f = document.getElementById('authform');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = f.querySelector('button');
    busy(btn, true);
    try { await api('POST', needsSetup ? '/api/setup' : '/api/login', formData(f)); await boot(); }
    catch (err) { fail(err); busy(btn, false); }
  });
}

async function boot() {
  try {
    const me = await api('GET', '/api/me');
    user = me.user;
    setCsrf(me.csrf);
  } catch (e) {
    if (e.status === 401) {
      const s = await api('GET', '/api/setup/status').catch(() => ({ needsSetup: false }));
      authScreen(s.needsSetup);
      return;
    }
    mount(app, html`<div class="auth"><div class="auth-card"><div class="banner bad">${icon('alert')}<div class="grow"><strong>Sem conexão com o servidor</strong><p>${e.message}</p></div></div><button class="btn" id="retry">Tentar de novo</button></div></div>`);
    document.getElementById('retry').onclick = boot;
    return;
  }
  setMeta(await api('GET', '/api/meta'));
  await route();
  refreshBadge();
}

window.addEventListener('hashchange', () => { if (user) route(); });
window.addEventListener('auth:required', () => {
  if (!user) return; // ainda sem sessão: a própria tela de login cuida
  user = null;
  toast('Sessão expirada. Entre de novo.', 'bad');
  boot();
});
setInterval(() => { if (user && document.visibilityState === 'visible') refreshBadge(); }, 60_000);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
boot();
