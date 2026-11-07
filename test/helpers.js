// Utilidades de teste: fetch falso por URL e chamadas autenticadas ao Worker.
import { env } from 'cloudflare:workers';
import { handle } from '../src/index.js';
import { isValidCnpj } from '../src/agents/investigator.js';

export { normalize, inWindow, zonedToUtc, localDate } from '../src/util.js';
export const isValidCnpjExport = isValidCnpj;

/** routes: [[substring|RegExp, (url, init) => Response | object]]. Registra as chamadas em .calls */
export function fakeFetch(routes) {
  const calls = [];
  const fn = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, init });
    for (const [m, h] of routes) {
      if (typeof m === 'string' ? url.includes(m) : m.test(url)) {
        const out = await h(url, init);
        if (out instanceof Response) return out;
        return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    }
    return new Response('not mocked: ' + url, { status: 599 });
  };
  fn.calls = calls;
  return fn;
}

export function htmlResponse(body, url) {
  const r = new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  Object.defineProperty(r, 'url', { value: url });
  return r;
}

export function client(fetchFn = fakeFetch([])) {
  let cookie = '';
  let csrf = '';
  const api = async (method, path, body, { raw = false, headers = {} } = {}) => {
    const req = new Request('http://localhost' + path, {
      method,
      headers: { 'content-type': typeof body === 'string' ? 'application/x-www-form-urlencoded' : 'application/json', cookie, 'x-csrf-token': csrf, origin: 'http://localhost', ...headers },
      body: body == null ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      redirect: 'manual',
    });
    const waits = [];
    const res = await handle(req, env, { waitUntil: (p) => waits.push(p) }, fetchFn);
    await Promise.all(waits);
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    if (raw) return res;
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    if (data?.csrf) csrf = data.csrf;
    return { status: res.status, data, headers: res.headers };
  };
  api.setFetch = (f) => { fetchFn = f; };
  api.cookie = () => cookie;
  return api;
}

export async function setupAdmin(api) {
  const r = await api('POST', '/api/setup', { setup_token: env.SETUP_TOKEN, email: 'admin@teste.com', name: 'Admin', password: 'senha-forte-123' });
  if (r.status !== 201) throw new Error('setup falhou: ' + JSON.stringify(r.data));
  await api('PUT', '/api/settings/sender', { name: 'Matheus', company: 'Estúdio M', email: 'eu@estudio.com', website: 'https://estudio.com' });
  return r;
}

export async function q(sql, ...params) {
  return (await env.DB.prepare(sql).bind(...params).all()).results;
}
