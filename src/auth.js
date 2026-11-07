// Autenticação: senha PBKDF2, sessão em cookie HttpOnly (token só no cookie; no banco fica o hash),
// CSRF por token de sessão + checagem de Origin, limite de tentativas por IP e e-mail.

import { nowIso, randomToken, sha256Hex, hashPassword, verifyPassword, safeEqual } from './util.js';
import { HttpError } from './http.js';
import { auditStmt } from './db.js';

export const SESSION_COOKIE = 'ase_sid';
const SESSION_DAYS = 14;

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieAttrs(env, maxAge) {
  const secure = !String(env.APP_URL || '').startsWith('http://localhost') ? '; Secure' : '';
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

/** Limite por janela fixa, guardado no D1. Retorna true se ainda pode. */
export async function rateLimit(ctx, key, max, windowSeconds) {
  const now = Date.now();
  const windowStart = new Date(Math.floor(now / (windowSeconds * 1000)) * windowSeconds * 1000).toISOString();
  const row = await ctx.first(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT(key) DO UPDATE SET count = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.count + 1 ELSE 1 END,
       window_start = excluded.window_start
     RETURNING count`, key, windowStart,
  );
  return (row?.count || 0) <= max;
}

export function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 12) throw new HttpError(400, 'A senha precisa ter pelo menos 12 caracteres.');
  if (pw.length > 200) throw new HttpError(400, 'Senha longa demais.');
  if (!/[a-zA-Z]/.test(pw) || !/\d/.test(pw)) throw new HttpError(400, 'Use letras e números na senha.');
}

export async function createUser(ctx, { email, name, password, role = 'admin' }) {
  validatePassword(password);
  const { hash, salt, iterations } = await hashPassword(password);
  const ts = nowIso();
  const r = await ctx.run(
    'INSERT INTO users (email, name, password_hash, password_salt, password_iter, role, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
    email.toLowerCase(), name, hash, salt, iterations, role, ts, ts,
  );
  return r.last_row_id;
}

export async function createSession(ctx, request, userId) {
  const token = randomToken(32);
  const csrf = randomToken(24);
  const ts = nowIso();
  await ctx.batch([
    ctx.stmt('INSERT INTO sessions (id, user_id, csrf_token, ip, user_agent, expires_at, created_at) VALUES (?,?,?,?,?,?,?)',
      await sha256Hex(token), userId, csrf, ctx.ip, String(request.headers.get('user-agent') || '').slice(0, 200),
      new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString(), ts),
    ctx.stmt('UPDATE users SET last_login_at = ? WHERE id = ?', ts, userId),
    auditStmt(ctx, userId, 'login'),
  ]);
  return { cookie: `${SESSION_COOKIE}=${token}; ${cookieAttrs(ctx.env, SESSION_DAYS * 86400)}`, csrf };
}

export function clearCookie(env) {
  return `${SESSION_COOKIE}=; ${cookieAttrs(env, 0)}`;
}

export async function getSession(ctx, request) {
  const token = parseCookies(request.headers.get('cookie'))[SESSION_COOKIE];
  if (!token || token.length < 20 || token.length > 100) return null;
  const row = await ctx.first(
    `SELECT s.id AS session_id, s.csrf_token, s.expires_at, u.id, u.email, u.name, u.role
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?`, await sha256Hex(token), nowIso(),
  );
  return row || null;
}

/** Para métodos que mudam estado: Origin do próprio app + token CSRF da sessão. */
export function checkCsrf(request, env, session) {
  const origin = request.headers.get('origin');
  const appOrigin = new URL(env.APP_URL || request.url).origin;
  const reqOrigin = new URL(request.url).origin;
  if (origin && origin !== appOrigin && origin !== reqOrigin) throw new HttpError(403, 'Origem não permitida');
  const token = request.headers.get('x-csrf-token');
  if (!session || !token || !safeEqual(token, session.csrf_token)) throw new HttpError(403, 'Token CSRF inválido. Recarregue a página.');
}

export async function login(ctx, request, email, password) {
  const ipKey = `login:ip:${ctx.ip || 'unknown'}`;
  const emailKey = `login:email:${email}`;
  const okIp = await rateLimit(ctx, ipKey, 20, 900);
  const okEmail = await rateLimit(ctx, emailKey, 8, 900);
  if (!okIp || !okEmail) throw new HttpError(429, 'Muitas tentativas. Aguarde 15 minutos.');
  const user = await ctx.first('SELECT * FROM users WHERE email = ?', email);
  // mesmo sem usuário, gasta o tempo do hash para não revelar quais e-mails existem
  const ok = user ? await verifyPassword(password, user) : (await hashPassword(password), false);
  if (!ok) {
    await auditStmt(ctx, user?.id ?? null, 'login_failed', 'user', email).run();
    throw new HttpError(401, 'E-mail ou senha incorretos.');
  }
  return user;
}

export async function changePassword(ctx, user, current, next) {
  const full = await ctx.first('SELECT * FROM users WHERE id = ?', user.id);
  if (!(await verifyPassword(current, full))) throw new HttpError(400, 'Senha atual incorreta.');
  validatePassword(next);
  const { hash, salt, iterations } = await hashPassword(next);
  await ctx.batch([
    ctx.stmt('UPDATE users SET password_hash = ?, password_salt = ?, password_iter = ?, updated_at = ? WHERE id = ?', hash, salt, iterations, nowIso(), user.id),
    ctx.stmt('DELETE FROM sessions WHERE user_id = ? AND id != ?', user.id, user.session_id),
    auditStmt(ctx, user.id, 'password_changed'),
  ]);
}
