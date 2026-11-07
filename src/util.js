// Utilidades sem dependências: texto, datas/fuso, JSON, crypto (WebCrypto nativo dos Workers).

export const nowIso = (d = new Date()) => d.toISOString();
export const addMinutes = (d, m) => new Date(d.getTime() + m * 60_000);
export const pad = (n) => String(n).padStart(2, '0');

/** Texto em minúsculas, sem acento, só letras/números separados por um espaço. */
export function normalize(text) {
  return String(text ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function safeJson(text, fallback = null) {
  if (text == null || text === '') return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

export function truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) : s;
}

// ---------- Fuso horário (Intl é nativo nos Workers) ----------

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const fmtCache = new Map();
function partsFormatter(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return fmtCache.get(tz);
}

/** Partes da data no fuso informado. weekday: 0=domingo … 6=sábado. */
export function zonedParts(date, tz) {
  const p = Object.fromEntries(partsFormatter(tz).formatToParts(date).map((x) => [x.type, x.value]));
  return {
    year: +p.year, month: +p.month, day: +p.day,
    hour: +p.hour, minute: +p.minute, second: +p.second,
    weekday: WEEKDAYS.indexOf(p.weekday),
  };
}

export function tzOffsetMs(date, tz) {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Converte data/hora "de parede" no fuso para o instante UTC. */
export function zonedToUtc(year, month, day, hour, minute, tz) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const off1 = tzOffsetMs(new Date(guess), tz);
  let t = guess - off1;
  const off2 = tzOffsetMs(new Date(t), tz);
  if (off2 !== off1) t = guess - off2;
  return new Date(t);
}

export function localDate(date, tz) {
  const p = zonedParts(date, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Minutos desde 00:00 no fuso. */
export function localMinutes(date, tz) {
  const p = zonedParts(date, tz);
  return p.hour * 60 + p.minute;
}

export function hmToMinutes(hm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm ?? ''));
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

export function parseDays(days) {
  if (Array.isArray(days)) return days.map(Number).filter((d) => d >= 0 && d <= 6);
  return String(days ?? '').split(',').map((s) => s.trim()).filter(Boolean).map(Number).filter((d) => d >= 0 && d <= 6);
}

/** Está dentro da janela [start, end) nos dias permitidos, no fuso? */
export function inWindow(date, tz, days, start, end) {
  const p = zonedParts(date, tz);
  if (!parseDays(days).includes(p.weekday)) return false;
  const m = p.hour * 60 + p.minute;
  const s = hmToMinutes(start) ?? 0;
  const e = end ? (hmToMinutes(end) ?? 24 * 60) : 24 * 60;
  return m >= s && m < e;
}

// ---------- Crypto ----------

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64(bytes) {
  let s = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s);
}
export function unb64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export const b64url = (bytes) => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export function unb64url(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return unb64(str);
}
export const utf8ToB64url = (s) => b64url(enc.encode(s));
export const b64urlToUtf8 = (s) => dec.decode(unb64url(s));

export function randomToken(bytes = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(text) {
  const h = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Comparação em tempo constante de duas strings. */
export function safeEqual(a, b) {
  a = String(a ?? ''); b = String(b ?? '');
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

// Senhas: PBKDF2-SHA256. 100.000 iterações é o máximo aceito pelo runtime dos Workers.
export const PBKDF2_ITERATIONS = 100_000;

export async function hashPassword(password, saltB64 = null, iterations = PBKDF2_ITERATIONS) {
  const salt = saltB64 ? unb64(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return { hash: b64(bits), salt: b64(salt), iterations };
}

export async function verifyPassword(password, user) {
  const { hash } = await hashPassword(password, user.password_salt, user.password_iter);
  return safeEqual(hash, user.password_hash);
}

// Chaves derivadas do ENCRYPTION_KEY (32 bytes em base64): uma para AES-GCM, outra para HMAC.
const keyCache = new Map();
async function deriveKeys(secretB64) {
  if (!secretB64) throw new Error('ENCRYPTION_KEY não configurada');
  if (keyCache.has(secretB64)) return keyCache.get(secretB64);
  const raw = unb64(secretB64);
  if (raw.length < 32) throw new Error('ENCRYPTION_KEY precisa ter 32 bytes (base64)');
  const master = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
  const params = (info) => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(info) });
  const aes = await crypto.subtle.deriveKey(params('aes-v1'), master, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const hmac = await crypto.subtle.deriveKey(params('hmac-v1'), master, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify']);
  const keys = { aes, hmac };
  keyCache.set(secretB64, keys);
  return keys;
}

export async function encryptText(env, plain) {
  if (plain == null) return null;
  const { aes } = await deriveKeys(env.ENCRYPTION_KEY);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, enc.encode(plain));
  return `v1.${b64url(iv)}.${b64url(ct)}`;
}

export async function decryptText(env, packed) {
  if (!packed) return null;
  const [v, iv, ct] = packed.split('.');
  if (v !== 'v1') throw new Error('formato de segredo desconhecido');
  const { aes } = await deriveKeys(env.ENCRYPTION_KEY);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64url(iv) }, aes, unb64url(ct));
  return dec.decode(pt);
}

export async function hmacSign(env, data) {
  const { hmac } = await deriveKeys(env.ENCRYPTION_KEY);
  return b64url(await crypto.subtle.sign('HMAC', hmac, enc.encode(data)));
}

export async function hmacVerify(env, data, sig) {
  return safeEqual(await hmacSign(env, data), sig);
}

/** Token assinado sem estado: base64url(payload).assinatura */
export async function signPayload(env, obj) {
  const body = utf8ToB64url(JSON.stringify(obj));
  return `${body}.${await hmacSign(env, body)}`;
}
export async function verifyPayload(env, token) {
  const [body, sig] = String(token ?? '').split('.');
  if (!body || !sig) return null;
  if (!(await hmacVerify(env, body, sig))) return null;
  return safeJson(b64urlToUtf8(body));
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Hash pequeno e estável (para escolher variantes de modelo de forma determinística). */
export function stableHash(s) {
  let h = 2166136261;
  for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
