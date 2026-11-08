// Tela Hoje — a rotina de ~10 minutos no celular. Um cartão por ação, em ordem de prioridade.
// Você toca no canal (abre o WhatsApp/Instagram/discador com o texto pronto), envia do seu celular
// e marca "Feito". Nada é enviado por WhatsApp ou Instagram sem você.
import { api, html, raw, mount, icon, toast, fail, openSheet, closeSheet, fmtDate, fmtRel, META, STAGE_LABEL, busy } from './core.js';

const SECTION = {
  reply: ['Responder agora', 'Gente que respondeu — responda rápido'],
  hot: ['Quentes', 'Abriram a sua análise'],
  meeting: ['Reuniões de hoje', 'Lembrete pronto'],
  touch: ['Toques do dia', 'WhatsApp, Instagram ou ligação'],
  decide: ['Decidir rápido', 'Em dúvida na lista de exclusão'],
};
const ORDER = ['reply', 'hot', 'meeting', 'touch', 'decide'];
const chosen = new Map(); // tarefa → canal tocado

const loading = html`<div class="stack"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>`;

function channelButtons(c) {
  const L = c.links || {};
  const btn = (ch, label, href, ic, extra = '') => href ? html`<a class="btn ${c.channel === ch ? 'accent' : 'soft'} ch" data-act="open" data-ch="${ch}" data-id="${c.id}" href="${href}" target="_blank" rel="noopener noreferrer" ${raw(extra)}>${icon(ic)}<span>${label}</span></a>` : '';
  return html`<div class="ch-row">
    ${btn('whatsapp', 'WhatsApp', L.whatsapp, 'whatsapp')}
    ${btn('instagram', 'Instagram', L.instagram, 'instagram')}
    ${btn('phone', 'Ligar', L.tel, 'phone')}
  </div>`;
}

function card(c) {
  const head = html`<div class="row between"><button class="linklike grow ellipsis" data-act="company" data-cid="${c.company_id}"><strong>${c.title}</strong></button>
    ${c.score != null ? html`<span class="chip num">${c.score} pts</span>` : ''}</div>
    <p class="small muted gap-top-s">${c.overdue ? html`<span class="chip warn">atrasado</span> ` : ''}${c.reason || ''}</p>`;
  const foot = html`<div class="task-foot">
    <button class="btn small ok" data-act="done" data-id="${c.id}">${icon('check')}Feito</button>
    <button class="btn small ghost" data-act="snooze" data-id="${c.id}">${icon('clock')}Amanhã</button>
    ${c.kind === 'touch' ? html`<button class="btn small ghost" data-act="skip" data-id="${c.id}">Pular</button>` : ''}
    ${c.kind !== 'decide' && c.kind !== 'meeting' ? html`<button class="btn small danger-ghost" data-act="block" data-id="${c.id}">${icon('ban')}Não contatar</button>` : ''}
  </div>`;
  if (c.kind === 'reply') {
    return html`<article class="task card" data-task="${c.id}">${head}
      ${c.inbound ? html`<blockquote class="quote">${c.inbound.excerpt}</blockquote><p class="xs faint">${META.classes[c.inbound.classification] || ''}</p>` : ''}
      <div class="ch-row">
        <button class="btn accent ch" data-act="quick" data-tpl="slots" data-conv="${c.conversation_id}" data-id="${c.id}">${icon('calendar')}<span>Enviar horários</span></button>
        <button class="btn soft ch" data-act="quick" data-tpl="phone" data-conv="${c.conversation_id}" data-id="${c.id}">${icon('phone')}<span>Pedir telefone</span></button>
        <button class="btn soft ch" data-act="conv" data-conv="${c.conversation_id}">${icon('chat')}<span>Responder</span></button>
      </div>
      <div class="task-foot"><button class="btn small ghost" data-act="done" data-id="${c.id}">${icon('check')}Já respondi</button><button class="btn small ghost" data-act="snooze" data-id="${c.id}">${icon('clock')}Amanhã</button></div>
    </article>`;
  }
  if (c.kind === 'decide') {
    return html`<article class="task card" data-task="${c.id}">${head}
      <p class="small">Libere só se tiver certeza de que não é saúde nem concorrente da Arco.</p>
      <div class="task-foot"><button class="btn small ok" data-act="decide" data-v="approve" data-id="${c.id}">Liberar</button><button class="btn small danger-ghost" data-act="decide" data-v="block" data-id="${c.id}">Bloquear</button><button class="btn small ghost" data-act="snooze" data-id="${c.id}">Amanhã</button></div>
    </article>`;
  }
  const isPhone = c.channel === 'phone';
  return html`<article class="task card" data-task="${c.id}">${head}
    ${c.meeting ? html`<p class="small"><strong>${fmtDate(c.meeting.starts_at, { hour: '2-digit', minute: '2-digit' })}</strong>${c.meeting.meet_link ? html` · <a href="${c.meeting.meet_link}" target="_blank" rel="noopener noreferrer">link da chamada</a>` : ''}</p>` : ''}
    ${c.message ? html`<label class="sr" for="msg-${c.id}">Mensagem</label><textarea id="msg-${c.id}" class="msg ${isPhone ? 'script' : ''}" data-msg="${c.id}" rows="${isPhone ? 5 : 4}">${c.message}</textarea>` : ''}
    ${channelButtons(c)}
    ${c.links?.phone_display && isPhone ? html`<p class="xs muted">${c.links.phone_display}</p>` : ''}
    <p class="xs faint ch-hint">${c.links?.instagram ? 'No Instagram o texto é copiado: abra a conversa e cole.' : 'Abre com o texto pronto — é só enviar.'}</p>
    ${foot}
  </article>`;
}

export async function today(root) {
  mount(root, loading);
  let d;
  try { d = await api('GET', '/api/today'); } catch (e) { mount(root, html`<div class="banner bad">${icon('alert')}<div class="grow"><strong>Não foi possível carregar</strong><p>${e.message}</p></div></div>`); return; }
  const pct = d.progress.total ? Math.round((d.progress.done / d.progress.total) * 100) : 100;
  const groups = ORDER.map((k) => [k, d.cards.filter((c) => c.kind === k)]).filter(([, list]) => list.length);
  const dateLabel = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: 'long' }).format(new Date());
  mount(root, html`
    <div class="page-head"><div><h1>Hoje</h1><p class="muted small">${dateLabel}</p></div>
      <button class="icon-btn" data-act="replan" aria-label="Atualizar a lista">${icon('refresh')}</button></div>
    <div class="card flat tight">
      <div class="row between small"><span>${d.progress.done} de ${d.progress.total} feitos</span><span class="muted">${d.cards.length ? `cerca de ${d.progress.minutes} min` : 'tudo certo'}</span></div>
      <div class="bar ok gap-top-s"><i data-w="${pct}"></i></div>
      ${d.mode === 'simulation' ? html`<p class="xs faint gap-top-s">E-mails em modo simulação. Os toques manuais você envia de verdade, do seu celular.</p>` : ''}
    </div>
    ${groups.length ? groups.map(([k, list]) => html`<p class="section-title">${SECTION[k][0]} <span class="faint">(${list.length})</span></p><div class="stack">${list.map(card)}</div>`)
      : html`<div class="card flat gap-top"><div class="empty">${icon('check')}<p><strong>Nada pendente agora.</strong></p><p class="small">Quando alguém responder, abrir a sua análise ou chegar a hora de um toque, aparece aqui.</p><a class="btn small soft" href="#/resultados">Ver resultados</a></div></div>`}
    ${d.more ? html`<p class="hint gap-top">Mais ${d.more} tarefa(s) ficaram para os próximos dias, para caber nos seus 10 minutos.</p>` : ''}`);

  const remove = (id) => {
    const el = root.querySelector(`[data-task="${id}"]`);
    if (el) { el.classList.add('leaving'); setTimeout(() => today(root), 220); } else today(root);
  };
  const msgOf = (id) => root.querySelector(`[data-msg="${id}"]`)?.value || '';
  root.onclick = async (e) => {
    const t = e.target.closest('[data-act]');
    if (!t || !root.contains(t)) return;
    const id = t.dataset.id;
    const act = t.dataset.act;
    if (act === 'open') {
      chosen.set(id, t.dataset.ch);
      const card = d.cards.find((c) => String(c.id) === id);
      const text = msgOf(id);
      if (t.dataset.ch === 'whatsapp' && card?.links?.whatsapp_phone) t.href = `https://wa.me/${card.links.whatsapp_phone}?text=${encodeURIComponent(text)}`;
      if (t.dataset.ch === 'instagram' && text) {
        try { await navigator.clipboard.writeText(text); toast('Texto copiado — cole na conversa do Instagram'); } catch { /* sem permissão de cópia */ }
      }
      t.closest('.task')?.classList.add('touched');
      return; // segue o link normalmente
    }
    e.preventDefault();
    try {
      if (act === 'done') { busy(t, true); await api('POST', `/api/tasks/${id}/done`, { channel: chosen.get(id) }); toast('Feito'); remove(id); }
      else if (act === 'snooze') { await api('POST', `/api/tasks/${id}/snooze`); toast('Fica para amanhã'); remove(id); }
      else if (act === 'skip') { await api('POST', `/api/tasks/${id}/skip`); remove(id); }
      else if (act === 'block') { if (!window.confirm('Não contatar mais esta empresa por nenhum canal?')) return; await api('POST', `/api/tasks/${id}/block`); toast('Não será mais contatada'); remove(id); }
      else if (act === 'decide') { await api('POST', `/api/tasks/${id}/decide`, { verdict: t.dataset.v }); toast(t.dataset.v === 'approve' ? 'Liberada' : 'Bloqueada'); remove(id); }
      else if (act === 'replan') { busy(t, true); await api('POST', '/api/today/plan'); today(root); }
      else if (act === 'company') { const { openCompany } = await import('./views.js'); openCompany(+t.dataset.cid, () => today(root)); }
      else if (act === 'conv') { window.location.hash = `#/conversas/${t.dataset.conv}`; }
      else if (act === 'quick') { quickReply(+t.dataset.conv, t.dataset.tpl, () => remove(id)); }
    } catch (err) { fail(err); busy(t, false); }
  };
}

function quickReply(convId, template, after) {
  openSheet(template === 'slots' ? 'Enviar horários' : 'Pedir telefone', async (body) => {
    mount(body, loading);
    let r;
    try { r = await api('POST', `/api/conversations/${convId}/quick-reply`, { template }); } catch (e) { mount(body, html`<div class="banner bad">${icon('alert')}<div class="grow"><p>${e.message}</p></div></div>`); return; }
    mount(body, html`<form class="stack" id="qr"><label class="field"><span>Revise e envie pelo Gmail</span><textarea name="body" rows="9">${r.body}</textarea></label>
      <button class="btn accent block" type="submit">${icon('send')}Enviar</button></form>`);
    body.querySelector('#qr').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button');
      busy(btn, true);
      try { await api('POST', `/api/conversations/${convId}/reply`, { body: e.target.body.value }); toast('Resposta enviada'); closeSheet(); after?.(); }
      catch (err) { fail(err); busy(btn, false); }
    });
  });
}

export { STAGE_LABEL, fmtRel };
