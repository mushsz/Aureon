// HTTP: respostas, cabeçalhos de segurança, validação simples, roteador mínimo.

export class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://accounts.google.com",
};

export function withSecurity(res) {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!r.headers.has(k)) r.headers.set(k, v);
  return r;
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
}

export function html(body, status = 200, headers = {}) {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers } });
}

export function redirect(location, status = 302, headers = {}) {
  return new Response(null, { status, headers: { location, ...headers } });
}

export async function readJson(request, maxBytes = 200_000) {
  const len = +(request.headers.get('content-length') || 0);
  if (len > maxBytes) throw new HttpError(413, 'Corpo da requisição grande demais');
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, 'Corpo da requisição grande demais');
  if (!text) return {};
  try { const v = JSON.parse(text); if (v && typeof v === 'object') return v; } catch { /* abaixo */ }
  throw new HttpError(400, 'JSON inválido');
}

// Validação: v.str(body.x, {min, max, required}) etc. Lança HttpError(400).
export const v = {
  str(val, { name = 'campo', min = 0, max = 500, required = false, pattern = null } = {}) {
    if (val == null || val === '') { if (required) throw new HttpError(400, `${name} é obrigatório`); return ''; }
    if (typeof val !== 'string' && typeof val !== 'number') throw new HttpError(400, `${name} inválido`);
    const s = String(val).trim();
    if (s.length < min || s.length > max) throw new HttpError(400, `${name} deve ter entre ${min} e ${max} caracteres`);
    if (pattern && !pattern.test(s)) throw new HttpError(400, `${name} em formato inválido`);
    return s;
  },
  int(val, { name = 'campo', min = -1e9, max = 1e9, def = null } = {}) {
    if (val == null || val === '') { if (def != null) return def; throw new HttpError(400, `${name} é obrigatório`); }
    const n = Number(val);
    if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${name} deve ser inteiro entre ${min} e ${max}`);
    return n;
  },
  bool: (val) => val === true || val === 'true' || val === 1 || val === '1',
  oneOf(val, list, name = 'campo') { if (!list.includes(val)) throw new HttpError(400, `${name} inválido`); return val; },
  email(val, name = 'e-mail', required = false) {
    const s = v.str(val, { name, max: 254, required }).toLowerCase();
    if (s && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) throw new HttpError(400, `${name} inválido`);
    return s;
  },
  hm(val, name = 'horário') { const s = v.str(val, { name, required: true, max: 5 }); if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) throw new HttpError(400, `${name} deve ser HH:MM`); return s; },
  days(val, name = 'dias') {
    const arr = Array.isArray(val) ? val : String(val ?? '').split(',');
    const out = [...new Set(arr.map((x) => Number(String(x).trim())).filter((x) => Number.isInteger(x) && x >= 0 && x <= 6))].sort();
    if (!out.length) throw new HttpError(400, `${name}: escolha ao menos um dia`);
    return out;
  },
};

export class Router {
  constructor() { this.routes = []; }
  add(method, path, handler, opts = {}) {
    const keys = [];
    const re = new RegExp('^' + path.replace(/:([a-z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, handler, opts });
    return this;
  }
  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
      const m = r.re.exec(pathname);
      if (m) return { ...r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
    }
    return null;
  }
}
