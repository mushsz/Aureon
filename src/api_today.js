// Rotas da tela Hoje (rotina diária no celular) e da mini-auditoria pública.

import { HttpError, json, html, redirect, readJson, v } from './http.js';
import { getSettings, auditStmt, stageStmts } from './db.js';
import { nowIso, localDate, truncate, escapeHtml } from './util.js';
import { rateLimit, getSession } from './auth.js';
import { waLink, igLink, igProfile, telLink, normalizePhone, formatPhone } from './channels.js';
import { nextDay, todaySummary, runPlan } from './agents/planner.js';
import { findLeadByAuditToken, auditPageHtml, recordAuditView } from './agents/audit.js';
import { createBookingOffer } from './agents/closer.js';
import { availableSlots, publicPage } from './agents/scheduler.js';
import { auditUrl } from './agents/copywriter.js';

const CHANNEL_LABEL = { whatsapp: 'WhatsApp', instagram: 'Instagram', phone: 'ligação', email: 'e-mail', none: '' };

function cardLinks(t) {
  const phone = normalizePhone(t.whatsapp) || null;
  const callPhone = normalizePhone(t.phone) || phone;
  return {
    whatsapp: phone ? waLink(phone, t.message || '') : null,
    whatsapp_phone: phone,
    instagram: t.instagram ? igLink(t.instagram) : null,
    instagram_profile: t.instagram ? igProfile(t.instagram) : null,
    tel: callPhone ? telLink(callPhone) : null,
    phone_display: callPhone ? formatPhone(callPhone) : null,
  };
}

export function registerToday(r, { sendReply }) {
  r.add('GET', '/api/today', async (ctx) => {
    const settings = await getSettings(ctx);
    const today = localDate(ctx.now, settings.timezone);
    const rows = await ctx.all(
      `SELECT t.*, c.name AS company_name, c.whatsapp, c.instagram, c.phone, c.domain, c.exclusion_reason, l.score, l.stage, l.audit_token,
              ct.person_name,
              (SELECT body_text FROM messages m WHERE m.conversation_id = t.conversation_id AND m.direction = 'in' ORDER BY m.id DESC LIMIT 1) AS inbound_text,
              (SELECT classification FROM messages m WHERE m.conversation_id = t.conversation_id AND m.direction = 'in' ORDER BY m.id DESC LIMIT 1) AS inbound_class,
              a.starts_at, a.meet_link
       FROM tasks t LEFT JOIN companies c ON c.id = t.company_id LEFT JOIN leads l ON l.id = t.lead_id
       LEFT JOIN contacts ct ON ct.id = l.contact_id LEFT JOIN appointments a ON a.id = t.appointment_id
       WHERE t.status = 'open' AND t.due_date <= ?
       ORDER BY t.priority + CASE WHEN t.due_date < ? THEN 3 ELSE 0 END DESC, t.id LIMIT 60`, today, today,
    );
    const doneToday = await ctx.first("SELECT COUNT(*) AS n FROM tasks WHERE status IN ('done','skipped') AND done_at >= ?", new Date(Date.now() - 18 * 3_600_000).toISOString());
    const max = settings.planner.max_cards;
    const cards = rows.slice(0, max).map((t) => ({
      id: t.id, kind: t.kind, channel: t.channel, channel_label: CHANNEL_LABEL[t.channel] || '', title: t.title || t.company_name, reason: t.reason,
      message: t.message, priority: t.priority, overdue: t.due_date < today, company_id: t.company_id, lead_id: t.lead_id, conversation_id: t.conversation_id,
      score: t.score, stage: t.stage, person_name: t.person_name, links: cardLinks(t), audit_url: auditUrl(ctx.env, t.audit_token),
      inbound: t.inbound_text ? { excerpt: truncate(stripQuote(t.inbound_text), 280), classification: t.inbound_class } : null,
      meeting: t.starts_at ? { starts_at: t.starts_at, meet_link: t.meet_link } : null,
      exclusion_reason: t.kind === 'decide' ? t.exclusion_reason : null,
    }));
    const shown = cards.length;
    return json({
      date: today, cards, more: Math.max(0, rows.length - max),
      progress: { done: doneToday.n, total: doneToday.n + shown, minutes: Math.max(1, Math.round(shown * 0.8)) },
      mode: settings.outreach.mode === 'live' && settings.outreach.live_approved_at ? 'live' : 'simulation',
      paused: settings.system.paused || settings.system.emergency_stop,
    });
  });

  r.add('POST', '/api/today/plan', async (ctx) => json(await runPlan(ctx, { digest: false })));

  const loadTask = async (ctx, id) => {
    const t = await ctx.first('SELECT t.*, l.stage, l.manual_step, l.contact_id FROM tasks t LEFT JOIN leads l ON l.id = t.lead_id WHERE t.id = ?', id);
    if (!t) throw new HttpError(404, 'Tarefa não encontrada');
    if (t.status !== 'open') throw new HttpError(409, 'Essa tarefa já foi resolvida.');
    return t;
  };

  // Feito: registra o contato manual (WhatsApp/Instagram/ligação) e avança a sequência
  r.add('POST', '/api/tasks/:id/done', async (ctx, req, p, s) => {
    const t = await loadTask(ctx, v.int(p.id, { min: 1 }));
    const b = await readJson(req);
    const channel = ['whatsapp', 'instagram', 'phone', 'email'].includes(b.channel) ? b.channel : t.channel;
    const ts = nowIso();
    const stmts = [ctx.stmt("UPDATE tasks SET status = 'done', channel = ?, done_at = ?, updated_at = ? WHERE id = ?", channel, ts, ts, t.id)];
    if ((t.kind === 'touch' || t.kind === 'hot') && t.lead_id) {
      let convId = (await ctx.first('SELECT id FROM conversations WHERE lead_id = ? ORDER BY id LIMIT 1', t.lead_id))?.id;
      if (!convId) {
        const ins = await ctx.run("INSERT INTO conversations (lead_id, subject, status, created_at, updated_at) VALUES (?, ?, 'open', ?, ?)", t.lead_id, `Contato por ${CHANNEL_LABEL[channel]}`, ts, ts);
        convId = ins.last_row_id;
      }
      stmts.push(ctx.stmt(
        `INSERT INTO messages (conversation_id, lead_id, direction, channel, kind, status, body_text, sent_at, created_at, updated_at)
         VALUES (?, ?, 'out', ?, 'manual_touch', 'sent', ?, ?, ?, ?)`, convId, t.lead_id, channel, t.message || `Contato por ${CHANNEL_LABEL[channel]}`, ts, ts, ts,
      ));
      stmts.push(ctx.stmt('UPDATE conversations SET last_message_at = ?, updated_at = ? WHERE id = ?', ts, ts, convId));
      const extra = { last_manual_at: ts };
      if (t.kind === 'touch') extra.manual_step = (t.manual_step || 0) + 1;
      const to = ['qualificado', 'aguardando_contato'].includes(t.stage) ? 'contatado' : t.stage;
      stmts.push(...stageStmts(ctx, { id: t.lead_id, stage: t.stage }, to, `Contato manual por ${CHANNEL_LABEL[channel]}`, `user:${s.id}`, extra));
      if (to === 'contatado' && t.stage !== 'contatado') stmts.push(ctx.stmt('UPDATE leads SET last_contact_at = COALESCE(last_contact_at, ?) WHERE id = ?', ts, t.lead_id));
      ctx.metric('manual_touches');
    }
    await ctx.batch(stmts);
    return json({ ok: true });
  });

  r.add('POST', '/api/tasks/:id/snooze', async (ctx, req, p) => {
    const t = await loadTask(ctx, v.int(p.id, { min: 1 }));
    const settings = await getSettings(ctx);
    await ctx.run('UPDATE tasks SET due_date = ?, updated_at = ? WHERE id = ?', nextDay(localDate(ctx.now, settings.timezone)), nowIso(), t.id);
    return json({ ok: true });
  });

  // Pular: encerra a sequência manual dessa empresa sem marcar como contatada
  r.add('POST', '/api/tasks/:id/skip', async (ctx, req, p) => {
    const t = await loadTask(ctx, v.int(p.id, { min: 1 }));
    const ts = nowIso();
    const stmts = [ctx.stmt("UPDATE tasks SET status = 'skipped', done_at = ?, updated_at = ? WHERE id = ?", ts, ts, t.id)];
    if (t.kind === 'touch' && t.lead_id) stmts.push(ctx.stmt('UPDATE leads SET manual_step = 99, updated_at = ? WHERE id = ?', ts, t.lead_id));
    await ctx.batch(stmts);
    return json({ ok: true });
  });

  // Não contatar: supressão em todos os canais (e-mail, WhatsApp, telefone, Instagram)
  r.add('POST', '/api/tasks/:id/block', async (ctx, req, p, s) => {
    const t = await loadTask(ctx, v.int(p.id, { min: 1 }));
    if (!t.lead_id) throw new HttpError(400, 'Tarefa sem empresa.');
    const co = await ctx.first('SELECT whatsapp, instagram, phone FROM companies WHERE id = ?', t.company_id);
    const ct = t.contact_id ? await ctx.first('SELECT normalized_value FROM contacts WHERE id = ?', t.contact_id) : null;
    const ts = nowIso();
    const sup = (type, value) => ctx.stmt("INSERT OR IGNORE INTO suppression_list (type, value, reason, source, created_at) VALUES (?, ?, 'manual', ?, ?)", type, value, `user:${s.id}`, ts);
    const stmts = [];
    if (ct?.normalized_value) stmts.push(sup('email', ct.normalized_value));
    for (const ph of new Set([co?.whatsapp, normalizePhone(co?.phone)].filter(Boolean))) stmts.push(sup('phone', ph));
    if (co?.instagram) stmts.push(sup('instagram', co.instagram));
    stmts.push(ctx.stmt("UPDATE tasks SET status = 'skipped', done_at = ?, updated_at = ? WHERE lead_id = ? AND status = 'open'", ts, ts, t.lead_id));
    stmts.push(ctx.stmt("UPDATE messages SET status = 'cancelled', error = 'não contatar', updated_at = ? WHERE lead_id = ? AND direction = 'out' AND status = 'draft'", ts, t.lead_id));
    stmts.push(ctx.stmt("UPDATE contacts SET status = 'suppressed', updated_at = ? WHERE company_id = ?", ts, t.company_id));
    stmts.push(...stageStmts(ctx, { id: t.lead_id, stage: t.stage }, 'nao_contatar', 'Não contatar (tela Hoje)', `user:${s.id}`));
    stmts.push(auditStmt(ctx, s.id, 'lead_do_not_contact', 'lead', t.lead_id));
    await ctx.batch(stmts);
    return json({ ok: true });
  });

  // Decisão rápida da lista de exclusão
  r.add('POST', '/api/tasks/:id/decide', async (ctx, req, p, s) => {
    const t = await loadTask(ctx, v.int(p.id, { min: 1 }));
    const b = await readJson(req);
    const verdict = v.oneOf(b.verdict, ['approve', 'block'], 'decisão');
    const ts = nowIso();
    const stmts = [ctx.stmt("UPDATE tasks SET status = 'done', done_at = ?, updated_at = ? WHERE id = ?", ts, ts, t.id)];
    if (verdict === 'approve') {
      stmts.push(ctx.stmt("UPDATE companies SET exclusion_status = 'approved', exclusion_reason = COALESCE(exclusion_reason,'') || ' · liberada manualmente', updated_at = ? WHERE id = ? AND exclusion_status = 'review'", ts, t.company_id));
      stmts.push(ctx.stmt("UPDATE leads SET needs_review = 0, priority = CASE WHEN score >= 80 THEN 'alta' WHEN score >= 60 THEN 'media' WHEN score >= 40 THEN 'baixa' ELSE 'nao_automatico' END, updated_at = ? WHERE company_id = ?", ts, t.company_id));
    } else {
      stmts.push(ctx.stmt("UPDATE companies SET exclusion_status = 'block', exclusion_reason = 'Manual: bloqueada na tela Hoje', updated_at = ? WHERE id = ?", ts, t.company_id));
      if (t.lead_id) stmts.push(...stageStmts(ctx, { id: t.lead_id, stage: t.stage }, 'nao_contatar', 'Bloqueada na revisão', `user:${s.id}`));
    }
    stmts.push(auditStmt(ctx, s.id, verdict === 'approve' ? 'company_approved' : 'company_blocked', 'company', t.company_id));
    await ctx.batch(stmts);
    return json({ ok: true });
  });

  // Respostas prontas (você revisa o texto antes de enviar)
  r.add('POST', '/api/conversations/:id/quick-reply', async (ctx, req, p, s) => {
    const id = v.int(p.id, { min: 1 });
    const b = await readJson(req);
    const template = v.oneOf(b.template, ['slots', 'phone', 'info'], 'modelo');
    const conv = await ctx.first('SELECT cv.*, l.service_fit FROM conversations cv JOIN leads l ON l.id = cv.lead_id WHERE cv.id = ?', id);
    if (!conv) throw new HttpError(404, 'Conversa não encontrada');
    const settings = await getSettings(ctx);
    const me = settings.sender.name || '';
    let body;
    if (template === 'slots') {
      const link = await createBookingOffer(ctx, { id: conv.lead_id }, id, settings.timezone);
      let list = '';
      try {
        const slots = (await availableSlots(ctx, settings)).slice(0, 3);
        const f = new Intl.DateTimeFormat('pt-BR', { timeZone: settings.timezone, weekday: 'long', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
        if (slots.length) list = `\n\nTenho estes horários livres:\n${slots.map((x) => `• ${f.format(new Date(x.start))}`).join('\n')}\n`;
      } catch { /* agenda indisponível: manda só o link */ }
      body = `Ótimo, obrigado pelo retorno!${list}\nSe preferir, escolha direto na minha agenda (o convite chega na hora): ${link}\n\n${me}`;
    } else if (template === 'phone') {
      body = `Ótimo, obrigado pelo retorno! Qual o melhor número e horário para eu te ligar? É rapidinho, uns 15 minutos.\n\n${me}`;
    } else {
      body = `Obrigado pelo retorno! Resumindo: cada projeto parte de uma conversa curta para entender a necessidade, e os valores dependem do escopo — por isso prefiro te mostrar em 15 minutos o que eu faria primeiro.\n\nPosso te mandar alguns horários?\n\n${me}`;
    }
    if (b.send) {
      await sendReply(ctx, s, id, body);
      return json({ ok: true, sent: true });
    }
    return json({ ok: true, body });
  });

  // ---------- mini-auditoria pública ----------
  r.add('GET', '/analise/:token', async (ctx, req, p) => {
    if (!(await rateLimit(ctx, `audit:${ctx.ip}`, 120, 3600))) return html(publicPage('Muitas visitas', '<h1>Tente de novo em alguns minutos</h1>'), 429);
    const lead = await findLeadByAuditToken(ctx, p.token);
    if (!lead || lead.exclusion_status === 'block' || lead.stage === 'nao_contatar') return html(publicPage('Análise indisponível', '<h1>Análise indisponível</h1><p>Este link não está mais ativo.</p>'), 404);
    return html(await auditPageHtml(ctx, lead, p.token));
  }, { public: true });

  r.add('POST', '/analise/:token/visto', async (ctx, req, p) => {
    if (!(await rateLimit(ctx, `auditview:${ctx.ip}`, 30, 3600))) return new Response(null, { status: 204 });
    // sua própria visita (logado no painel) não conta
    if (await getSession(ctx, req)) return new Response(null, { status: 204 });
    const lead = await findLeadByAuditToken(ctx, p.token);
    if (lead && lead.exclusion_status !== 'block' && lead.stage !== 'nao_contatar') await recordAuditView(ctx, lead);
    return new Response(null, { status: 204 });
  }, { public: true });

  r.add('GET', '/analise/:token/agendar', async (ctx, req, p) => {
    if (!(await rateLimit(ctx, `auditbook:${ctx.ip}`, 10, 3600))) return html(publicPage('Muitas tentativas', '<h1>Tente de novo em alguns minutos</h1>'), 429);
    const lead = await findLeadByAuditToken(ctx, p.token);
    if (!lead || lead.exclusion_status === 'block' || lead.stage === 'nao_contatar') return html(publicPage('Indisponível', '<h1>Link indisponível</h1>'), 404);
    const settings = await getSettings(ctx);
    const conv = await ctx.first('SELECT id FROM conversations WHERE lead_id = ? ORDER BY id LIMIT 1', lead.id);
    const url = await createBookingOffer(ctx, lead, conv?.id ?? null, settings.timezone);
    ctx.log('info', 'audit', `${lead.company_name} clicou em agendar na análise`);
    return redirect(url.slice(url.indexOf('/agendar/')), 303);
  }, { public: true });
}

function stripQuote(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (/^\s*>/.test(line) || /^\s*(em|on)\s.+(escreveu|wrote)\s*:?\s*$/i.test(line)) break;
    out.push(line);
  }
  return out.join('\n').trim();
}

export { escapeHtml };
