// Núcleo do painel: API, template seguro (escapa tudo), ícones, toasts, sheet, formatação.

// ---------- template seguro ----------
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(String(s ?? ''));
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const val = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(val).join('') : v == null || v === false ? '' : esc(v));
/** html`...${x}...` — interpolações são escapadas, exceto raw(...) ou outro html`` */
export const html = (strings, ...vals) => raw(strings.reduce((acc, s, i) => acc + s + (i < vals.length ? val(vals[i]) : ''), ''));

export function mount(el, view) {
  el.innerHTML = view instanceof Raw ? view.s : esc(view);
  // larguras de barras sem style inline (CSP): data-w="42" → --w: 42%
  el.querySelectorAll('[data-w]').forEach((n) => n.style.setProperty('--w', `${Math.max(0, Math.min(100, +n.dataset.w || 0))}%`));
}

// ---------- API ----------
let csrf = '';
export const setCsrf = (t) => { csrf = t || ''; };
export class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  let data = null;
  try { data = await res.json(); } catch { /* sem corpo */ }
  if (data?.csrf) csrf = data.csrf;
  if (!res.ok) {
    if (res.status === 401 && !['/api/login', '/api/setup', '/api/me'].some((p) => path.startsWith(p))) window.dispatchEvent(new CustomEvent('auth:required'));
    throw new ApiError(res.status, data?.error || `Erro ${res.status}`);
  }
  return data;
}

// ---------- ícones (traço 1.8, 24×24) ----------
const P = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>',
  building: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 7h1M14 7h1M9 11h1M14 11h1M9 15h1M14 15h1"/><path d="M10 21v-3h4v3"/>',
  pipeline: '<rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="11" rx="1.5"/><rect x="17" y="4" width="4" height="7" rx="1.5"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/>',
  shield: '<path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6l-8-3Z"/><path d="m9 12 2 2 4-4"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  gauge: '<path d="M12 14 16 9"/><path d="M3.5 18a9 9 0 1 1 17 0"/><circle cx="12" cy="14" r="1.5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  chev: '<path d="m9 6 6 6-6 6"/>',
  back: '<path d="m15 6-6 6 6 6"/>',
  play: '<path d="M7 5v14l12-7L7 5Z"/>',
  pause: '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  alert: '<path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 3 2.5 15 0 18M12 3c-2.5 3-2.5 15 0 18"/>',
  logout: '<path d="M15 4h4v16h-4"/><path d="M10 8 6 12l4 4M6 12h10"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="m6 6 12 12"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  send: '<path d="M21 3 10 14M21 3l-7 18-4-7-7-4 18-7Z"/>',
  link: '<path d="M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1"/><path d="M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1"/>',
};
export const icon = (name, cls = '') => raw(`<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`);
export const markSvg = raw('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19 12 4l8 15" fill="none" stroke="#e2b04a" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="15" r="2.2" fill="#e2b04a"/></svg>');

// ---------- toasts ----------
export function toast(msg, kind = '') {
  let box = document.querySelector('.toasts');
  if (!box) { box = document.createElement('div'); box.className = 'toasts'; box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite'); document.body.append(box); }
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  box.append(t);
  setTimeout(() => t.remove(), kind === 'bad' ? 6000 : 3200);
}
export const fail = (e) => toast(e?.message || String(e), 'bad');

// ---------- sheet (gaveta no celular, painel lateral no desktop) ----------
let sheetState = null;
export function openSheet(title, render) {
  closeSheet(true);
  const back = document.createElement('div');
  back.className = 'sheet-backdrop';
  const sheet = document.createElement('section');
  sheet.className = 'sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', title);
  sheet.innerHTML = `<div class="sheet-grab"></div><div class="sheet-head"><h2 class="grow ellipsis"></h2><button class="icon-btn" data-close aria-label="Fechar">${icon('x').s}</button></div><div class="sheet-body"></div>`;
  sheet.querySelector('h2').textContent = title;
  document.body.append(back, sheet);
  const prevFocus = document.activeElement;
  const close = () => closeSheet();
  back.addEventListener('click', close);
  sheet.querySelector('[data-close]').addEventListener('click', close);
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  sheetState = { back, sheet, onKey, prevFocus };
  document.body.style.overflow = 'hidden';
  requestAnimationFrame(() => { back.classList.add('open'); sheet.classList.add('open'); sheet.querySelector('[data-close]').focus(); });
  const body = sheet.querySelector('.sheet-body');
  render(body, close);
  return { body, close, setTitle: (t) => { sheet.querySelector('h2').textContent = t; } };
}
export function closeSheet(instant = false) {
  if (!sheetState) return;
  const { back, sheet, onKey, prevFocus } = sheetState;
  sheetState = null;
  document.removeEventListener('keydown', onKey);
  document.body.style.overflow = '';
  if (instant) { back.remove(); sheet.remove(); return; }
  back.classList.remove('open'); sheet.classList.remove('open');
  setTimeout(() => { back.remove(); sheet.remove(); }, 260);
  prevFocus?.focus?.();
}

// ---------- formatação ----------
export const TZ = 'America/Sao_Paulo';
export const fmtInt = (n) => (n == null ? '—' : new Intl.NumberFormat('pt-BR').format(n));
export const fmtPct = (x) => (x == null ? '—' : `${(x * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`);
export function fmtDate(iso, opts = { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, ...opts }).format(new Date(iso));
}
export function fmtRel(iso) {
  if (!iso) return '—';
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'agora';
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  if (s < 86400 * 7) return `há ${Math.floor(s / 86400)} d`;
  return fmtDate(iso, { day: '2-digit', month: 'short' });
}

export const STAGE_LABEL = {};
export const META = { stages: [], services: {}, segments: {}, classes: {} };
export function setMeta(m) {
  Object.assign(META, m);
  for (const [k, l] of m.stages) STAGE_LABEL[k] = l;
}
export const PRIORITY = { alta: ['Alta', 'ok'], media: ['Média', 'accent'], baixa: ['Baixa', 'warn'], nao_automatico: ['Manual', ''] };
export const EXCL = { allow: ['Liberada', 'ok'], review: ['Em revisão', 'warn'], block: ['Bloqueada', 'bad'], approved: ['Liberada manualmente', 'info'] };
export const stageChip = (s) => html`<span class="chip ${s === 'interessado' || s === 'reuniao_agendada' || s === 'convertido' ? 'ok' : s === 'perdido' || s === 'nao_contatar' ? 'bad' : s === 'contatado' || s === 'respondeu' ? 'info' : ''}">${STAGE_LABEL[s] || s}</span>`;
export const priorityChip = (p) => (p ? html`<span class="chip ${PRIORITY[p]?.[1] || ''}">${PRIORITY[p]?.[0] || p}</span>` : '');
export const exclChip = (x) => (x && x !== 'allow' ? html`<span class="chip ${EXCL[x]?.[1]}">${EXCL[x]?.[0] || x}</span>` : '');
export const scoreBox = (score, priority, big = false) => html`<span class="score ${priority || ''} ${big ? 'big' : ''}" aria-label="Pontuação ${score ?? 'sem nota'}">${score ?? '–'}</span>`;

export function formData(form) {
  const out = {};
  const fd = new FormData(form);
  for (const [k, v] of fd) {
    if (k.endsWith('[]')) { const key = k.slice(0, -2); (out[key] ||= []).push(v); }
    else out[k] = v;
  }
  form.querySelectorAll('input[type=checkbox][name]:not([name$="[]"])').forEach((c) => { out[c.name] = c.checked; });
  return out;
}

export const DAY_LABELS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
export const daysPicker = (name, selected) => html`<div class="days" role="group">${DAY_LABELS.map((d, i) => html`<label><input type="checkbox" name="${name}[]" value="${i}" ${String(selected).split(',').map(Number).includes(i) || (Array.isArray(selected) && selected.includes(i)) ? raw('checked') : ''}><span>${d}</span></label>`)}</div>`;
export const sw = (name, checked, label) => html`<label class="switch"><input type="checkbox" name="${name}" ${checked ? raw('checked') : ''}><i></i><span>${label}</span></label>`;

export function busy(btn, on) {
  if (!btn) return;
  if (on) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="spin"></span>'; }
  else { btn.disabled = false; if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
}

export function confirmText(message) { return window.confirm(message); }
