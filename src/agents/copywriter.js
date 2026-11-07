// COPYWRITER — mensagens curtas, personalizadas a partir das evidências observadas.
// Regras: nome certo da empresa, finalidade comercial explícita, sem relacionamento inventado,
// sem promessa de resultado, sem preço, opção de descadastro simples em toda mensagem.

import { nowIso, safeJson, stableHash, signPayload } from '../util.js';
import { getSettings, stageStmts } from '../db.js';
import { SERVICES } from '../defaults.js';
import { loadRules, checkExclusion, subjectFromCompany, isSuppressed } from '../exclusion.js';

/** Frase da observação, fiel à evidência. Prováveis usam "parece". */
export function observationPhrase(f, company) {
  const year = /© (\d{4})/.exec(f.evidence || '')?.[1];
  switch (f.code) {
    case 'no_website': return 'o cadastro público de vocês no mapa (OpenStreetMap) não indica um site próprio';
    case 'only_social': return 'o endereço divulgado como site é um perfil de rede social, não um site próprio';
    case 'site_unreachable': return `o site ${company.domain} não abriu corretamente quando tentei acessar`;
    case 'no_https': return 'o site abre sem HTTPS, e o navegador mostra o aviso de "não seguro" para quem visita';
    case 'no_viewport': return 'a página inicial não está configurada para celular — no telefone ela aparece como a versão de computador reduzida';
    case 'psi_slow': case 'psi_medium': return `no teste do Google PageSpeed para celular o site ficou com ${/\((\d+)\/100\)/.exec(f.title)?.[1] || 'nota baixa'}/100 de desempenho`;
    case 'slow_response': return `o servidor demorou ${/em ([\d.,]+s)/.exec(f.evidence)?.[1] || 'alguns segundos'} para começar a responder quando visitei`;
    case 'no_contact_channel': return 'na página inicial não encontrei formulário, WhatsApp ou telefone clicável — quem chega pelo celular precisa procurar como falar com vocês';
    case 'no_form': return 'a página inicial não tem formulário de contato';
    case 'no_cta': return 'a página inicial não deixa muito claro qual é o próximo passo para pedir um orçamento';
    case 'form_without_crm': return 'o formulário do site não parece estar ligado a um CRM, então os pedidos provavelmente chegam só por e-mail';
    case 'manual_whatsapp': return 'o atendimento parece concentrado no WhatsApp, sem automação de resposta ou registro dos contatos';
    case 'no_analytics': return 'não vi ferramenta de medição de visitas instalada no site';
    case 'old_copyright': return `o rodapé do site ainda mostra © ${year || 'de alguns anos atrás'}`;
    case 'no_title': return 'a página inicial está sem título, o que atrapalha como ela aparece no Google';
    case 'no_description': return 'a página inicial não tem descrição para o Google';
    case 'img_no_alt': return 'boa parte das imagens não tem texto alternativo, o que pesa em acessibilidade e no Google';
    case 'many_tools': return `vocês já usam várias ferramentas (${f.evidence}) que poderiam conversar entre si`;
    case 'old_stack': return 'o site usa uma versão antiga de biblioteca (jQuery), comum em sites que não recebem manutenção há algum tempo';
    case 'heavy_page': return 'a página inicial é bem pesada para abrir no celular';
    default: return null;
  }
}

const SERVICE_LINE = {
  site: 'Ajustes assim costumam deixar o site mais claro e confiável para quem chega pelo Google ou por indicação.',
  landing: 'Uma página bem direta, com caminho claro para o contato, costuma ajudar a transformar visita em pedido de orçamento.',
  crm: 'Ligar o site a um CRM simples ajuda a não perder nenhum pedido e a saber em que pé está cada negociação.',
  automation: 'Dá para automatizar a primeira resposta e o registro de cada contato sem perder o atendimento humano.',
  api: 'Integrar essas ferramentas costuma eliminar retrabalho e cópia manual de dados.',
  internal: 'Um sistema interno sob medida costuma organizar pedidos, equipe e indicadores num lugar só.',
  process: 'Automatizar etapas repetitivas libera a equipe para o que realmente precisa de atenção.',
  app: 'Uma aplicação sob medida pode resolver exatamente o fluxo de vocês, sem adaptar a empresa a uma ferramenta pronta.',
  custom: 'Trabalho com soluções sob medida, partindo de uma conversa curta para entender a operação.',
};

// Assunto segue a observação principal (nunca fala de algo que não foi observado)
const SUBJECT_BY_FINDING = {
  no_website: '{empresa}: site próprio', only_social: '{empresa}: site próprio além das redes',
  site_unreachable: '{empresa}: o site não abriu aqui', no_https: '{empresa}: aviso de "não seguro" no site',
  no_viewport: '{empresa}: o site no celular', psi_slow: '{empresa}: velocidade do site no celular',
  psi_medium: '{empresa}: velocidade do site no celular', slow_response: '{empresa}: tempo de carregamento do site',
  no_contact_channel: '{empresa}: contatos pela página inicial', no_form: '{empresa}: contatos pelo site',
  no_cta: '{empresa}: caminho até o pedido de orçamento', form_without_crm: '{empresa}: pedidos que chegam pelo site',
  manual_whatsapp: '{empresa}: atendimento pelo WhatsApp', no_description: '{empresa}: como o site aparece no Google',
  no_title: '{empresa}: como o site aparece no Google', many_tools: '{empresa}: integração entre as ferramentas',
  old_copyright: '{empresa}: atualização do site', old_stack: '{empresa}: atualização do site',
};

const SUBJECTS = {
  site: ['{empresa}: uma observação sobre o site no celular', 'Site da {empresa} — pontos que notei'],
  landing: ['{empresa}: contatos que chegam pelo site', '{empresa}: caminho até o pedido de orçamento'],
  crm: ['{empresa}: pedidos que chegam pelo site', '{empresa}: organização dos contatos do site'],
  automation: ['{empresa}: atendimento pelo WhatsApp', '{empresa}: primeira resposta automática'],
  api: ['{empresa}: integração entre as ferramentas', '{empresa}: menos retrabalho entre sistemas'],
  internal: ['{empresa}: ideia sobre organização interna', '{empresa}: sistema sob medida'],
  process: ['{empresa}: processos repetitivos', '{empresa}: ideia rápida sobre processos'],
  app: ['{empresa}: aplicação sob medida', '{empresa}: ideia rápida'],
  custom: ['{empresa}: ideia rápida sobre processos digitais', '{empresa}: uma observação'],
};

export async function unsubscribeUrl(env, contactId, email) {
  const token = await signPayload(env, { c: contactId, e: email });
  return `${(env.APP_URL || '').replace(/\/$/, '')}/u/${token}`;
}

function signature(sender) {
  return [sender.name, sender.company, sender.phone, sender.website].filter(Boolean).join('\n');
}

export function validateSender(sender) {
  const missing = [];
  if (!sender.name) missing.push('nome');
  if (!sender.email) missing.push('e-mail');
  return missing;
}

/** Gera {subject, body, template, observations}. Puro: testável sem banco. */
export function composeInitial({ company, findings, service, sender, unsubUrl, variantSeed }) {
  const v = stableHash(variantSeed ?? company.id) % 2;
  const weight = (f) => (f.kind === 'confirmed' ? 20 : 10) + (f.service === service ? 5 : 0);
  const picked = findings
    .filter((f) => f.kind === 'confirmed' || f.kind === 'probable')
    .sort((a, b) => weight(b) - weight(a))
    .map((f) => ({ f, phrase: observationPhrase(f, company) }))
    .filter((x) => x.phrase)
    .slice(0, 2);
  const svc = SERVICES[service] || SERVICES.custom;
  const name = company.name.trim();
  const subject = (picked[0] && SUBJECT_BY_FINDING[picked[0].f.code]) || SUBJECTS[service]?.[v] || SUBJECTS.custom[v];
  const opening = v === 0 ? `Olá, equipe da ${name}, tudo bem?` : `Olá! Tudo bem por aí na ${name}?`;
  const intro = `Meu nome é ${sender.name}${sender.company ? ` (${sender.company})` : ''} e trabalho com ${svc.pitch}.`;
  let obs;
  if (picked.length === 2) obs = `Olhando a presença digital de vocês${company.domain ? ` (${company.domain})` : ''}, notei que ${picked[0].phrase} e que ${picked[1].phrase}.`;
  else if (picked.length === 1) obs = `Olhando a presença digital de vocês${company.domain ? ` (${company.domain})` : ''}, notei que ${picked[0].phrase}.`;
  else obs = 'Estava conhecendo a presença digital de vocês e separei algumas ideias sobre processo comercial e atendimento.';
  const purpose = v === 0
    ? 'Este é um contato comercial: gostaria de mostrar essa análise rápida, sem compromisso. Faria sentido conversarmos 20 minutos?'
    : 'Escrevo com uma proposta comercial: posso enviar uma análise curta com o que vi e, se fizer sentido, conversamos. Pode ser?';
  const body = [
    opening, '', intro, '', `${obs} ${SERVICE_LINE[service] || SERVICE_LINE.custom}`, '', purpose, '', 'Obrigado,', signature(sender), '',
    '—',
    `Recebeu este e-mail porque o endereço está publicado como contato da ${name}. Para não receber mais mensagens, responda "descadastrar" ou acesse: ${unsubUrl}`,
  ].join('\n');
  return {
    subject: subject.replace('{empresa}', name),
    body,
    template: `${service}:v${v}`,
    observations: picked.map((x) => x.f.code),
  };
}

export function composeFollowup({ company, sender, unsubUrl, firstSentAt, timezone }) {
  const date = firstSentAt ? new Intl.DateTimeFormat('pt-BR', { timeZone: timezone, day: '2-digit', month: '2-digit' }).format(new Date(firstSentAt)) : 'alguns dias atrás';
  const body = [
    `Olá, equipe da ${company.name}.`, '',
    `Retomo meu e-mail de ${date} sobre a presença digital de vocês. Se não for prioridade agora, sem problema — é só me avisar e não envio mais nada.`, '',
    'Se fizer sentido, uma conversa de 20 minutos já basta para eu mostrar o que observei.', '',
    'Obrigado,', signature(sender), '', '—',
    `Para não receber mais mensagens, responda "descadastrar" ou acesse: ${unsubUrl}`,
  ].join('\n');
  return { body, template: 'followup:v0' };
}

/** Prepara rascunhos para leads qualificados com e-mail válido. */
export async function runPrepare(ctx, batch = 10) {
  const settings = await getSettings(ctx);
  const missing = validateSender(settings.sender);
  if (missing.length) {
    const e = new Error(`Preencha os dados do remetente em Configurações (${missing.join(', ')}) antes de preparar mensagens.`);
    e.configMissing = true;
    throw e;
  }
  const rows = await ctx.all(
    `SELECT l.id AS lead_id, l.stage, l.score, l.priority, l.service_fit, l.contact_id, c.*, ct.normalized_value AS contact_email, ct.status AS contact_status
     FROM leads l JOIN companies c ON c.id = l.company_id JOIN contacts ct ON ct.id = l.contact_id
     WHERE l.stage = 'qualificado' AND l.needs_review = 0 AND l.contact_id IS NOT NULL
       AND l.score >= ? AND l.priority != 'nao_automatico' AND c.exclusion_status IN ('allow','approved')
       AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.lead_id = l.id AND m.kind = 'initial')
     ORDER BY l.score DESC LIMIT ?`, settings.outreach.min_score, batch,
  );
  if (!rows.length) return { prepared: 0 };
  const rules = await loadRules(ctx);
  const ids = rows.map((r) => r.id);
  const analyses = await ctx.all(
    `SELECT a.company_id, a.findings FROM lead_analyses a
     WHERE a.company_id IN (${ids.map(() => '?').join(',')})
       AND a.id = (SELECT MAX(id) FROM lead_analyses b WHERE b.company_id = a.company_id)`, ...ids,
  );
  const findingsBy = new Map(analyses.map((a) => [a.company_id, safeJson(a.findings, [])]));
  const stmts = [];
  let prepared = 0, skipped = 0;
  const ts = nowIso();
  for (const r of rows) {
    const lead = { id: r.lead_id, stage: r.stage };
    const ex = checkExclusion(rules, subjectFromCompany(r));
    if (ex.verdict === 'block' || (ex.verdict === 'review' && r.exclusion_status !== 'approved')) {
      stmts.push(ctx.stmt('UPDATE leads SET needs_review = 1, updated_at = ? WHERE id = ?', ts, r.lead_id));
      skipped++; continue;
    }
    if (r.contact_status !== 'valid' || (await isSuppressed(ctx, r.contact_email))) { skipped++; continue; }
    const unsub = await unsubscribeUrl(ctx.env, r.contact_id, r.contact_email);
    const msg = composeInitial({ company: r, findings: findingsBy.get(r.id) || [], service: r.service_fit || 'custom', sender: settings.sender, unsubUrl: unsub });
    stmts.push(ctx.stmt(
      `INSERT OR IGNORE INTO conversations (lead_id, contact_id, subject, status, created_at, updated_at)
       SELECT ?, ?, ?, 'open', ?, ? WHERE NOT EXISTS (SELECT 1 FROM conversations WHERE lead_id = ?)`,
      r.lead_id, r.contact_id, msg.subject, ts, ts, r.lead_id,
    ));
    stmts.push(ctx.stmt(
      `INSERT OR IGNORE INTO messages (conversation_id, lead_id, direction, kind, status, service, template, subject, body_text, to_addr, from_addr, dedupe_key, created_at, updated_at)
       VALUES ((SELECT id FROM conversations WHERE lead_id = ? ORDER BY id LIMIT 1), ?, 'out', 'initial', 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      r.lead_id, r.lead_id, r.service_fit, msg.template, msg.subject, msg.body, r.contact_email, settings.sender.email, `initial:${r.lead_id}`, ts, ts,
    ));
    stmts.push(...stageStmts(ctx, lead, 'aguardando_contato', `Mensagem preparada (${msg.template})`, 'copywriter'));
    prepared++;
  }
  await ctx.batch(stmts);
  ctx.log('info', 'copywriter', `${prepared} mensagem(ns) preparada(s), ${skipped} bloqueada(s) na checagem final`);
  return { prepared, skipped };
}
