// Telas do painel. Todos os números vêm da API (banco real); nada é inventado no cliente.
import {
  api, html, raw, mount, icon, toast, fail, openSheet, closeSheet, fmtInt, fmtPct, fmtDate, fmtRel, META, STAGE_LABEL,
  stageChip, priorityChip, exclChip, scoreBox, formData, daysPicker, sw, busy, PRIORITY, EXCL, esc,
} from './core.js';

const loading = html`<div class="stack"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>`;
const head = (title, sub, actions = '') => html`<div class="page-head"><div><h1>${title}</h1>${sub ? html`<p class="muted small">${sub}</p>` : ''}</div><div class="row">${actions}</div></div>`;
const empty = (ic, text, action = '') => html`<div class="empty">${icon(ic)}<p>${text}</p>${action}</div>`;
const on = (root, handlers) => {
  root.onclick = (e) => { const t = e.target.closest('[data-act]'); if (t && root.contains(t) && handlers[t.dataset.act]) { e.preventDefault(); handlers[t.dataset.act](t, e); } };
  root.onsubmit = (e) => { const f = e.target.closest('form[data-form]'); if (f && handlers[f.dataset.form]) { e.preventDefault(); handlers[f.dataset.form](f, e.submitter); } };
};
const errorBox = (e) => html`<div class="banner bad">${icon('alert')}<div class="grow"><strong>Não foi possível carregar</strong><p>${e.message}</p></div></div>`;

// ======================= DASHBOARD =======================
export async function dashboard(root) {
  mount(root, html`${head('Início', 'Resultados reais da prospecção')}${loading}`);
  let d;
  try { d = await api('GET', '/api/dashboard'); } catch (e) { mount(root, errorBox(e)); return; }
  const m = d.metrics;
  const contacted = m.contacted_real + m.contacted_simulated;
  const funnel = [
    ['Descobertas', m.companies], ['Qualificadas', m.qualified], ['Contatadas', contacted], ['Responderam', m.replied_leads], ['Interessadas', m.interested], ['Reuniões', m.meetings],
  ];
  const max = Math.max(1, ...funnel.map((f) => f[1]));
  const banners = [];
  if (d.system.emergency_stop) banners.push(html`<div class="banner bad">${icon('stop')}<div class="grow"><strong>Pausa emergencial ativa</strong><p>Nada é executado. Desative em Automação.</p></div></div>`);
  else if (d.system.paused) banners.push(html`<div class="banner warn">${icon('pause')}<div class="grow"><strong>Sistema pausado</strong><p>${d.system.paused_reason || ''} — só a leitura de respostas continua.</p></div></div>`);
  if (d.mode === 'simulation') banners.push(html`<div class="banner info">${icon('info')}<div class="grow"><strong>Modo simulação</strong><p>Nenhum e-mail sai de verdade. Revise as mensagens em Conversas e ative o envio real em Configurações.</p></div></div>`);
  if (m.needs_review || m.conversations_review) banners.push(html`<a class="banner warn" href="#/conversas?f=review">${icon('alert')}<div class="grow"><strong>${fmtInt(m.needs_review + m.conversations_review)} item(ns) aguardando sua revisão</strong><p>Respostas ambíguas e empresas em dúvida na lista de exclusão.</p></div>${icon('chev', 'chev')}</a>`);
  const alerts = d.alerts.length ? html`<div class="card flat gap-top"><div class="card-head"><h2>Alertas</h2><button class="btn small ghost" data-act="seen">Marcar como vistos</button></div>
    <div class="stack-s">${d.alerts.map((a) => html`<div class="row small"><span class="chip ${a.level === 'alert' ? 'warn' : 'bad'}">${a.agent}</span><span class="grow">${a.message}</span><span class="faint xs">${fmtRel(a.created_at)}</span></div>`)}</div></div>` : '';
  mount(root, html`
    ${head('Início', 'Resultados reais da prospecção', html`<span class="chip ${d.mode === 'live' ? 'ok live' : 'info'}"><span class="pip"></span>${d.mode === 'live' ? 'Envio real' : 'Simulação'}</span>`)}
    ${banners}
    <div class="kpis">
      <div class="kpi hero"><span class="label">Reuniões marcadas</span><span class="value">${fmtInt(m.meetings)}</span><span class="sub">${fmtInt(m.upcoming_meetings)} próxima(s) · conversão ${fmtPct(m.conversion_rate)} dos contatados</span></div>
      <div class="kpi"><span class="label">Empresas descobertas</span><span class="value">${fmtInt(m.companies)}</span><span class="sub">${fmtInt(m.blocked)} bloqueadas (saúde/concorrentes)</span></div>
      <div class="kpi"><span class="label">Leads qualificados</span><span class="value">${fmtInt(m.qualified)}</span><span class="sub">${fmtInt(m.high)} com prioridade alta</span></div>
      <div class="kpi"><span class="label">Leads pendentes</span><span class="value">${fmtInt(m.pending)}</span><span class="sub">sem canal ou em revisão · ${fmtInt(m.researching)} em análise</span></div>
      <div class="kpi"><span class="label">Contatos realizados</span><span class="value">${fmtInt(contacted)}</span><span class="sub">${fmtInt(m.contacted_real)} reais · ${fmtInt(m.contacted_simulated)} simulados</span></div>
      <div class="kpi"><span class="label">Respostas recebidas</span><span class="value">${fmtInt(m.received)}</span><span class="sub">${fmtInt(m.replied_leads)} empresa(s)</span></div>
      <div class="kpi"><span class="label">Taxa de resposta</span><span class="value">${fmtPct(m.response_rate)}</span><span class="sub">respostas ÷ contatados</span></div>
      <div class="kpi"><span class="label">Interessados</span><span class="value">${fmtInt(m.interested)}</span><span class="sub">${fmtInt(m.converted)} convertido(s)</span></div>
      <div class="kpi"><span class="label">Aguardando envio</span><span class="value">${fmtInt(m.waiting)}</span><span class="sub">mensagens prontas na fila</span></div>
    </div>
    ${alerts}
    <p class="section-title">Funil</p>
    <div class="card flat"><div class="funnel">${funnel.map(([l, n]) => html`<div class="funnel-row"><span class="muted">${l}</span><div class="bar"><i data-w="${(n / max) * 100}"></i></div><span class="num small">${fmtInt(n)}</span></div>`)}</div></div>
    ${d.segments.length ? html`<p class="section-title">Qualificados por segmento</p><div class="card flat"><div class="funnel">${d.segments.map((s) => html`<div class="funnel-row"><span class="muted ellipsis">${META.segments[s.segment] || s.segment || '—'}</span><div class="bar ink"><i data-w="${(s.n / d.segments[0].n) * 100}"></i></div><span class="num small">${s.n}</span></div>`)}</div></div>` : ''}
    <p class="section-title">Atividade recente</p>
    ${d.recent.length ? html`<div class="card flat"><div class="feed">${d.recent.map((r) => html`<div class="feed-item"><div class="rail"></div><div><div class="row between"><a href="#/empresas/${r.company_id}" class="small"><strong>${r.name}</strong></a><span class="faint xs">${fmtRel(r.created_at)}</span></div><div class="small muted">${STAGE_LABEL[r.to_stage] || r.to_stage} · ${r.reason || ''}</div></div></div>`)}</div></div>` : html`<div class="card flat">${empty('bolt', 'Ainda sem atividade. Cadastre alvos de descoberta em Automação ou faça uma busca em Empresas.', html`<a class="btn small" href="#/empresas">Buscar empresas</a>`)}</div>`}
  `);
  on(root, { seen: async () => { await api('POST', '/api/alerts/seen'); dashboard(root); } });
}

// ======================= EMPRESAS =======================
const companyState = { q: '', priority: '', exclusion: '', stage: '', segment: '', sort: 'score', page: 0 };

export async function companies(root, params) {
  if (params.id) { companies(root, {}); openCompany(+params.id); return; }
  const render = async () => {
    const qs = new URLSearchParams(Object.entries(companyState).filter(([, v]) => v !== '' && v != null)).toString();
    let d;
    try { d = await api('GET', `/api/companies?${qs}`); } catch (e) { mount(listEl, errorBox(e)); return; }
    mount(listEl, d.items.length ? html`
      <p class="faint xs">${fmtInt(d.total)} empresa(s)</p>
      <div class="list gap-top">${d.items.map((c) => html`<button class="item" data-act="open" data-id="${c.id}">
        ${scoreBox(c.score, c.priority)}
        <div class="grow"><div class="title ellipsis">${c.name}</div><div class="meta ellipsis">${[c.city, META.segments[c.segment] || c.segment, c.domain].filter(Boolean).join(' · ')}</div>
        <div class="row wrap gap-top-s">${c.stage ? stageChip(c.stage) : ''}${exclChip(c.exclusion_status)}${c.contact_pending ? html`<span class="chip">sem e-mail</span>` : ''}${c.needs_review ? html`<span class="chip warn">revisar</span>` : ''}</div></div>
        ${icon('chev', 'chev')}</button>`)}</div>
      <div class="row between gap-top"><button class="btn small ghost" data-act="prev" ${companyState.page ? '' : raw('disabled')}>Anterior</button><span class="faint xs">página ${companyState.page + 1}</span><button class="btn small ghost" data-act="next" ${(companyState.page + 1) * 50 < d.total ? '' : raw('disabled')}>Próxima</button></div>`
      : html`<div class="card flat">${empty('building', 'Nenhuma empresa com esses filtros.', html`<button class="btn small" data-act="discover">Descobrir empresas</button>`)}</div>`);
    const segSel = root.querySelector('select[name=segment]');
    if (segSel && segSel.options.length <= 1) {
      for (const s of d.segments) { const o = document.createElement('option'); o.value = s.segment || ''; o.textContent = `${META.segments[s.segment] || s.segment || '—'} (${s.n})`; segSel.append(o); }
      segSel.value = companyState.segment;
    }
  };
  const filters = [['', 'Todas'], ['alta', 'Alta'], ['media', 'Média'], ['baixa', 'Baixa'], ['nao_automatico', 'Manual']];
  mount(root, html`
    ${head('Empresas', 'Descobertas em fontes abertas e analisadas', html`<button class="btn accent" data-act="discover">${icon('plus')}<span>Descobrir</span></button>`)}
    <div class="toolbar">
      <input type="search" name="q" placeholder="Buscar nome, cidade ou site" value="${companyState.q}" aria-label="Buscar">
      <select name="sort" aria-label="Ordenar"><option value="score">Maior pontuação</option><option value="recent">Mais recentes</option><option value="name">Nome</option></select>
    </div>
    <div class="scroll-x">${filters.map(([v, l]) => html`<button class="filter" data-act="prio" data-v="${v}" aria-pressed="${companyState.priority === v}">${l}</button>`)}
      <button class="filter" data-act="excl" data-v="review" aria-pressed="${companyState.exclusion === 'review'}">Em revisão</button>
      <button class="filter" data-act="excl" data-v="block" aria-pressed="${companyState.exclusion === 'block'}">Bloqueadas</button>
    </div>
    <div class="toolbar gap-top"><select name="segment" aria-label="Segmento"><option value="">Todos os segmentos</option></select>
      <select name="stage" aria-label="Etapa"><option value="">Todas as etapas</option>${META.stages.map(([k, l]) => html`<option value="${k}" ${companyState.stage === k ? raw('selected') : ''}>${l}</option>`)}</select></div>
    <div id="clist">${loading}</div>`);
  const listEl = root.querySelector('#clist');
  root.querySelector('select[name=sort]').value = companyState.sort;
  let t;
  root.querySelector('input[name=q]').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { companyState.q = e.target.value; companyState.page = 0; render(); }, 300); });
  root.querySelectorAll('select').forEach((s) => s.addEventListener('change', () => { companyState[s.name] = s.value; companyState.page = 0; render(); }));
  on(root, {
    open: (b) => openCompany(+b.dataset.id, render),
    discover: () => openDiscover(render),
    prio: (b) => { companyState.priority = b.dataset.v; companyState.page = 0; root.querySelectorAll('[data-act=prio]').forEach((x) => x.setAttribute('aria-pressed', x === b)); render(); },
    excl: (b) => { companyState.exclusion = companyState.exclusion === b.dataset.v ? '' : b.dataset.v; root.querySelectorAll('[data-act=excl]').forEach((x) => x.setAttribute('aria-pressed', x.dataset.v === companyState.exclusion)); render(); },
    prev: () => { companyState.page--; render(); }, next: () => { companyState.page++; render(); },
  });
  render();
}

const UFS = 'AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' ');
function discoverForm(t = {}) {
  return html`
    <div class="grid2"><label class="field"><span>País</span><input type="text" name="country" value="${t.country || 'BR'}" maxlength="2" required></label>
    <label class="field"><span>Estado (UF)</span><select name="state">${UFS.map((u) => html`<option ${u === (t.state || 'SC') ? raw('selected') : ''}>${u}</option>`)}</select></label></div>
    <label class="field"><span>Cidade <span class="hint">vazio = estado todo (mais lento)</span></span><input type="text" name="city" value="${t.city || ''}" placeholder="Ex.: Joinville"></label>
    <label class="field"><span>Segmento</span><select name="segment">${Object.entries(META.segments).map(([k, l]) => html`<option value="${k}" ${k === (t.segment || 'construcao') ? raw('selected') : ''}>${l}</option>`)}</select></label>
    <div class="grid2"><label class="field"><span>Tipo (tag OSM) <span class="hint">opcional</span></span><input type="text" name="company_type" value="${t.company_type || ''}" placeholder="office=lawyer"></label>
    <label class="field"><span>Máx. resultados</span><input type="number" name="max" value="${t.max || 30}" min="1" max="200"></label></div>
    <label class="field"><span>Palavras-chave no nome <span class="hint">separadas por vírgula</span></span><input type="text" name="keywords" value="${(t.keywords || []).join?.(', ') || t.keywords || ''}" placeholder="construtora, incorporadora"></label>
    ${sw('require_website', t.require_website !== false, 'Só empresas com site publicado')}`;
}
function openDiscover(after) {
  openSheet('Descobrir empresas', (body, close) => {
    let mode = 'osm';
    const draw = () => mount(body, html`
      <div class="seg" role="group"><button data-act="m" data-v="osm" aria-pressed="${mode === 'osm'}">OpenStreetMap</button><button data-act="m" data-v="manual" aria-pressed="${mode === 'manual'}">Importar lista</button></div>
      ${mode === 'osm' ? html`<form data-form="osm" class="stack gap-top">
        <p class="small muted">Fonte aberta (dados ODbL). A busca respeita a política de uso da Overpass: uma consulta por vez, identificada. A lista de exclusão é aplicada antes de gravar.</p>
        ${discoverForm()}
        <button class="btn accent block" type="submit">${icon('search')}Buscar agora</button>
        <p class="hint">A consulta pode levar até 1–2 minutos quando o servidor público está ocupado.</p></form>`
      : html`<form data-form="manual" class="stack gap-top">
        <p class="small muted">Uma empresa por linha: <span class="mono">nome; site; cidade; UF; segmento; e-mail; telefone</span>. Só o nome é obrigatório. Use apenas dados públicos e comerciais.</p>
        <label class="field"><span>Lista</span><textarea name="text" rows="8" placeholder="Construtora Exemplo; construtoraexemplo.com.br; Curitiba; PR; construcao"></textarea></label>
        <button class="btn accent block" type="submit">Importar</button></form>`}`);
    draw();
    on(body, {
      m: (b) => { mode = b.dataset.v; draw(); },
      osm: async (f, btn) => {
        busy(btn, true);
        try {
          const r = await api('POST', '/api/discover', { ...formData(f), run_now: true });
          const run = r.summary?.ran?.find((x) => x.id === r.job_id) || r.summary?.ran?.[0];
          if (run?.ok) { const c = run.result; toast(`${c.inserted} nova(s) · ${c.duplicates} repetida(s) · ${c.blocked} bloqueada(s) · ${c.review} em revisão`); close(); after?.(); }
          else if (run) fail(new Error(run.error));
          else toast('Busca na fila — roda no próximo ciclo do agendador.');
        } catch (e) { fail(e); } finally { busy(btn, false); }
      },
      manual: async (f, btn) => {
        busy(btn, true);
        try { const r = await api('POST', '/api/import', formData(f)); toast(`${r.inserted} importada(s) · ${r.duplicates} repetida(s) · ${r.blocked} bloqueada(s)`); close(); after?.(); }
        catch (e) { fail(e); } finally { busy(btn, false); }
      },
    });
  });
}

const KIND = { confirmed: ['Confirmado', 'ok'], probable: ['Provável', 'warn'], unknown: ['Desconhecido', ''] };
export function openCompany(id, after) {
  const s = openSheet('Empresa', async (body) => {
    mount(body, loading);
    let d;
    try { d = await api('GET', `/api/companies/${id}`); } catch (e) { mount(body, errorBox(e)); return; }
    s.setTitle(d.company.name);
    let tab = 'analise';
    const c = d.company, l = d.lead, a = d.analysis, sc = d.score;
    const draw = () => {
      const panes = {
        analise: () => a ? html`
          <div class="row wrap small muted">${a.final_url ? html`<a href="${a.final_url}" target="_blank" rel="noopener noreferrer">${icon('globe')} ${a.final_url}</a>` : ''}
            ${a.http_status ? html`<span class="chip">HTTP ${a.http_status}</span>` : ''}${a.response_ms != null ? html`<span class="chip">${(a.response_ms / 1000).toFixed(1)} s</span>` : ''}
            <span class="faint xs">analisado ${fmtRel(a.analyzed_at)}</span></div>
          <div class="gap-top">${a.findings.map((f) => html`<div class="finding"><span class="chip ${KIND[f.kind][1]}">${KIND[f.kind][0]}</span><div><div class="small"><strong>${f.title}</strong>${f.service ? html` <span class="faint xs">→ ${META.services[f.service] || f.service}</span>` : ''}</div><div class="ev">${f.evidence}</div></div></div>`)}</div>
          ${a.signals?.derived?.tools?.length ? html`<p class="section-title">Ferramentas detectadas no HTML</p><div class="row wrap">${a.signals.derived.tools.map((t) => html`<span class="chip">${t.name}</span>`)}</div>` : ''}
          ${a.signals?.cnpj ? html`<p class="section-title">CNPJ (BrasilAPI)</p><dl class="kv"><dt>CNPJ</dt><dd class="mono">${a.signals.cnpj.number}</dd><dt>Situação</dt><dd>${a.signals.cnpj.situacao || '—'}</dd><dt>CNAE</dt><dd>${a.signals.cnpj.cnae_code} · ${a.signals.cnpj.cnae_description || ''}</dd></dl>` : ''}`
          : html`<p class="muted small">Ainda não analisada.</p>`,
        pontos: () => sc ? html`<div class="row"><div>${scoreBox(sc.score, sc.priority, true)}</div><div><strong>Prioridade ${PRIORITY[sc.priority]?.[0]}</strong><div class="small muted">Serviço mais compatível: ${META.services[sc.service_fit] || '—'}</div></div></div>
          <div class="stack gap-top">${sc.breakdown.map((b) => html`<div><div class="row between small"><strong>${b.criterion}</strong><span class="num">${b.points}/${b.max}</span></div><div class="bar gap-top-s"><i data-w="${(b.points / b.max) * 100}"></i></div><div class="xs muted gap-top-s">${b.reason}</div></div>`)}</div>
          <details class="gap-top"><summary class="small">Explicação completa</summary><p class="pre small muted gap-top">${sc.explanation}</p></details>` : html`<p class="muted small">Ainda sem pontuação.</p>`,
        contatos: () => d.contacts.length ? html`<div class="stack">${d.contacts.map((ct) => html`<div class="card flat tight"><div class="row between"><strong class="small">${ct.type === 'email' ? ct.value : ct.type === 'form' ? 'Formulário no site' : ct.type === 'phone' ? ct.value : ct.type === 'whatsapp' ? 'WhatsApp' : ct.value}</strong>
          <span class="chip ${ct.status === 'valid' ? 'ok' : ct.status === 'suppressed' || ct.status === 'invalid' ? 'bad' : 'warn'}">${{ valid: 'Válido', pending_review: 'Revisar', suppressed: 'Suprimido', invalid: 'Não usar' }[ct.status]}</span></div>
          <p class="xs muted gap-top-s">${ct.legal_basis_notes || ''}</p>
          ${ct.sources.map((so) => html`<p class="xs faint gap-top-s">Fonte: ${so.source_type} · ${so.evidence} ${so.source_url ? html`· <a href="${so.source_url}" target="_blank" rel="noopener noreferrer">ver</a>` : ''} · ${fmtDate(so.collected_at)}</p>`)}</div>`)}</div>`
          : html`<p class="muted small">Nenhum canal comercial publicado encontrado. O lead fica pendente.</p>`,
        historico: () => html`${d.messages.length ? html`<p class="section-title">Mensagens</p><div class="thread">${d.messages.map((m) => html`<div class="bubble ${m.direction} ${m.status === 'simulated' || m.status === 'draft' ? 'sim' : ''}"><strong>${m.subject || ''}</strong>\n${m.body_text}<div class="bmeta"><span>${{ draft: 'Rascunho', simulated: 'Simulado', sent: 'Enviado', received: 'Recebido', cancelled: 'Cancelado', sending: 'Enviando', failed: 'Falhou' }[m.status] || m.status}</span><span>${fmtDate(m.sent_at || m.received_at || m.created_at)}</span>${m.classification ? html`<span class="chip">${META.classes[m.classification] || m.classification}</span>` : ''}</div></div>`)}</div>` : ''}
          <p class="section-title">Etapas</p>${d.history.length ? html`<div class="feed">${d.history.map((h) => html`<div class="feed-item"><div class="rail"></div><div><div class="row between small"><strong>${STAGE_LABEL[h.to_stage] || h.to_stage}</strong><span class="faint xs">${fmtDate(h.created_at)}</span></div><div class="xs muted">${h.reason || ''} · ${h.actor}</div></div></div>`)}</div>` : html`<p class="muted small">Sem histórico.</p>`}`,
        acoes: () => html`<div class="stack">
          ${l ? html`<label class="field"><span>Mover para a etapa</span><div class="row"><select name="stage" class="grow">${META.stages.map(([k, lab]) => html`<option value="${k}" ${l.stage === k ? raw('selected') : ''}>${lab}</option>`)}</select><button class="btn" data-act="stage">Mover</button></div></label>` : ''}
          ${c.exclusion_status === 'review' ? html`<div class="banner warn">${icon('alert')}<div class="grow"><strong>Em revisão na lista de exclusão</strong><p>${c.exclusion_reason || ''}</p><p>Libere só se tiver certeza de que não é saúde nem concorrente da Arco.</p></div></div><button class="btn ok" data-act="approve">${icon('check')}Liberar para prospecção</button>` : ''}
          ${l?.needs_review && c.exclusion_status !== 'review' ? html`<button class="btn soft" data-act="reviewed">${icon('check')}Marcar revisão como feita</button>` : ''}
          <button class="btn soft" data-act="reinvestigate">${icon('refresh')}Analisar o site de novo</button>
          ${c.exclusion_status !== 'block' ? html`<button class="btn danger-ghost" data-act="block">${icon('ban')}Bloquear empresa</button>` : html`<div class="banner bad">${icon('ban')}<div class="grow"><strong>Bloqueada</strong><p>${c.exclusion_reason || ''}</p></div></div>`}
          <button class="btn danger-ghost" data-act="delete">${icon('trash')}Excluir dados da empresa</button>
          <dl class="kv small gap-top"><dt>Fonte</dt><dd>${c.source}${c.source_url ? html` · <a href="${c.source_url}" target="_blank" rel="noopener noreferrer">${c.source_ref}</a>` : ''}</dd><dt>Descoberta</dt><dd>${fmtDate(c.discovered_at)}</dd><dt>Segmento</dt><dd>${META.segments[c.segment] || c.segment || '—'}</dd><dt>Cidade</dt><dd>${[c.city, c.state].filter(Boolean).join(' / ') || '—'}</dd><dt>Telefone</dt><dd>${c.phone || '—'}</dd></dl>
        </div>`,
      };
      mount(body, html`
        <div class="row">${scoreBox(l?.score, l?.priority)}<div class="grow"><div class="row wrap">${l ? stageChip(l.stage) : ''}${priorityChip(l?.priority)}${exclChip(c.exclusion_status)}</div><div class="small muted gap-top-s ellipsis">${[c.city, META.segments[c.segment] || c.segment, c.domain].filter(Boolean).join(' · ')}</div></div></div>
        <div class="tabs gap-top" role="tablist">${[['analise', 'Análise'], ['pontos', 'Pontuação'], ['contatos', 'Contatos'], ['historico', 'Histórico'], ['acoes', 'Ações']].map(([k, lab]) => html`<button role="tab" data-act="tab" data-v="${k}" aria-selected="${tab === k}">${lab}</button>`)}</div>
        ${panes[tab]()}`);
    };
    draw();
    const act = async (fn, msg) => { try { await fn(); toast(msg); closeSheet(); after?.(); } catch (e) { fail(e); } };
    on(body, {
      tab: (b) => { tab = b.dataset.v; draw(); },
      stage: () => act(() => api('POST', `/api/leads/${l.id}/stage`, { stage: body.querySelector('select[name=stage]').value }), 'Etapa atualizada'),
      approve: () => window.confirm('Confirma que esta empresa NÃO é do setor de saúde nem concorrente da Arco?') && act(() => api('POST', `/api/companies/${id}/approve`), 'Empresa liberada'),
      reviewed: () => act(() => api('POST', `/api/leads/${l.id}/review-done`), 'Revisão concluída'),
      reinvestigate: () => act(() => api('POST', `/api/companies/${id}/reinvestigate`), 'Na fila para nova análise'),
      block: () => { const reason = window.prompt('Motivo do bloqueio (opcional):', ''); if (reason === null) return; act(() => api('POST', `/api/companies/${id}/block`, { reason, add_rule: window.confirm('Adicionar o domínio desta empresa à lista de exclusão?') }), 'Empresa bloqueada'); },
      delete: () => window.confirm('Excluir todos os dados desta empresa? Isso não pode ser desfeito.') && act(() => api('DELETE', `/api/companies/${id}`), 'Dados excluídos'),
    });
  });
}

// ======================= PIPELINE =======================
export async function pipeline(root) {
  mount(root, html`${head('Pipeline', 'Cada empresa em uma etapa')}${loading}`);
  let d;
  try { d = await api('GET', '/api/pipeline'); } catch (e) { mount(root, errorBox(e)); return; }
  const by = {};
  for (const it of d.items) (by[it.stage] ||= []).push(it);
  mount(root, html`${head('Pipeline', 'Cada empresa em uma etapa — deslize para os lados')}
    <div class="board">${d.stages.map(([k, label]) => html`<section class="col" aria-label="${label}"><div class="col-head"><span>${label}</span><span class="chip num">${fmtInt(d.counts[k] || 0)}</span></div>
      ${(by[k] || []).map((x) => html`<button class="lead-card" data-act="open" data-id="${x.company_id}">${scoreBox(x.score, x.priority)}<div class="grow"><div class="small ellipsis"><strong>${x.name}</strong></div><div class="xs muted ellipsis">${[x.city, META.segments[x.segment] || x.segment].filter(Boolean).join(' · ')}</div></div>${x.needs_review ? html`<span class="chip warn">!</span>` : ''}</button>`)}
      ${(d.counts[k] || 0) > (by[k] || []).length ? html`<a class="xs muted" href="#/empresas">+ ${(d.counts[k] || 0) - (by[k] || []).length} em Empresas</a>` : ''}
      ${!(by[k] || []).length ? html`<p class="xs faint">Vazio</p>` : ''}</section>`)}</div>`);
  on(root, { open: (b) => openCompany(+b.dataset.id, () => pipeline(root)) });
}

// ======================= CONVERSAS =======================
let convFilter = 'all';
export async function conversations(root, params) {
  if (params.f) convFilter = params.f;
  if (params.id) { openConversation(+params.id, () => conversations(root, {})); }
  mount(root, html`${head('Conversas', 'Mensagens enviadas, simuladas e recebidas')}
    <div class="seg" role="group">${[['review', 'Revisão'], ['replied', 'Respostas'], ['drafts', 'Rascunhos'], ['all', 'Todas']].map(([k, l]) => html`<button data-act="f" data-v="${k}" aria-pressed="${convFilter === k}">${l}</button>`)}</div>
    <div id="cv" class="gap-top">${loading}</div>`);
  const list = root.querySelector('#cv');
  const render = async () => {
    let d;
    try { d = await api('GET', `/api/conversations?filter=${convFilter}`); } catch (e) { mount(list, errorBox(e)); return; }
    mount(list, d.items.length ? html`<div class="list">${d.items.map((c) => html`<button class="item" data-act="open" data-id="${c.id}">
      <div class="grow"><div class="row between"><span class="title ellipsis">${c.name}</span><span class="faint xs">${fmtRel(c.last_message_at || c.created_at)}</span></div>
      <div class="meta ellipsis">${c.last_direction === 'in' ? '↩ ' : ''}${c.last_body || ''}</div>
      <div class="row wrap gap-top-s">${c.status === 'needs_review' ? html`<span class="chip warn">Revisão necessária</span>` : ''}${c.last_class ? html`<span class="chip">${META.classes[c.last_class] || c.last_class}</span>` : ''}${c.last_status === 'simulated' ? html`<span class="chip info">Simulado</span>` : c.last_status === 'draft' ? html`<span class="chip">Rascunho</span>` : ''}${stageChip(c.stage)}</div></div>${icon('chev', 'chev')}</button>`)}</div>`
      : html`<div class="card flat">${empty('chat', convFilter === 'review' ? 'Nada aguardando revisão.' : 'Nenhuma conversa ainda.')}</div>`);
  };
  on(root, {
    f: (b) => { convFilter = b.dataset.v; root.querySelectorAll('[data-act=f]').forEach((x) => x.setAttribute('aria-pressed', x === b)); render(); },
    open: (b) => openConversation(+b.dataset.id, render),
  });
  render();
}

function openConversation(id, after) {
  const s = openSheet('Conversa', async (body) => {
    mount(body, loading);
    let d;
    try { d = await api('GET', `/api/conversations/${id}`); } catch (e) { mount(body, errorBox(e)); return; }
    const c = d.conversation;
    s.setTitle(c.name);
    const draft = d.messages.find((m) => m.status === 'draft');
    const lastIn = [...d.messages].reverse().find((m) => m.direction === 'in');
    mount(body, html`
      <div class="row wrap">${stageChip(c.stage)}${c.status === 'needs_review' ? html`<span class="chip warn">Revisão necessária</span>` : ''}<span class="faint xs">${c.contact_email || ''}</span>
        <a class="btn small ghost" href="#/empresas/${c.company_id}">Empresa</a></div>
      ${lastIn?.classification_reason ? html`<div class="banner ${lastIn.needs_review ? 'warn' : 'info'} gap-top">${icon('info')}<div class="grow"><strong>${META.classes[lastIn.classification] || lastIn.classification}</strong><p>${lastIn.classification_reason}</p></div></div>` : ''}
      <div class="thread gap-top">${d.messages.map((m) => html`<div class="bubble ${m.direction} ${m.status === 'simulated' || m.status === 'draft' || m.status === 'cancelled' ? 'sim' : ''}">${m.subject ? html`<strong>${m.subject}</strong>\n` : ''}${m.body_text}
        <div class="bmeta"><span>${{ draft: 'Rascunho', simulated: 'Simulado — não enviado', sent: 'Enviado', received: 'Recebido', cancelled: 'Cancelado', sending: 'Enviando', failed: 'Falhou' }[m.status] || m.status}</span><span>${fmtDate(m.sent_at || m.received_at || m.created_at)}</span>${m.error ? html`<span>${m.error}</span>` : ''}</div></div>`)}</div>
      ${draft ? html`<button class="btn danger-ghost block gap-top" data-act="cancel" data-id="${draft.id}">Cancelar rascunho (não enviar)</button>` : ''}
      ${lastIn ? html`<form data-form="resolve" class="card flat stack gap-top"><h3>Classificação</h3><div class="row"><select name="classification" class="grow">${Object.entries(META.classes).map(([k, l]) => html`<option value="${k}" ${lastIn.classification === k ? raw('selected') : ''}>${l}</option>`)}</select><button class="btn soft" type="submit">Salvar e resolver</button></div><p class="hint">Recusa e descadastro bloqueiam novos contatos com este endereço.</p></form>` : ''}
      ${c.contact_status !== 'suppressed' && lastIn ? html`<form data-form="reply" class="stack gap-top"><label class="field"><span>Responder pelo Gmail <span class="hint">texto seu, enviado na mesma conversa</span></span><textarea name="body" rows="5" required></textarea></label>
        <div class="row"><button class="btn soft" type="button" data-act="link">${icon('link')}Inserir link de agenda</button><button class="btn accent grow" type="submit">${icon('send')}Enviar</button></div></form>` : ''}`);
    on(body, {
      cancel: async (b) => { try { await api('POST', `/api/messages/${b.dataset.id}/cancel`); toast('Rascunho cancelado'); closeSheet(); after?.(); } catch (e) { fail(e); } },
      resolve: async (f) => { try { await api('POST', `/api/conversations/${id}/resolve`, formData(f)); toast('Conversa resolvida'); closeSheet(); after?.(); } catch (e) { fail(e); } },
      link: async () => { try { const r = await api('POST', `/api/conversations/${id}/booking-link`); const ta = body.querySelector('textarea[name=body]'); ta.value += `${ta.value ? '\n\n' : ''}Escolha um horário: ${r.url}`; ta.focus(); } catch (e) { fail(e); } },
      reply: async (f, btn) => { busy(btn, true); try { await api('POST', `/api/conversations/${id}/reply`, formData(f)); toast('Resposta enviada'); closeSheet(); after?.(); } catch (e) { fail(e); } finally { busy(btn, false); } },
    });
  });
}

// ======================= AGENDA =======================
export async function agenda(root) {
  mount(root, html`${head('Agenda', 'Reuniões marcadas pelo link de agendamento')}${loading}`);
  let d;
  try { d = await api('GET', '/api/appointments'); } catch (e) { mount(root, errorBox(e)); return; }
  const now = new Date().toISOString();
  const booked = d.items.filter((a) => a.status === 'booked');
  const upcoming = booked.filter((a) => a.starts_at >= now).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const past = booked.filter((a) => a.starts_at < now);
  const row = (a) => html`<div class="item"><div class="score accent">${fmtDate(a.starts_at, { day: '2-digit' })}</div><div class="grow"><div class="title">${a.name}</div><div class="meta">${fmtDate(a.starts_at, { weekday: 'long', day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit' })} · ${a.attendee_email || ''}</div></div>
    ${a.html_link ? html`<a class="icon-btn" href="${a.html_link}" target="_blank" rel="noopener noreferrer" aria-label="Abrir no Google Agenda">${icon('calendar')}</a>` : ''}${a.starts_at >= now ? html`<button class="icon-btn" data-act="cancel" data-id="${a.id}" aria-label="Cancelar reunião">${icon('x')}</button>` : ''}</div>`;
  mount(root, html`${head('Agenda', 'Reuniões marcadas pelo link de agendamento', html`<button class="btn soft" data-act="preview">${icon('calendar')}Horários livres</button>`)}
    <p class="section-title">Próximas</p>${upcoming.length ? html`<div class="list">${upcoming.map(row)}</div>` : html`<div class="card flat">${empty('calendar', 'Nenhuma reunião marcada.')}</div>`}
    ${past.length ? html`<p class="section-title">Anteriores</p><div class="list">${past.map(row)}</div>` : ''}
    <div id="slots"></div>`);
  on(root, {
    cancel: async (b) => { if (!window.confirm('Cancelar esta reunião? O convidado recebe o cancelamento pelo Google Agenda.')) return; try { await api('POST', `/api/appointments/${b.dataset.id}/cancel`); toast('Reunião cancelada'); agenda(root); } catch (e) { fail(e); } },
    preview: async (b) => {
      busy(b, true);
      try { const r = await api('GET', '/api/availability/preview'); mount(root.querySelector('#slots'), html`<p class="section-title">Próximos horários livres (Google Agenda)</p><div class="card flat"><div class="row wrap">${r.slots.length ? r.slots.map((s) => html`<span class="chip">${fmtDate(s.start, { weekday: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>`) : html`<span class="muted small">Sem horários livres no período configurado.</span>`}</div></div>`); }
      catch (e) { fail(e); } finally { busy(b, false); }
    },
  });
}

// ======================= AUTOMAÇÃO =======================
const AGENTS = [['finder', 'Finder', 'Descobre empresas'], ['investigator', 'Investigator', 'Analisa sites'], ['scorer', 'Scorer', 'Contatos e pontuação'], ['copywriter', 'Copywriter', 'Prepara mensagens'], ['outreach', 'Outreach', 'Envia e-mails'], ['inbox', 'Inbox', 'Lê respostas'], ['closer', 'Closer', 'Primeira resposta'], ['followup', 'Follow-up', 'Retoma sem resposta'], ['report', 'Relatório', 'Limpeza e resumo']];
const JOB = { pending: ['Na fila', ''], running: ['Rodando', 'info'], done: ['Concluída', 'ok'], failed: ['Falhou', 'bad'], dead: ['Desistiu', 'bad'], cancelled: ['Cancelada', ''] };
export async function automation(root) {
  mount(root, html`${head('Automação', 'Rotina, agentes, fila e erros')}${loading}`);
  let d;
  try { d = await api('GET', '/api/automation'); } catch (e) { mount(root, errorBox(e)); return; }
  const sys = d.system;
  mount(root, html`${head('Automação', `Agendador central: um Cron a cada minuto · último ciclo ${fmtRel(d.last_tick_at)} · fuso ${d.timezone}`)}
    <div class="card ${sys.emergency_stop ? '' : 'flat'}"><div class="row between wrap">
      <div><h2>${sys.emergency_stop ? 'Pausa emergencial ativa' : sys.paused ? 'Sistema pausado' : 'Sistema rodando'}</h2><p class="small muted">${sys.emergency_stop ? 'Nenhuma tarefa roda até você liberar.' : sys.paused ? 'Só leitura de respostas e relatório continuam.' : 'As tarefas rodam nos horários abaixo, mesmo com você offline.'}</p></div>
      <div class="row wrap">${sys.emergency_stop ? html`<button class="btn" data-act="emergency" data-v="false">Liberar sistema</button>` : html`
        <button class="btn ${sys.paused ? 'accent' : 'soft'}" data-act="pause" data-v="${!sys.paused}">${icon(sys.paused ? 'play' : 'pause')}${sys.paused ? 'Retomar' : 'Pausar'}</button>
        <button class="btn danger" data-act="emergency" data-v="true">${icon('stop')}Pausa emergencial</button>`}</div></div></div>

    <p class="section-title">Agentes</p>
    <div class="card flat"><div class="grid2">${AGENTS.map(([k, l, desc]) => html`<label class="switch"><input type="checkbox" data-agent="${k}" ${d.agents[k] ? raw('checked') : ''}><i></i><span><span>${l}</span><br><span class="xs faint">${desc}</span></span></label>`)}</div></div>

    <p class="section-title">Rotina</p>
    <div class="stack">${d.schedules.map((s) => html`<form class="card flat stack" data-form="sched" data-task="${s.task}">
      <div class="row between wrap"><div><h3>${s.label}</h3><p class="xs faint">${s.last_run_at ? `última execução ${fmtRel(s.last_run_at)}` : 'ainda não rodou'}${s.last_status ? ` · ${s.last_status}` : ''}</p></div>${sw('enabled', !!s.enabled, 'Ativa')}</div>
      ${s.paused_until && s.paused_until > new Date().toISOString() ? html`<div class="banner warn">${icon('pause')}<div class="grow"><strong>Pausada até ${fmtDate(s.paused_until)}</strong><p>${s.paused_reason || ''}</p></div><button class="btn small" type="button" data-act="resume" data-task="${s.task}">Retomar</button></div>` : ''}
      ${daysPicker('days', s.days)}
      <div class="grid3"><label class="field"><span>Início</span><input type="time" name="start_time" value="${s.start_time}" required></label>
        <label class="field"><span>Fim</span><input type="time" name="end_time" value="${s.end_time || ''}"></label>
        <label class="field"><span>A cada (min)</span><input type="number" name="interval_minutes" value="${s.interval_minutes}" min="0" max="720"></label></div>
      <div class="row between wrap"><label class="field"><span>Lote por execução</span><input type="number" name="batch_size" value="${s.batch_size}" min="1" max="50"></label>
        <div class="row"><button class="btn soft small" type="button" data-act="run" data-task="${s.task}">${icon('play')}Rodar agora</button><button class="btn small" type="submit">Salvar</button></div></div>
      <p class="hint">${s.interval_minutes > 0 ? `Roda a cada ${s.interval_minutes} min entre ${s.start_time} e ${s.end_time || '23:59'}.` : `Roda uma vez por dia a partir de ${s.start_time}; se o horário passar sem rodar, roda no próximo ciclo.`}</p></form>`)}</div>

    <p class="section-title">Alvos de descoberta automática</p>
    <div class="card flat stack"><p class="small muted">A tarefa "Descobrir novas empresas" percorre estes alvos em rodízio, uma consulta por execução.</p>
      ${d.targets.length ? html`<div class="list">${d.targets.map((t, i) => html`<div class="item"><div class="grow"><div class="title">${META.segments[t.segment] || t.segment}${t.keywords?.length ? ` · ${t.keywords.join(', ')}` : ''}</div><div class="meta">${t.city || 'Estado todo'} / ${t.state} · até ${t.max}${t.company_type ? ` · ${t.company_type}` : ''}</div></div><button class="icon-btn" data-act="deltarget" data-i="${i}" aria-label="Remover alvo">${icon('trash')}</button></div>`)}</div>` : html`<p class="small faint">Nenhum alvo cadastrado.</p>`}
      <details><summary class="small">${icon('plus')} Adicionar alvo</summary><form data-form="addtarget" class="stack gap-top">${discoverForm()}<button class="btn" type="submit">Adicionar alvo</button></form></details></div>

    <p class="section-title">Fila de tarefas</p>
    <div class="row wrap">${Object.entries(d.job_counts).map(([k, n]) => html`<span class="chip ${JOB[k]?.[1] || ''}">${JOB[k]?.[0] || k}: ${n}</span>`)}</div>
    <div class="card flat gap-top table-wrap"><table class="table"><thead><tr><th>Tarefa</th><th>Status</th><th>Quando</th><th>Resultado</th><th></th></tr></thead><tbody>
      ${d.jobs.map((j) => html`<tr><td>${j.type}</td><td><span class="chip ${JOB[j.status]?.[1]}">${JOB[j.status]?.[0] || j.status}</span>${j.attempts > 1 ? html` <span class="xs faint">${j.attempts}×</span>` : ''}</td><td class="xs muted">${fmtRel(j.finished_at || j.created_at)}</td>
        <td class="xs muted">${j.last_error ? html`<span class="chip bad">erro</span> ${j.last_error}` : j.result ? JSON.stringify(j.result).slice(0, 120) : ''}</td>
        <td>${['failed', 'dead', 'cancelled'].includes(j.status) ? html`<button class="btn small ghost" data-act="retry" data-id="${j.id}">Repetir</button>` : j.status === 'pending' ? html`<button class="btn small ghost" data-act="canceljob" data-id="${j.id}">Cancelar</button>` : ''}</td></tr>`)}</tbody></table></div>

    <p class="section-title">Erros e alertas</p>
    ${d.errors.length ? html`<div class="card flat stack-s">${d.errors.map((e) => html`<div class="row small"><span class="chip ${e.level === 'warn' ? 'warn' : 'bad'}">${e.agent}</span><span class="grow">${e.message}</span><span class="xs faint">${fmtRel(e.created_at)}</span></div>`)}</div>` : html`<div class="card flat"><p class="small muted">Sem erros recentes.</p></div>`}`);

  root.querySelectorAll('[data-agent]').forEach((c) => c.addEventListener('change', async () => {
    try { await api('POST', '/api/agents', { agent: c.dataset.agent, enabled: c.checked }); toast(`${c.dataset.agent}: ${c.checked ? 'ativado' : 'desativado'}`); } catch (e) { c.checked = !c.checked; fail(e); }
  }));
  const reload = () => automation(root);
  on(root, {
    pause: async (b) => { try { await api('POST', '/api/system/pause', { paused: b.dataset.v === 'true', reason: 'Pausa manual' }); reload(); } catch (e) { fail(e); } },
    emergency: async (b) => {
      const onv = b.dataset.v === 'true';
      if (onv && !window.confirm('Ativar a PAUSA EMERGENCIAL? Todas as tarefas param e a fila é cancelada.')) return;
      try { await api('POST', '/api/system/emergency', { on: onv }); if (!onv) await api('POST', '/api/system/pause', { paused: false }); reload(); } catch (e) { fail(e); }
    },
    sched: async (f, btn) => { busy(btn, true); try { await api('PUT', `/api/schedules/${f.dataset.task}`, formData(f)); toast('Rotina salva'); } catch (e) { fail(e); } finally { busy(btn, false); } },
    run: async (b) => {
      busy(b, true);
      try { const r = await api('POST', '/api/jobs/run', { type: b.dataset.task }); const j = r.summary?.ran?.[0]; if (j?.ok) toast(`Concluída: ${JSON.stringify(j.result).slice(0, 140)}`); else if (j) fail(new Error(j.error)); else toast(r.summary?.skipped ? `Não rodou: ${r.summary.skipped}` : 'Na fila'); reload(); }
      catch (e) { fail(e); busy(b, false); }
    },
    resume: async (b) => { try { await api('POST', `/api/schedules/${b.dataset.task}/resume`); reload(); } catch (e) { fail(e); } },
    retry: async (b) => { try { await api('POST', `/api/jobs/${b.dataset.id}/retry`); reload(); } catch (e) { fail(e); } },
    canceljob: async (b) => { try { await api('POST', `/api/jobs/${b.dataset.id}/cancel`); reload(); } catch (e) { fail(e); } },
    deltarget: async (b) => { const t = d.targets.filter((_, i) => i !== +b.dataset.i); try { await api('PUT', '/api/finder/targets', { targets: t }); reload(); } catch (e) { fail(e); } },
    addtarget: async (f) => { try { await api('PUT', '/api/finder/targets', { targets: [...d.targets, formData(f)] }); toast('Alvo adicionado'); reload(); } catch (e) { fail(e); } },
  });
}

// ======================= LISTA DE EXCLUSÃO =======================
const RULE_TYPES = { keyword: 'Palavra-chave (bloqueia)', review_keyword: 'Palavra em dúvida (revisar)', category: 'Categoria (bloqueia)', review_category: 'Categoria em dúvida', cnae: 'CNAE (bloqueia)', review_cnae: 'CNAE em dúvida', domain: 'Domínio (bloqueia)', company: 'Empresa/concorrente (bloqueia)' };
let ruleFilter = '';
export async function exclusions(root) {
  mount(root, html`${head('Lista de exclusão', 'Contrato Arco: nada de saúde nem concorrentes')}${loading}`);
  let d, sup;
  try { [d, sup] = await Promise.all([api('GET', `/api/exclusions${ruleFilter ? `?type=${ruleFilter}` : ''}`), api('GET', '/api/suppression')]); } catch (e) { mount(root, errorBox(e)); return; }
  mount(root, html`${head('Lista de exclusão', 'Contrato Arco: nada de saúde nem concorrentes')}
    <div class="banner info">${icon('shield')}<div class="grow"><strong>Verificação obrigatória</strong><p>Toda empresa passa por estas regras ao ser descoberta, depois da análise do site e de novo antes de cada envio. Em dúvida, ela vai para revisão e não é prospectada automaticamente. ${fmtInt(d.blocked_companies)} empresa(s) bloqueadas até agora.</p></div></div>
    <form data-form="test" class="card flat stack"><h2>Testar uma empresa</h2>
      <div class="grid2"><label class="field"><span>Nome</span><input type="text" name="name" placeholder="Clínica Exemplo"></label><label class="field"><span>Site ou domínio</span><input type="text" name="domain" placeholder="exemplo.com.br"></label></div>
      <div class="grid2"><label class="field"><span>CNAE</span><input type="text" name="cnae" placeholder="8630503"></label><label class="field"><span>Tag OSM</span><input type="text" name="tag" placeholder="amenity=dentist"></label></div>
      <button class="btn soft" type="submit">Testar</button><div id="testres"></div></form>
    <form data-form="add" class="card flat stack gap-top"><h2>Adicionar regra</h2>
      <div class="grid2"><label class="field"><span>Tipo</span><select name="type">${Object.entries(RULE_TYPES).map(([k, l]) => html`<option value="${k}">${l}</option>`)}</select></label><label class="field"><span>Valor</span><input type="text" name="value" required placeholder="ex.: odonto*, arco.ag, 8630"></label></div>
      <label class="field"><span>Motivo</span><input type="text" name="reason" placeholder="Opcional"></label>
      <p class="hint">Palavras: sem acento, "*" no fim vale como prefixo (clinic* pega clínica e clínicas). Categoria: chave=valor do OSM. A regra nova também é aplicada às empresas ainda não contatadas.</p>
      <button class="btn" type="submit">${icon('plus')}Adicionar</button></form>
    <p class="section-title">Regras (${d.items.length})</p>
    <div class="scroll-x"><button class="filter" data-act="rf" data-v="" aria-pressed="${!ruleFilter}">Todas</button>${Object.entries(RULE_TYPES).map(([k, l]) => html`<button class="filter" data-act="rf" data-v="${k}" aria-pressed="${ruleFilter === k}">${l.split(' (')[0]}${k.startsWith('review') ? ' ?' : ''}</button>`)}</div>
    <div class="list gap-top">${d.items.map((r) => html`<div class="item"><div class="grow"><div class="title mono">${r.value}</div><div class="meta">${RULE_TYPES[r.type]} · ${r.reason || ''}${r.is_system ? ' · padrão do sistema' : ''}</div></div>
      <label class="switch"><input type="checkbox" data-rule="${r.id}" ${r.active ? raw('checked') : ''} aria-label="Regra ativa"><i></i></label>${r.is_system ? '' : html`<button class="icon-btn" data-act="del" data-id="${r.id}" aria-label="Apagar regra">${icon('trash')}</button>`}</div>`)}</div>
    <p class="section-title">Lista de supressão — nunca contatar (${sup.items.length})</p>
    <form data-form="sup" class="card flat stack"><div class="row"><select name="type"><option value="email">E-mail</option><option value="domain">Domínio</option></select><input type="text" name="value" class="grow" placeholder="contato@empresa.com.br" required><button class="btn" type="submit">Adicionar</button></div>
      <p class="hint">Descadastros, recusas e falhas de entrega entram aqui automaticamente.</p></form>
    ${sup.items.length ? html`<div class="list gap-top">${sup.items.slice(0, 100).map((s) => html`<div class="item"><div class="grow"><div class="title mono">${s.value}</div><div class="meta">${{ unsubscribe: 'Descadastro', refusal: 'Recusa', bounce: 'Falha de entrega', manual: 'Manual' }[s.reason] || s.reason} · ${fmtDate(s.created_at)}</div></div></div>`)}</div>` : ''}`);
  root.querySelectorAll('[data-rule]').forEach((c) => c.addEventListener('change', async () => { try { await api('PATCH', `/api/exclusions/${c.dataset.rule}`, { active: c.checked }); toast(c.checked ? 'Regra ativada' : 'Regra desativada'); } catch (e) { c.checked = !c.checked; fail(e); } }));
  on(root, {
    rf: (b) => { ruleFilter = b.dataset.v; exclusions(root); },
    test: async (f) => {
      try {
        const r = await api('POST', '/api/exclusions/test', formData(f));
        const label = { allow: ['Liberada', 'ok'], review: ['Em dúvida — revisão manual', 'warn'], block: ['Bloqueada', 'bad'] }[r.verdict];
        mount(root.querySelector('#testres'), html`<div class="banner ${label[1]}">${icon(r.verdict === 'allow' ? 'check' : 'ban')}<div class="grow"><strong>${label[0]}</strong>${r.reasons.map((x) => html`<p>${x.level === 'block' ? 'Bloqueia' : 'Revisar'}: "${x.rule}" em ${x.field} — ${x.reason}</p>`)}</div></div>`);
      } catch (e) { fail(e); }
    },
    add: async (f) => { try { const r = await api('POST', '/api/exclusions', formData(f)); toast(`Regra adicionada · ${r.affected} empresa(s) afetada(s)`); exclusions(root); } catch (e) { fail(e); } },
    del: async (b) => { if (!window.confirm('Apagar esta regra?')) return; try { await api('DELETE', `/api/exclusions/${b.dataset.id}`); exclusions(root); } catch (e) { fail(e); } },
    sup: async (f) => { try { await api('POST', '/api/suppression', formData(f)); toast('Adicionado à supressão'); exclusions(root); } catch (e) { fail(e); } },
  });
}

// ======================= CONFIGURAÇÕES =======================
export async function settings(root, params) {
  mount(root, html`${head('Configurações', '')}${loading}`);
  let d;
  try { d = await api('GET', '/api/settings'); } catch (e) { mount(root, errorBox(e)); return; }
  const s = d.settings, g = d.google, o = s.outreach, av = s.availability;
  const live = o.mode === 'live' && o.live_approved_at;
  const gParam = params.google;
  mount(root, html`${head('Configurações', 'Integrações, remetente, envio, agenda e limites')}
    ${gParam === 'ok' ? html`<div class="banner ok">${icon('check')}<div class="grow"><strong>Google conectado</strong><p>Agora clique em "Testar conexão" para validar Gmail e Agenda.</p></div></div>` : gParam ? html`<div class="banner bad">${icon('alert')}<div class="grow"><strong>Conexão Google não concluída</strong><p>${decodeURIComponent(gParam)}</p></div></div>` : ''}

    <p class="section-title">Google (Gmail e Agenda)</p>
    <div class="card flat stack">
      <div class="row between wrap"><div><h2>${g.status === 'connected' ? g.account_email : g.status === 'expired' ? 'Acesso expirado' : 'Não conectado'}</h2>
        <p class="small muted">${g.status === 'connected' ? (g.verified_at ? `Testado ${fmtRel(g.verified_at)}` : 'Conectado, ainda não testado') : d.env.google_client ? 'Conecte a conta que vai enviar os e-mails e guardar as reuniões.' : 'Falta configurar GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET no Worker (veja docs/CONFIGURACAO-GOOGLE.md).'}</p>
        ${g.last_error ? html`<p class="xs">${g.last_error}</p>` : ''}</div>
        <span class="chip ${g.status === 'connected' && g.verified_at ? 'ok' : g.status === 'connected' ? 'warn' : 'bad'}">${g.status === 'connected' && g.verified_at ? 'Verificado' : g.status === 'connected' ? 'Não testado' : 'Desconectado'}</span></div>
      <div class="row wrap">${g.status === 'connected' ? html`<button class="btn soft" data-act="gtest">${icon('check')}Testar conexão</button><button class="btn soft" data-act="gmail">${icon('mail')}E-mail de teste</button><button class="btn danger-ghost" data-act="gdisc">Desconectar</button>`
        : html`<button class="btn accent" data-act="gconnect" ${d.env.google_client ? '' : raw('disabled')}>${icon('link')}Conectar Google</button>`}</div>
      <div id="gres"></div></div>

    <p class="section-title">Envio de e-mails</p>
    <div class="card ${live ? '' : 'flat'} stack">
      <div class="row between wrap"><div><h2>${live ? 'Envio real ativo' : 'Modo simulação'}</h2><p class="small muted">${live ? `Aprovado por ${o.live_approved_by} em ${fmtDate(o.live_approved_at)}.` : 'As mensagens são geradas e registradas, mas nada é enviado.'}</p></div>
        <span class="chip ${live ? 'ok live' : 'info'}"><span class="pip"></span>${live ? 'Real' : 'Simulação'}</span></div>
      ${live ? html`<button class="btn soft" data-act="sim">Voltar para simulação</button>` : html`<form data-form="golive" class="stack"><p class="small">Para ativar a primeira campanha real: Google conectado e testado, remetente igual à conta Google e ao menos uma prospecção simulada revisada em Conversas. Digite <strong>ATIVAR</strong>:</p><div class="row"><input type="text" name="confirm" autocomplete="off" class="grow" aria-label="Confirmação"><button class="btn accent" type="submit">Ativar envio real</button></div></form>`}
      <form data-form="outreach" class="stack"><hr class="sep">
        <div class="grid3"><label class="field"><span>Limite diário</span><input type="number" name="daily_limit" value="${o.daily_limit}" min="1" max="200"></label>
        <label class="field"><span>Por segmento/dia</span><input type="number" name="per_segment_daily_limit" value="${o.per_segment_daily_limit}" min="1" max="200"></label>
        <label class="field"><span>Intervalo (min)</span><input type="number" name="min_minutes_between" value="${o.min_minutes_between}" min="2" max="240"></label></div>
        <label class="field"><span>Dias de envio</span></label>${daysPicker('days', o.days)}
        <div class="grid3"><label class="field"><span>Início</span><input type="time" name="start" value="${o.start}" required></label><label class="field"><span>Fim</span><input type="time" name="end" value="${o.end}" required></label>
        <label class="field"><span>Pontuação mínima</span><input type="number" name="min_score" value="${o.min_score}" min="40" max="100"></label></div>
        <div class="grid2"><label class="field"><span>Follow-up após (dias)</span><input type="number" name="followup_after_days" value="${o.followup_after_days}" min="2" max="30"></label><label class="field"><span>Máx. follow-ups</span><input type="number" name="max_followups" value="${o.max_followups}" min="0" max="2"></label></div>
        <button class="btn" type="submit">Salvar envio</button></form></div>

    <p class="section-title">Remetente</p>
    <form data-form="sender" class="card flat stack">
      <div class="grid2"><label class="field"><span>Seu nome</span><input type="text" name="name" value="${s.sender.name}" required></label><label class="field"><span>Empresa</span><input type="text" name="company" value="${s.sender.company}"></label></div>
      <div class="grid2"><label class="field"><span>E-mail (o da conta Google)</span><input type="email" name="email" value="${s.sender.email}" required></label><label class="field"><span>Telefone</span><input type="text" name="phone" value="${s.sender.phone}"></label></div>
      <div class="grid2"><label class="field"><span>Site</span><input type="text" name="website" value="${s.sender.website}"></label><label class="field"><span>Cidade</span><input type="text" name="city" value="${s.sender.city}"></label></div>
      <button class="btn" type="submit">Salvar remetente</button></form>

    <p class="section-title">Respostas automáticas (Closer)</p>
    <form data-form="closer" class="card flat stack"><p class="small muted">Desligado por padrão. Quando ligado, só responde mensagens classificadas com segurança: envia o link da sua agenda e três perguntas de qualificação, sem preços. Tudo o mais fica para você.</p>
      ${sw('auto_reply_meeting', s.closer.auto_reply_meeting, 'Pedido de reunião → link de agenda')}
      ${sw('auto_reply_positive', s.closer.auto_reply_positive, 'Resposta positiva → link de agenda')}
      ${sw('auto_reply_info', s.closer.auto_reply_info, 'Pedido de informações → resumo + link')}
      <button class="btn" type="submit">Salvar</button></form>

    <p class="section-title">Disponibilidade para reuniões</p>
    <form data-form="availability" class="card flat stack">${daysPicker('days', av.days)}
      <div class="grid3"><label class="field"><span>Início</span><input type="time" name="start" value="${av.start}" required></label><label class="field"><span>Fim</span><input type="time" name="end" value="${av.end}" required></label><label class="field"><span>Duração (min)</span><input type="number" name="duration_minutes" value="${av.duration_minutes}" min="15" max="180"></label></div>
      <div class="grid3"><label class="field"><span>Intervalo (min)</span><input type="number" name="buffer_minutes" value="${av.buffer_minutes}" min="0" max="120"></label><label class="field"><span>Antecedência (h)</span><input type="number" name="min_notice_hours" value="${av.min_notice_hours}" min="0" max="336"></label><label class="field"><span>Horizonte (dias)</span><input type="number" name="horizon_days" value="${av.horizon_days}" min="1" max="60"></label></div>
      <label class="field"><span>Agenda (ID)</span><input type="text" name="calendar_id" value="${av.calendar_id}"></label>
      ${sw('create_meet_link', av.create_meet_link, 'Criar link do Google Meet')}
      <button class="btn" type="submit">Salvar disponibilidade</button></form>

    <p class="section-title">Serviços oferecidos</p>
    <form data-form="services" class="card flat stack"><div class="grid2">${Object.entries(META.services).map(([k, l]) => sw(k, s.services[k] !== false, l))}</div><button class="btn" type="submit">Salvar serviços</button></form>

    <p class="section-title">Análise de sites</p>
    <form data-form="investigator" class="card flat stack">
      ${sw('use_pagespeed', s.investigator.use_pagespeed, 'Medir velocidade mobile com o PageSpeed Insights (Google)')}
      ${sw('cnpj_lookup', s.investigator.cnpj_lookup, 'Consultar CNAE do CNPJ encontrado no site (BrasilAPI)')}
      <label class="field"><span>Máximo lido por página (KB)</span><input type="number" name="max_page_kb" value="${s.investigator.max_page_kb}" min="50" max="2000"></label>
      <p class="hint">${d.env.pagespeed_key ? 'Chave PSI configurada.' : 'Sem PSI_API_KEY: o PageSpeed funciona com cota bem menor.'}</p>
      <button class="btn" type="submit">Salvar</button></form>

    <p class="section-title">Limites diários (proteção do plano gratuito)</p>
    <form data-form="limits" class="card flat stack"><div class="grid2">${Object.entries(s.limits).map(([k, v]) => html`<label class="field"><span>${{ overpass_daily: 'Consultas Overpass', site_fetch_daily: 'Visitas a sites', brasilapi_daily: 'Consultas CNPJ', pagespeed_daily: 'Testes PageSpeed', gmail_api_daily: 'Chamadas Gmail API', calendar_api_daily: 'Chamadas Calendar API', d1_rows_written_daily: 'D1 linhas gravadas', d1_rows_read_daily: 'D1 linhas lidas', worker_requests_daily: 'Requisições ao Worker' }[k] || k}</span><input type="number" name="${k}" value="${v}" min="0"></label>`)}</div>
      <p class="hint">Ao atingir um limite, só a tarefa afetada pausa até 00:00 UTC e você recebe um alerta. Nada é cobrado: o plano gratuito bloqueia em vez de cobrar.</p><button class="btn" type="submit">Salvar limites</button></form>

    <p class="section-title">Geral</p>
    <form data-form="general" class="card flat stack"><label class="field"><span>Fuso horário</span><input type="text" name="timezone" value="${s.timezone}"></label>
      ${sw('email_admin', s.notifications.email_admin, 'Receber resumo diário de alertas por e-mail')}<button class="btn" type="submit">Salvar</button></form>

    <p class="section-title">Conta e dados</p>
    <form data-form="password" class="card flat stack"><div class="grid2"><label class="field"><span>Senha atual</span><input type="password" name="current" autocomplete="current-password" required></label><label class="field"><span>Nova senha (12+)</span><input type="password" name="next" autocomplete="new-password" minlength="12" required></label></div><button class="btn soft" type="submit">Trocar senha</button></form>
    <div class="row wrap gap-top"><a class="btn soft" href="/api/export" download>${icon('download')}Baixar backup (JSON)</a><a class="btn soft" href="#/uso">${icon('gauge')}Uso e limites</a><button class="btn danger-ghost" data-act="logout">${icon('logout')}Sair</button></div>`);

  const put = async (key, body, msg = 'Salvo') => { try { await api('PUT', `/api/settings/${key}`, body); toast(msg); } catch (e) { fail(e); } };
  on(root, {
    gconnect: async () => { try { const r = await api('POST', '/api/google/connect'); window.location.href = r.url; } catch (e) { fail(e); } },
    gtest: async (b) => {
      busy(b, true);
      try { const r = await api('POST', '/api/google/test'); mount(root.querySelector('#gres'), html`<div class="banner ${r.ok ? 'ok' : 'bad'}">${icon(r.ok ? 'check' : 'alert')}<div class="grow"><strong>${r.ok ? 'Gmail e Agenda funcionando' : 'Falha no teste'}</strong><p>Gmail: ${r.gmail.ok ? `ok (${r.gmail.email})` : r.gmail.error}</p><p>Agenda: ${r.calendar.ok ? `ok (${r.calendar.busy_blocks_next_7_days} compromisso(s) nos próximos 7 dias)` : r.calendar.error}</p></div></div>`); }
      catch (e) { fail(e); } finally { busy(b, false); }
    },
    gmail: async (b) => { busy(b, true); try { const r = await api('POST', '/api/google/test-email'); toast(`E-mail de teste enviado para ${r.to}`); } catch (e) { fail(e); } finally { busy(b, false); } },
    gdisc: async () => { if (!window.confirm('Desconectar o Google? Envios e leitura param.')) return; try { await api('POST', '/api/google/disconnect'); settings(root, {}); } catch (e) { fail(e); } },
    sim: async () => { try { await api('POST', '/api/outreach/simulation'); settings(root, {}); } catch (e) { fail(e); } },
    golive: async (f) => { if (!window.confirm('Ativar ENVIO REAL de e-mails dentro dos limites configurados?')) return; try { await api('POST', '/api/outreach/approve-live', formData(f)); toast('Envio real ativado'); settings(root, {}); } catch (e) { fail(e); } },
    outreach: (f) => put('outreach', formData(f)),
    sender: (f) => put('sender', formData(f)),
    closer: (f) => put('closer', formData(f)),
    availability: (f) => put('availability', formData(f)),
    services: (f) => put('services', formData(f)),
    investigator: (f) => put('investigator', formData(f)),
    limits: (f) => put('limits', formData(f)),
    general: async (f) => { const v = formData(f); await put('timezone', { value: v.timezone }); await put('notifications', { email_admin: v.email_admin }); },
    password: async (f) => { try { await api('POST', '/api/me/password', formData(f)); toast('Senha trocada'); f.reset(); } catch (e) { fail(e); } },
    logout: async () => { await api('POST', '/api/logout').catch(() => {}); window.location.hash = '#/'; window.location.reload(); },
  });
}

// ======================= USO =======================
const USAGE_LABEL = { worker_requests: ['Requisições ao Worker', 'worker_requests_daily'], cron_ticks: ['Ciclos do Cron', null], d1_queries: ['Consultas D1', null], d1_rows_read: ['D1 linhas lidas', 'd1_rows_read_daily'], d1_rows_written: ['D1 linhas gravadas', 'd1_rows_written_daily'], subrequests: ['Chamadas externas', null], overpass_requests: ['Overpass', 'overpass_daily'], site_fetches: ['Visitas a sites', 'site_fetch_daily'], brasilapi_requests: ['BrasilAPI', 'brasilapi_daily'], pagespeed_requests: ['PageSpeed', 'pagespeed_daily'], gmail_api: ['Gmail API', 'gmail_api_daily'], calendar_api: ['Calendar API', 'calendar_api_daily'], emails_sent: ['E-mails enviados', null], job_errors: ['Erros em tarefas', null], companies_discovered: ['Empresas descobertas', null], companies_investigated: ['Sites analisados', null], replies_received: ['Respostas', null], meetings_booked: ['Reuniões', null] };
export async function usage(root) {
  mount(root, html`${head('Uso e limites', 'Consumo diário medido pelo próprio sistema')}${loading}`);
  let d;
  try { d = await api('GET', '/api/usage?days=7'); } catch (e) { mount(root, errorBox(e)); return; }
  const days = [...new Set(d.rows.map((r) => r.day))].sort().reverse();
  const get = (day, m) => d.rows.find((r) => r.day === day && r.metric === m)?.count || 0;
  const metrics = Object.keys(USAGE_LABEL).filter((m) => d.rows.some((r) => r.metric === m));
  mount(root, html`${head('Uso e limites', 'Consumo diário medido pelo próprio sistema (dia em UTC, como as cotas da Cloudflare)')}
    ${d.paused.length ? html`<div class="banner warn">${icon('pause')}<div class="grow"><strong>Tarefas pausadas por limite</strong>${d.paused.map((p) => html`<p>${p.label}: ${p.paused_reason} (até ${fmtDate(p.paused_until)})</p>`)}</div></div>` : ''}
    <p class="section-title">Hoje</p>
    <div class="card flat stack">${metrics.filter((m) => USAGE_LABEL[m][1]).map((m) => { const lim = d.limits[USAGE_LABEL[m][1]]; const n = get(d.today, m); const pct = lim ? (n / lim) * 100 : 0; return html`<div><div class="row between small"><span>${USAGE_LABEL[m][0]}</span><span class="num muted">${fmtInt(n)} / ${fmtInt(lim)}</span></div><div class="bar ${pct > 85 ? 'bad' : pct > 60 ? 'warn' : 'ok'} gap-top-s"><i data-w="${pct}"></i></div></div>`; })}
      ${!metrics.length ? html`<p class="small muted">Sem consumo registrado ainda.</p>` : ''}</div>
    <p class="section-title">Últimos 7 dias</p>
    <div class="card flat table-wrap"><table class="table"><thead><tr><th>Métrica</th>${days.map((dd) => html`<th class="n">${dd.slice(8, 10)}/${dd.slice(5, 7)}</th>`)}</tr></thead><tbody>${metrics.map((m) => html`<tr><td>${USAGE_LABEL[m][0]}</td>${days.map((dd) => html`<td class="n">${fmtInt(get(dd, m))}</td>`)}</tr>`)}</tbody></table></div>
    <p class="hint gap-top">Limites do plano gratuito (verificados na documentação da Cloudflare): Workers 100 mil requisições/dia e 10 ms de CPU por execução; D1 5 milhões de linhas lidas e 100 mil gravadas por dia, 5 GB. Os limites acima ficam abaixo disso de propósito.</p>`);
}

// ======================= MAIS =======================
export function more(root) {
  const items = [['agenda', 'Agenda', 'calendar', 'Reuniões marcadas'], ['automacao', 'Automação', 'bolt', 'Rotina, agentes, fila, pausa'], ['exclusao', 'Lista de exclusão', 'shield', 'Saúde e concorrentes da Arco'], ['configuracoes', 'Configurações', 'gear', 'Google, envio, agenda, limites'], ['uso', 'Uso e limites', 'gauge', 'Consumo do plano gratuito']];
  mount(root, html`${head('Mais', '')}<div class="list">${items.map(([k, l, ic, desc]) => html`<a class="item" href="#/${k}">${icon(ic)}<div class="grow"><div class="title">${l}</div><div class="meta">${desc}</div></div>${icon('chev', 'chev')}</a>`)}</div>`);
}

export { esc, EXCL };
