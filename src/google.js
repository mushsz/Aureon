// Integração Google (OAuth 2.0 para app web, Gmail API e Calendar API) via REST, sem SDK.
// Tokens ficam só no D1, cifrados com AES-GCM (ENCRYPTION_KEY). Nada vai para o frontend.

import { nowIso, encryptText, decryptText, randomToken, truncate, utf8ToB64url, b64urlToUtf8, unb64url } from './util.js';
import { usageToday, getSettings } from './db.js';

export const GOOGLE_SCOPES = [
  'openid', 'email',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.freebusy',
];

export const redirectUri = (env) => `${(env.APP_URL || '').replace(/\/$/, '')}/api/google/callback`;

export async function startOAuth(ctx, userId) {
  if (!ctx.env.GOOGLE_CLIENT_ID || !ctx.env.GOOGLE_CLIENT_SECRET) throw Object.assign(new Error('GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET não configurados no Worker.'), { status: 400 });
  const state = randomToken(24);
  await ctx.run('INSERT INTO oauth_states (state, user_id, expires_at) VALUES (?,?,?)', state, userId, new Date(Date.now() + 10 * 60_000).toISOString());
  const p = new URLSearchParams({
    client_id: ctx.env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri(ctx.env), response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

export async function finishOAuth(ctx, userId, code, state) {
  const st = await ctx.first('SELECT * FROM oauth_states WHERE state = ?', state);
  await ctx.run('DELETE FROM oauth_states WHERE state = ? OR expires_at < ?', state, nowIso());
  if (!st || st.user_id !== userId || st.expires_at < nowIso()) throw Object.assign(new Error('Estado OAuth inválido ou expirado. Tente conectar de novo.'), { status: 400 });
  ctx.metric('google_oauth');
  const res = await ctx.fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: ctx.env.GOOGLE_CLIENT_ID, client_secret: ctx.env.GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri(ctx.env), grant_type: 'authorization_code' }),
  });
  const tok = await res.json();
  if (!res.ok) throw Object.assign(new Error(`Google recusou a troca do código: ${tok.error_description || tok.error}`), { status: 400 });
  if (!tok.refresh_token) throw Object.assign(new Error('O Google não devolveu refresh token. Remova o acesso do app em myaccount.google.com/permissions e conecte de novo.'), { status: 400 });
  const email = tok.id_token ? JSON.parse(b64urlToUtf8(tok.id_token.split('.')[1])).email : null;
  const ts = nowIso();
  await ctx.run(
    `INSERT INTO integrations (provider, status, account_email, scopes, refresh_token_enc, access_token_enc, access_token_expires_at, connected_at, updated_at, last_error, inbox_cursor)
     VALUES ('google', 'connected', ?, ?, ?, ?, ?, ?, ?, NULL, ?)
     ON CONFLICT(provider) DO UPDATE SET status='connected', account_email=excluded.account_email, scopes=excluded.scopes,
       refresh_token_enc=excluded.refresh_token_enc, access_token_enc=excluded.access_token_enc,
       access_token_expires_at=excluded.access_token_expires_at, connected_at=excluded.connected_at, updated_at=excluded.updated_at,
       last_error=NULL, verified_at=NULL, inbox_cursor=COALESCE(integrations.inbox_cursor, excluded.inbox_cursor)`,
    email, tok.scope || GOOGLE_SCOPES.join(' '), await encryptText(ctx.env, tok.refresh_token), await encryptText(ctx.env, tok.access_token),
    new Date(Date.now() + (tok.expires_in - 60) * 1000).toISOString(), ts, ts, String(Math.floor(Date.now() / 1000)),
  );
  return { email };
}

export async function getIntegration(ctx) {
  return ctx.first("SELECT * FROM integrations WHERE provider = 'google'");
}

export async function disconnectGoogle(ctx) {
  const integ = await getIntegration(ctx);
  if (integ?.refresh_token_enc) {
    try {
      const rt = await decryptText(ctx.env, integ.refresh_token_enc);
      await ctx.fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: rt }) });
    } catch { /* revogação é melhor esforço */ }
  }
  await ctx.run("UPDATE integrations SET status='disconnected', refresh_token_enc=NULL, access_token_enc=NULL, access_token_expires_at=NULL, verified_at=NULL, updated_at=? WHERE provider='google'", nowIso());
}

export class GoogleNotConnected extends Error {}

export async function accessToken(ctx) {
  if (ctx._gToken) return ctx._gToken;
  const integ = await getIntegration(ctx);
  if (!integ || integ.status !== 'connected' || !integ.refresh_token_enc) throw new GoogleNotConnected('Google não conectado.');
  if (integ.access_token_enc && integ.access_token_expires_at > nowIso()) {
    ctx._gToken = await decryptText(ctx.env, integ.access_token_enc);
    ctx._gAccount = integ.account_email;
    return ctx._gToken;
  }
  ctx.metric('google_token_refresh'); ctx.metric('subrequests');
  const res = await ctx.fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: ctx.env.GOOGLE_CLIENT_ID, client_secret: ctx.env.GOOGLE_CLIENT_SECRET, refresh_token: await decryptText(ctx.env, integ.refresh_token_enc), grant_type: 'refresh_token' }),
  });
  const tok = await res.json();
  if (!res.ok) {
    const msg = `Falha ao renovar acesso Google: ${tok.error_description || tok.error}`;
    await ctx.run("UPDATE integrations SET status = ?, last_error = ?, updated_at = ? WHERE provider = 'google'", tok.error === 'invalid_grant' ? 'expired' : 'connected', truncate(msg, 500), nowIso());
    throw new GoogleNotConnected(msg);
  }
  await ctx.run("UPDATE integrations SET access_token_enc = ?, access_token_expires_at = ?, updated_at = ? WHERE provider = 'google'",
    await encryptText(ctx.env, tok.access_token), new Date(Date.now() + (tok.expires_in - 60) * 1000).toISOString(), nowIso());
  ctx._gToken = tok.access_token;
  ctx._gAccount = integ.account_email;
  return ctx._gToken;
}

async function gfetch(ctx, metric, url, init = {}) {
  const settings = await getSettings(ctx);
  const limitKey = metric === 'gmail_api' ? 'gmail_api_daily' : 'calendar_api_daily';
  if ((await usageToday(ctx, metric)) >= settings.limits[limitKey]) {
    throw Object.assign(new Error(`Limite diário configurado para ${metric} atingido.`), { limitReached: metric });
  }
  const token = await accessToken(ctx);
  ctx.metric(metric); ctx.metric('subrequests');
  const res = await ctx.fetch(url, { ...init, headers: { ...(init.headers || {}), authorization: `Bearer ${token}` } });
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`${metric} HTTP ${res.status}: ${body?.error?.message || 'erro'}`);
    err.status = res.status;
    if (res.status === 429) err.retryAfterMinutes = 30;
    throw err;
  }
  return body;
}

// ---------- Gmail ----------

const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(s)))}?=`);
const cleanHeader = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();

export function buildMime({ from, fromName, to, subject, text, inReplyTo, references, listUnsubscribe }) {
  const headers = [
    `From: ${fromName ? `${encodeHeader(cleanHeader(fromName))} <${cleanHeader(from)}>` : cleanHeader(from)}`,
    `To: ${cleanHeader(to)}`,
    `Subject: ${encodeHeader(cleanHeader(subject))}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ];
  if (inReplyTo) headers.push(`In-Reply-To: ${cleanHeader(inReplyTo)}`);
  if (references) headers.push(`References: ${cleanHeader(references)}`);
  if (listUnsubscribe) {
    headers.push(`List-Unsubscribe: <${cleanHeader(listUnsubscribe)}>, <mailto:${cleanHeader(from)}?subject=descadastrar>`);
    headers.push('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
  }
  const bytes = new TextEncoder().encode(text);
  let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
  const body = btoa(bin).replace(/.{76}/g, '$&\r\n');
  return `${headers.join('\r\n')}\r\n\r\n${body}`;
}

export async function gmailSend(ctx, mime, threadId = null) {
  const raw = utf8ToB64url(mime);
  return gfetch(ctx, 'gmail_api', 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(threadId ? { raw, threadId } : { raw }),
  });
}

export async function gmailList(ctx, q, maxResults = 10) {
  const p = new URLSearchParams({ q, maxResults: String(maxResults) });
  return gfetch(ctx, 'gmail_api', `https://gmail.googleapis.com/gmail/v1/users/me/messages?${p}`);
}

export async function gmailGet(ctx, id) {
  return gfetch(ctx, 'gmail_api', `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`);
}

export async function gmailProfile(ctx) {
  return gfetch(ctx, 'gmail_api', 'https://gmail.googleapis.com/gmail/v1/users/me/profile');
}

/** Converte a mensagem do Gmail (format=full) em objeto simples. */
export function parseGmailMessage(m) {
  const headers = {};
  for (const h of m?.payload?.headers || []) headers[h.name.toLowerCase()] = h.value;
  const decode = (data) => { try { return new TextDecoder().decode(unb64url(data)); } catch { return ''; } };
  let text = '';
  let html = '';
  const walk = (part) => {
    if (!part) return;
    if (part.mimeType === 'text/plain' && part.body?.data && !text) text = decode(part.body.data);
    else if (part.mimeType === 'text/html' && part.body?.data && !html) html = decode(part.body.data);
    for (const p of part.parts || []) walk(p);
  };
  walk(m?.payload);
  if (!text && html) text = html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ').replace(/<br\s*\/?>|<\/p>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/[ \t]+/g, ' ');
  const fromRaw = headers.from || '';
  const fromEmail = (/<([^>]+)>/.exec(fromRaw)?.[1] || fromRaw).trim().toLowerCase();
  return {
    id: m.id, threadId: m.threadId, internalDate: m.internalDate ? new Date(+m.internalDate).toISOString() : nowIso(),
    from: fromEmail, fromRaw, to: headers.to || '', subject: headers.subject || '', messageId: headers['message-id'] || null,
    references: headers.references || null, headers, text: truncate(text, 20_000), snippet: m.snippet || '', labelIds: m.labelIds || [],
  };
}

// ---------- Calendar ----------

export async function freeBusy(ctx, calendarId, timeMin, timeMax, timeZone) {
  const r = await gfetch(ctx, 'calendar_api', 'https://www.googleapis.com/calendar/v3/freeBusy', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ timeMin, timeMax, timeZone, items: [{ id: calendarId }] }),
  });
  const cal = r?.calendars?.[calendarId];
  if (cal?.errors?.length) throw new Error(`Calendar: ${cal.errors.map((e) => e.reason).join(', ')}`);
  return (cal?.busy || []).map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
}

export async function createEvent(ctx, calendarId, event, withMeet) {
  const q = new URLSearchParams({ sendUpdates: 'all' });
  if (withMeet) q.set('conferenceDataVersion', '1');
  return gfetch(ctx, 'calendar_api', `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${q}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event),
  });
}

export async function getEvent(ctx, calendarId, eventId) {
  return gfetch(ctx, 'calendar_api', `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
}

export async function deleteEvent(ctx, calendarId, eventId) {
  return gfetch(ctx, 'calendar_api', `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=all`, { method: 'DELETE' });
}

export async function calendarCheck(ctx, calendarId) {
  return gfetch(ctx, 'calendar_api', `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}`);
}
