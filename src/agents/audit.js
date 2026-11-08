// MINI-AUDITORIA — página pública por lead (/analise/:token) com o que foi observado no site, por que
// importa e um botão para agendar. A abertura é registrada por um sinal enviado pela própria página
// (JavaScript, depois de alguns segundos visível), para não contar robôs de segurança de e-mail que
// só baixam o link. Sem pixel de rastreio, sem cookies.

import { escapeHtml, nowIso, safeJson } from '../util.js';
import { getSettings } from '../db.js';
import { publicPage } from './scheduler.js';
import { observationPhrase } from './copywriter.js';
import { planHotTask } from './planner.js';
import { waLink, normalizePhone } from '../channels.js';

const WHY = {
  no_website: 'Hoje a maioria das pessoas procura no Google antes de ligar. Sem site próprio, quem pesquisa encontra concorrentes primeiro.',
  only_social: 'Rede social ajuda, mas não aparece bem no Google e não passa a mesma confiança que um site com domínio próprio.',
  site_unreachable: 'Um site que não abre faz o visitante desistir na hora — e o Google rebaixa páginas instáveis.',
  no_https: 'Sem HTTPS, o navegador mostra "não seguro" ao lado do endereço. Muita gente fecha a página nesse momento.',
  no_viewport: 'A maior parte das visitas vem do celular. Uma página não ajustada fica pequena, exige zoom e afasta quem chega por lá.',
  psi_slow: 'Páginas lentas no celular perdem visitantes antes de carregar e caem no Google.',
  psi_medium: 'Há espaço para deixar a página mais rápida no celular, o que melhora a permanência de quem visita.',
  slow_response: 'Quando o servidor demora a responder, a página parece travada e parte dos visitantes desiste.',
  no_contact_channel: 'Quem decide entrar em contato precisa achar o caminho em segundos. Sem botão de WhatsApp, formulário ou telefone clicável, muitos desistem.',
  no_form: 'Um formulário simples captura pedidos fora do horário comercial, quando ninguém atende o telefone.',
  no_cta: 'Uma chamada clara ("peça um orçamento", "fale conosco") aumenta o número de pessoas que realmente entram em contato.',
  form_without_crm: 'Pedidos que chegam só no e-mail se perdem com facilidade. Num CRM simples, cada contato tem dono e próximo passo.',
  manual_whatsapp: 'Atendimento 100% manual no WhatsApp depende de alguém disponível. Uma primeira resposta automática e o registro dos contatos evitam perder clientes.',
  no_analytics: 'Sem medição, não dá para saber de onde vêm as visitas nem quais páginas geram contato.',
  old_copyright: 'Um rodapé com ano antigo passa a impressão de site abandonado.',
  no_title: 'O título é o que aparece no Google e nas abas do navegador. Sem ele, a página perde cliques.',
  no_description: 'A descrição é o texto que aparece abaixo do link no Google. Sem ela, o Google escolhe um trecho qualquer.',
  img_no_alt: 'Texto alternativo nas imagens ajuda quem usa leitor de tela e conta pontos no Google.',
  many_tools: 'Ferramentas que não conversam entre si geram retrabalho e dados duplicados.',
  old_stack: 'Bibliotecas antigas costumam indicar que o site não recebe manutenção — e podem ter falhas de segurança.',
  heavy_page: 'Páginas pesadas consomem dados móveis e demoram para abrir.',
};

export async function findLeadByAuditToken(ctx, token) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token || '')) return null;
  return ctx.first(
    `SELECT l.*, c.name AS company_name, c.domain, c.website, c.exclusion_status FROM leads l JOIN companies c ON c.id = l.company_id WHERE l.audit_token = ?`, token,
  );
}

export async function auditPageHtml(ctx, lead, token) {
  const settings = await getSettings(ctx);
  const a = await ctx.first('SELECT findings, analyzed_at, final_url FROM lead_analyses WHERE company_id = ? ORDER BY id DESC LIMIT 1', lead.company_id);
  const findings = safeJson(a?.findings, []).filter((f) => f.kind === 'confirmed' || f.kind === 'probable');
  const company = { name: lead.company_name, domain: lead.domain };
  const s = settings.sender;
  const date = a?.analyzed_at ? new Intl.DateTimeFormat('pt-BR', { timeZone: settings.timezone, day: '2-digit', month: 'long', year: 'numeric' }).format(new Date(a.analyzed_at)) : '';
  const items = findings.slice(0, 6).map((f) => {
    const phrase = observationPhrase(f, company);
    const title = phrase ? phrase.charAt(0).toUpperCase() + phrase.slice(1) : f.title;
    return `<li class="card"><span class="tag ${f.kind}">${f.kind === 'confirmed' ? 'Observado' : 'Provável'}</span>
      <h2>${escapeHtml(title)}</h2>${WHY[f.code] ? `<p>${escapeHtml(WHY[f.code])}</p>` : ''}<p class="ev">Evidência: ${escapeHtml(f.evidence)}</p></li>`;
  }).join('');
  const phone = normalizePhone(s.phone);
  const wa = phone ? waLink(phone, `Oi! Vi a análise do site da ${lead.company_name} e quero conversar.`) : null;
  const inner = `<p class="eyebrow">Análise rápida da presença digital</p>
<h1>${escapeHtml(lead.company_name)}</h1>
<p class="lead">${escapeHtml(lead.domain || '')}${date ? ` · ${escapeHtml(date)}` : ''}. Feita a partir do que qualquer visitante vê no site — sem acesso a nada interno.</p>
${items ? `<ol class="findings">${items}</ol>` : '<div class="card"><p>Não encontrei problemas evidentes na página inicial. Ainda assim, posso olhar processos de atendimento e vendas com você.</p></div>'}
<div class="card cta"><h2>Quer ver como resolver?</h2><p>Em 15 minutos eu mostro o que faria primeiro, sem compromisso.</p>
<a class="btn" href="/analise/${escapeHtml(token)}/agendar">Escolher um horário</a>
${wa ? `<a class="btn ghost" href="${escapeHtml(wa)}">Falar no WhatsApp</a>` : ''}
${s.email ? `<a class="btn ghost" href="mailto:${escapeHtml(s.email)}?subject=${encodeURIComponent(`Análise ${lead.company_name}`)}">Responder por e-mail</a>` : ''}</div>
<p class="foot">${escapeHtml([s.name, s.company].filter(Boolean).join(' · '))}${s.website ? ` · ${escapeHtml(s.website)}` : ''}. Não quer receber contato? Responda qualquer mensagem com "descadastrar".</p>
<script src="/audit.js" defer></script>`;
  return publicPage(`Análise · ${lead.company_name}`, inner);
}

/** Registra a abertura (sinal da página). Primeira abertura do dia vira cartão quente. */
export async function recordAuditView(ctx, lead) {
  const ts = nowIso();
  const prev = lead.audit_last_viewed_at;
  await ctx.run(
    `UPDATE leads SET audit_views = audit_views + 1, audit_first_viewed_at = COALESCE(audit_first_viewed_at, ?), audit_last_viewed_at = ?, updated_at = ? WHERE id = ?`,
    ts, ts, ts, lead.id,
  );
  ctx.metric('audit_views');
  if (!prev || ctx.now.getTime() - new Date(prev).getTime() > 6 * 3_600_000) {
    ctx.log('info', 'audit', `${lead.company_name} abriu a análise`, { lead_id: lead.id });
    await planHotTask(ctx, lead.id);
  }
}
