// SCHEDULER — horários livres reais (Google Calendar freeBusy), reserva pelo link enviado ao
// interessado, criação do evento, conferência de que o evento existe, confirmação, cancelamento e
// reagendamento. Nada é confirmado sem o evento ter sido lido de volta na agenda.

import { nowIso, sha256Hex, zonedParts, zonedToUtc, hmToMinutes, parseDays, escapeHtml, truncate } from '../util.js';
import { getSettings, stageStmts } from '../db.js';
import { freeBusy, createEvent, getEvent, deleteEvent, buildMime, gmailSend } from '../google.js';
import { isLive } from './outreach.js';

/** Gera horários candidatos e retira os ocupados. Puro (testável). */
export function computeSlots({ now, availability, timezone, busy = [], max = 24 }) {
  const days = parseDays(availability.days);
  const start = hmToMinutes(availability.start) ?? 540;
  const end = hmToMinutes(availability.end) ?? 1080;
  const dur = Math.max(15, +availability.duration_minutes || 30);
  const buf = Math.max(0, +availability.buffer_minutes || 0);
  const earliest = now.getTime() + (+availability.min_notice_hours || 0) * 3_600_000;
  const horizon = Math.min(60, +availability.horizon_days || 14);
  const slots = [];
  const base = zonedParts(now, timezone);
  for (let d = 0; d <= horizon && slots.length < max; d++) {
    const dayUtc = new Date(Date.UTC(base.year, base.month - 1, base.day + d, 12));
    const p = zonedParts(dayUtc, timezone);
    const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
    if (!days.includes(weekday)) continue;
    for (let m = start; m + dur <= end && slots.length < max; m += dur + buf) {
      const s = zonedToUtc(p.year, p.month, p.day, Math.floor(m / 60), m % 60, timezone);
      const e = new Date(s.getTime() + dur * 60_000);
      if (s.getTime() < earliest) continue;
      const clash = busy.some((b) => s < new Date(b.end.getTime() + buf * 60_000) && e > new Date(b.start.getTime() - buf * 60_000));
      if (!clash) slots.push({ start: s.toISOString(), end: e.toISOString() });
    }
  }
  return slots;
}

export async function findAppointment(ctx, token) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token || '')) return null;
  const appt = await ctx.first(
    `SELECT a.*, l.stage, l.company_id, c.name AS company_name, ct.normalized_value AS contact_email
     FROM appointments a JOIN leads l ON l.id = a.lead_id JOIN companies c ON c.id = l.company_id
     LEFT JOIN contacts ct ON ct.id = l.contact_id WHERE a.token_hash = ?`, await sha256Hex(token),
  );
  if (!appt || appt.token_expires_at < nowIso()) return null;
  return appt;
}

export async function availableSlots(ctx, settings) {
  const av = settings.availability;
  const timeMin = new Date(ctx.now.getTime() + (+av.min_notice_hours || 0) * 3_600_000);
  const timeMax = new Date(ctx.now.getTime() + ((+av.horizon_days || 14) + 1) * 86_400_000);
  const busy = await freeBusy(ctx, av.calendar_id || 'primary', timeMin.toISOString(), timeMax.toISOString(), settings.timezone);
  return computeSlots({ now: ctx.now, availability: av, timezone: settings.timezone, busy });
}

async function sendConfirmation(ctx, settings, appt, text, subject) {
  if (!isLive(settings) || !appt.attendee_email) return 'simulated';
  const conv = appt.conversation_id ? await ctx.first('SELECT gmail_thread_id FROM conversations WHERE id = ?', appt.conversation_id) : null;
  const mime = buildMime({ from: settings.sender.email, fromName: settings.sender.name, to: appt.attendee_email, subject, text });
  await gmailSend(ctx, mime, conv?.gmail_thread_id || null);
  ctx.metric('emails_sent');
  return 'sent';
}

const fmt = (iso, tz) => new Intl.DateTimeFormat('pt-BR', { timeZone: tz, weekday: 'long', day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

/** Reserva um horário. Confere conflito de novo, cria o evento e o relê antes de confirmar. */
export async function bookSlot(ctx, appt, slotStart, attendeeEmail) {
  const settings = await getSettings(ctx);
  const av = settings.availability;
  const slots = await availableSlots(ctx, settings);
  const slot = slots.find((s) => s.start === slotStart);
  if (!slot) return { ok: false, error: 'Esse horário não está mais disponível. Escolha outro.' };
  const email = String(attendeeEmail || appt.contact_email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'Informe um e-mail válido para receber o convite.' };
  const calId = av.calendar_id || 'primary';
  const event = {
    summary: `Conversa: ${appt.company_name} × ${settings.sender.name || 'Aureon'}`,
    description: `Reunião agendada pelo link enviado por e-mail.\nEmpresa: ${appt.company_name}\nLead #${appt.lead_id}`,
    start: { dateTime: slot.start, timeZone: settings.timezone },
    end: { dateTime: slot.end, timeZone: settings.timezone },
    attendees: [{ email }],
    reminders: { useDefault: true },
  };
  if (av.create_meet_link) event.conferenceData = { createRequest: { requestId: appt.token_hash.slice(0, 32), conferenceSolutionKey: { type: 'hangoutsMeet' } } };
  const created = await createEvent(ctx, calId, event, !!av.create_meet_link);
  const check = await getEvent(ctx, calId, created.id);
  if (!check?.id || check.status === 'cancelled') return { ok: false, error: 'O evento não foi confirmado pela agenda. Nada foi marcado; tente novamente.' };
  const ts = nowIso();
  await ctx.batch([
    ctx.stmt(`UPDATE appointments SET status = 'booked', starts_at = ?, ends_at = ?, attendee_email = ?, calendar_event_id = ?, html_link = ?, updated_at = ? WHERE id = ?`,
      slot.start, slot.end, email, check.id, check.htmlLink || null, ts, appt.id),
    ...stageStmts(ctx, { id: appt.lead_id, stage: appt.stage }, 'reuniao_agendada', `Reunião em ${fmt(slot.start, settings.timezone)}`, 'scheduler'),
  ]);
  const meet = check.hangoutLink ? `\nLink da chamada: ${check.hangoutLink}` : '';
  await sendConfirmation(ctx, settings, { ...appt, attendee_email: email },
    `Olá!\n\nReunião confirmada para ${fmt(slot.start, settings.timezone)} (horário de Brasília).${meet}\nO convite também chegou pelo Google Agenda.\n\nPara cancelar ou reagendar, use o mesmo link: ${(ctx.env.APP_URL || '').replace(/\/$/, '')}/agendar/${appt._token}\n\nObrigado,\n${settings.sender.name}`,
    `Reunião confirmada — ${fmt(slot.start, settings.timezone)}`);
  ctx.metric('meetings_booked');
  ctx.log('info', 'scheduler', `Reunião marcada: ${appt.company_name} em ${slot.start}`, { appointment_id: appt.id, event_id: check.id });
  return { ok: true, start: slot.start, end: slot.end, hangoutLink: check.hangoutLink || null };
}

export async function cancelBooking(ctx, appt, reason = 'cancelado pelo convidado') {
  const settings = await getSettings(ctx);
  if (appt.calendar_event_id) {
    try { await deleteEvent(ctx, settings.availability.calendar_id || 'primary', appt.calendar_event_id); }
    catch (e) { if (e.status !== 410 && e.status !== 404) throw e; }
  }
  const ts = nowIso();
  // o mesmo link continua valendo para escolher outro horário (reagendamento)
  await ctx.batch([
    ctx.stmt("UPDATE appointments SET status = 'offered', starts_at = NULL, ends_at = NULL, calendar_event_id = NULL, html_link = NULL, updated_at = ? WHERE id = ?", ts, appt.id),
    ...stageStmts(ctx, { id: appt.lead_id, stage: appt.stage }, 'interessado', `Reunião cancelada (${truncate(reason, 100)})`, 'scheduler'),
  ]);
  ctx.log('info', 'scheduler', `Reunião cancelada: ${appt.company_name}`, { appointment_id: appt.id });
}

// ---------- Páginas públicas (sem login; o token do link é a credencial) ----------

export function publicPage(title, inner) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><meta name="robots" content="noindex"><link rel="stylesheet" href="/public.css"></head>
<body><main class="pub">${inner}</main></body></html>`;
}

export function bookingPageHtml({ appt, slots, timezone, token, error, csrf }) {
  const head = `<p class="eyebrow">Agendamento</p><h1>${escapeHtml(appt.company_name)}</h1>`;
  if (appt.status === 'booked') {
    return publicPage('Reunião confirmada', `${head}<div class="card ok"><strong>Reunião confirmada</strong><p>${escapeHtml(fmt(appt.starts_at, timezone))} (horário de Brasília)</p></div>
<form method="post" action="/agendar/${token}/cancelar"><input type="hidden" name="csrf" value="${csrf}"><button class="btn ghost" type="submit">Cancelar ou reagendar</button></form>`);
  }
  if (!slots.length) return publicPage('Agendamento', `${head}<div class="card"><p>No momento não há horários livres. Responda o e-mail com sugestões de horário e eu confirmo.</p></div>`);
  const byDay = new Map();
  for (const s of slots) {
    const day = new Intl.DateTimeFormat('pt-BR', { timeZone: timezone, weekday: 'long', day: '2-digit', month: 'long' }).format(new Date(s.start));
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(s);
  }
  const groups = [...byDay].map(([day, list]) => `<fieldset><legend>${escapeHtml(day)}</legend><div class="slots">${list.map((s) =>
    `<label class="slot"><input type="radio" name="slot" value="${s.start}" required><span>${new Intl.DateTimeFormat('pt-BR', { timeZone: timezone, hour: '2-digit', minute: '2-digit' }).format(new Date(s.start))}</span></label>`).join('')}</div></fieldset>`).join('');
  return publicPage('Escolha um horário', `${head}<p class="lead">Escolha um horário (horário de Brasília). O convite chega pelo Google Agenda.</p>
${error ? `<div class="card err">${escapeHtml(error)}</div>` : ''}
<form method="post" action="/agendar/${token}"><input type="hidden" name="csrf" value="${csrf}">${groups}
<label class="field">Seu e-mail para o convite<input type="email" name="email" value="${escapeHtml(appt.contact_email || '')}" required autocomplete="email"></label>
<button class="btn" type="submit">Confirmar horário</button></form>`);
}
