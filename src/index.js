// Ponto de entrada do Worker: HTTP (API + páginas públicas) e Cron (agendador central).

import { router } from './api.js';
import { createContext } from './db.js';
import { getSession, checkCsrf } from './auth.js';
import { HttpError, json, withSecurity } from './http.js';
import { tick } from './engine.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

async function handle(request, env, execCtx, fetchFn) {
  const url = new URL(request.url);
  const route = router.match(request.method, url.pathname);
  if (!route) {
    if (url.pathname.startsWith('/api/')) return json({ error: 'Rota não encontrada' }, 404);
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  }
  const ctx = createContext(env, { fetchFn, ip: request.headers.get('cf-connecting-ip') || null });
  ctx.metric('worker_requests');
  try {
    const session = await getSession(ctx, request);
    if (!route.opts.public && !session) throw new HttpError(401, 'Faça login.');
    if (MUTATING.has(request.method) && (!route.opts.public || (route.opts.csrfIfSession && session))) checkCsrf(request, env, session);
    if (session) ctx.actor = `user:${session.id}`;
    return await route.handler(ctx, request, route.params, session);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : e.status && e.status >= 400 && e.status < 500 ? 400 : 500;
    if (status >= 500) {
      console.error(e);
      ctx.log('error', 'api', `${request.method} ${url.pathname}: ${e.message}`);
    }
    return json({ error: status >= 500 ? 'Erro interno. Veja os logs em Automação.' : e.message }, status);
  } finally {
    execCtx?.waitUntil?.(ctx.flush().catch((err) => console.error('flush', err)));
  }
}

export default {
  async fetch(request, env, execCtx) {
    return withSecurity(await handle(request, env, execCtx));
  },
  async scheduled(controller, env, execCtx) {
    const ctx = createContext(env, { now: new Date(controller.scheduledTime || Date.now()) });
    execCtx.waitUntil(tick(ctx).catch((e) => console.error('tick', e)));
  },
};

export { handle };
