// Valores padrão: configurações, rotina, serviços, etapas e a lista de exclusão do sistema.

export const SEED_VERSION = 3; // subir quando a lista padrão mudar: as regras novas entram sem duplicar

export const STAGES = [
  ['descoberto', 'Descoberto'],
  ['em_analise', 'Em análise'],
  ['qualificado', 'Qualificado'],
  ['aguardando_contato', 'Aguardando contato'],
  ['contatado', 'Contatado'],
  ['respondeu', 'Respondeu'],
  ['interessado', 'Interessado'],
  ['reuniao_agendada', 'Reunião agendada'],
  ['convertido', 'Convertido'],
  ['perdido', 'Perdido'],
  ['nao_contatar', 'Não contatar'],
];
export const STAGE_KEYS = STAGES.map(([k]) => k);

export const SERVICES = {
  site: { label: 'Desenvolvimento de sites', pitch: 'desenvolvimento de sites institucionais rápidos e pensados para o celular' },
  landing: { label: 'Landing pages', pitch: 'landing pages focadas em gerar pedidos de orçamento e contatos' },
  app: { label: 'Aplicações personalizadas', pitch: 'aplicações web e mobile sob medida' },
  internal: { label: 'Sistemas internos', pitch: 'sistemas internos para organizar operação, pedidos e equipe' },
  crm: { label: 'CRM', pitch: 'CRM e organização do funil comercial, para nenhum contato do site se perder' },
  automation: { label: 'Automações', pitch: 'automações de atendimento e de tarefas repetitivas' },
  api: { label: 'Integrações de APIs', pitch: 'integração entre os sistemas que a empresa já usa' },
  process: { label: 'Automação de processos', pitch: 'automação de processos internos e fluxos de aprovação' },
  custom: { label: 'Soluções digitais sob medida', pitch: 'soluções digitais sob medida para a operação' },
};

export const DEFAULT_SETTINGS = {
  timezone: 'America/Sao_Paulo',
  system: { paused: false, emergency_stop: false, paused_reason: null, paused_at: null },
  agents: {
    finder: true, investigator: true, scorer: true, copywriter: true,
    outreach: true, inbox: true, closer: true, followup: true, report: true,
    planner: true, scheduler: true,
  },
  sender: { name: '', company: '', email: '', website: '', phone: '', city: '', instagram: '', signature: '' },
  services: Object.fromEntries(Object.keys(SERVICES).map((k) => [k, true])),
  outreach: {
    mode: 'simulation',            // simulation | live
    live_approved_at: null,
    live_approved_by: null,
    daily_limit: 20,
    per_segment_daily_limit: 5,
    min_minutes_between: 10,
    days: [1, 2, 3, 4, 5],
    start: '09:00',
    end: '17:00',
    email_followup_days: [4, 12],  // e-mails 2 e 3 da sequência (dias depois do primeiro); o último é o de encerramento
    lost_after_days: 7,            // sem resposta depois do último e-mail → perdido
    allow_named_contacts: false,   // e-mail nominal (joao@empresa) publicado pela própria empresa no site
    min_score: 40,
  },
  // Rotina diária no celular (tela Hoje)
  planner: {
    max_cards: 12,                 // cartões por dia (~10 minutos)
    new_manual_per_day: 5,         // empresas sem e-mail abordadas por WhatsApp/Instagram por dia
    digest_email: true,            // e-mail da manhã com o resumo e o link da tela Hoje
    // toques manuais: dias depois do primeiro contato e canais em ordem de preferência
    email_lead_steps: [{ day: 2, channels: ['instagram', 'whatsapp'] }, { day: 6, channels: ['whatsapp', 'phone', 'instagram'] }],
    manual_lead_steps: [{ day: 0, channels: ['whatsapp', 'instagram', 'phone'] }, { day: 4, channels: ['instagram', 'whatsapp', 'phone'] }, { day: 9, channels: ['phone', 'whatsapp'] }],
  },
  closer: {
    auto_reply_meeting: false,     // responder pedidos de reunião com o link de agenda
    auto_reply_positive: false,    // responder "tenho interesse" com o link de agenda
    auto_reply_info: false,        // responder pedidos de informação (sem preços)
  },
  availability: {
    days: [1, 2, 3, 4, 5],
    start: '09:00',
    end: '18:00',
    duration_minutes: 30,
    buffer_minutes: 15,
    min_notice_hours: 24,
    horizon_days: 14,
    calendar_id: 'primary',
    create_meet_link: true,
  },
  limits: {
    overpass_daily: 40,
    site_fetch_daily: 400,
    brasilapi_daily: 150,
    pagespeed_daily: 300,
    gmail_api_daily: 3000,
    calendar_api_daily: 800,
    d1_rows_written_daily: 80000,  // abaixo dos 100k do plano gratuito
    d1_rows_read_daily: 4000000,   // abaixo dos 5M do plano gratuito
    worker_requests_daily: 90000,  // abaixo dos 100k do plano gratuito
  },
  finder: {
    overpass_url: 'https://overpass-api.de/api/interpreter',
    targets: [],                   // [{country, state, city, segment, keywords, max, require_website}]
    target_cursor: 0,
    jobs_per_run: 1,
  },
  investigator: { use_pagespeed: false, max_page_kb: 400, cnpj_lookup: true },
  notifications: { email_admin: true },
};

// Rotina padrão (horários de São Paulo). Um único Cron Trigger dispara a cada minuto e o
// agendador central decide o que roda, conforme estas linhas da tabela schedules.
export const DEFAULT_SCHEDULES = [
  { task: 'discover', label: 'Descobrir novas empresas', start_time: '08:00', end_time: '08:59', interval_minutes: 10, batch_size: 1 },
  { task: 'investigate', label: 'Investigar empresas encontradas', start_time: '09:00', end_time: '10:29', interval_minutes: 1, batch_size: 1 },
  { task: 'score', label: 'Encontrar contatos e classificar', start_time: '10:30', end_time: '10:59', interval_minutes: 2, batch_size: 15 },
  { task: 'prepare', label: 'Preparar novos contatos', start_time: '11:00', end_time: '11:59', interval_minutes: 2, batch_size: 10 },
  { task: 'outreach', label: 'Executar prospecção autorizada', start_time: '13:00', end_time: '13:59', interval_minutes: 1, batch_size: 1 },
  { task: 'inbox', label: 'Verificar respostas', start_time: '08:00', end_time: '19:00', interval_minutes: 15, batch_size: 10 },
  { task: 'followup', label: 'Sequência de e-mails (2º e 3º toques)', start_time: '15:00', end_time: '15:59', interval_minutes: 1, batch_size: 1 },
  { task: 'plan', label: 'Montar a rotina do dia (tela Hoje)', start_time: '06:30', end_time: null, interval_minutes: 0, batch_size: 1 },
  { task: 'reminders', label: 'Lembretes de reunião', start_time: '06:00', end_time: '22:00', interval_minutes: 15, batch_size: 1, days: '0,1,2,3,4,5,6' },
  { task: 'report', label: 'Atualizar relatórios e limpeza', start_time: '17:00', end_time: null, interval_minutes: 0, batch_size: 1 },
];

// ---------- Lista de exclusão do sistema (Arco: saúde e concorrentes) ----------
// keyword: palavra inteira normalizada (sem acento); "*" no fim = prefixo.

const HEALTH_BLOCK = [
  'clinica*', 'clinic*', 'policlinica*', 'consultorio*', 'hospital*', 'hospitalar*', 'laboratorio*', 'labs clinicos',
  'odonto*', 'dentista*', 'dental', 'dentario*', 'dentaria*', 'ortodont*', 'implantodont*', 'protese dentaria',
  'estetica*', 'esteticista*', 'harmonizacao', 'dermato*', 'medico*', 'medica', 'medicas', 'medicina', 'medical',
  'saude', 'fisioterap*', 'psicolog*', 'psiquiatr*', 'psicanal*', 'nutricionist*', 'fonoaudiolog*', 'enfermagem',
  'home care', 'farmacia*', 'drogaria*', 'farmaceutic*', 'veterinari*', 'oftalmo*', 'cardiolog*', 'ortoped*',
  'pediatr*', 'ginecolog*', 'urolog*', 'oncolog*', 'radiolog*', 'ultrassom', 'tomografia', 'exames', 'hemodialise',
  'terapia*', 'terapeut*', 'acupuntura', 'quiropraxia', 'podolog*', 'botox', 'depilacao', 'micropigmentacao',
  'spa', 'prontuario*', 'telemedicina', 'plano de saude', 'planos de saude', 'convenio medico', 'ambulatori*',
  'pronto socorro', 'maternidade', 'biomedic*', 'endocrino*', 'otorrino*', 'neurolog*', 'reumatolog*',
  'cirurgia*', 'cirurgiao*', 'vacina*', 'imunizacao', 'diagnostico por imagem', 'audiolog*', 'aparelho auditivo',
  'paciente*', 'ostom*', 'doenca*', 'hemato*', 'oncologic*', 'reabilitacao', 'ortese*', 'protese*',
];

const DOUBT_REVIEW = [
  'beleza', 'salao', 'saloes', 'cabeleireir*', 'barbearia*', 'cosmetic*', 'academia*', 'pilates', 'crossfit',
  'bem estar', 'wellness', 'otica*', 'pet', 'petshop', 'pet shop', 'cuidador*', 'casa de repouso', 'geriatri*',
  'massagem', 'massoterap*', 'yoga', 'emagrecimento', 'suplemento*', 'diagnostico*', 'cuidados pessoais',
  // possíveis concorrentes indiretos da Arco (agências/software) — em dúvida, revisão manual
  'agencia de marketing', 'marketing digital', 'marketing medico', 'marketing odontologico', 'software house',
  'desenvolvimento de software', 'gestao de clinicas', 'arco',
];

const HEALTH_CATEGORIES = [
  'amenity=clinic', 'amenity=doctors', 'amenity=dentist', 'amenity=hospital', 'amenity=pharmacy',
  'amenity=veterinary', 'amenity=nursing_home', 'amenity=baby_hatch', 'healthcare=*', 'healthcare:speciality=*',
  'shop=medical_supply', 'shop=optician', 'shop=hearing_aids', 'office=therapist', 'office=physician',
  'office=medical', 'social_facility=nursing_home', 'emergency=ambulance_station',
];

const REVIEW_CATEGORIES = [
  'shop=beauty', 'shop=cosmetics', 'shop=hairdresser', 'shop=chemist', 'shop=massage', 'shop=pet',
  'leisure=fitness_centre', 'leisure=sports_centre', 'amenity=social_facility', 'shop=nutrition_supplements',
  'shop=herbalist', 'office=advertising_agency', 'office=it',
];

// CNAE (prefixos, sem pontuação). Saúde humana (86), saúde+assistência (87), veterinária (75),
// farmacêutica, instrumentos médicos/odontológicos, comércio de produtos de saúde, planos de saúde, estética.
const HEALTH_CNAE = ['86', '87', '75', '2110', '2121', '2122', '2123', '3250', '4644', '4645', '4664',
  '4771', '4773', '4774', '6550', '9602502'];
const REVIEW_CNAE = ['9602501', '9313', '4772', '6201', '6202', '6203', '6204', '7311'];

// Software de gestão de clínicas / saúde e a própria Arco.
const COMPETITOR_COMPANIES = [
  'hofhub', 'clinify', 'feegow', 'iclinic', 'clinicorp', 'doctoralia', 'ninsaude', 'amplimed',
  'simples dental', 'simplesdental', 'dental office', 'prodoctor', 'shosp', 'clinic nas nuvens', 'gestaods',
  'medicinae', 'tasy', 'mv sistemas', 'pixeon', 'conclinica', 'belle software', 'trinks', 'medplus',
  'clinicweb', 'easy dental', 'hiclinic', 'consultorio digital', 'versatilis', 'agendasaude',
];
const COMPETITOR_DOMAINS = ['arco.ag'];

export function defaultExclusionRules() {
  const r = [];
  for (const v of HEALTH_BLOCK) r.push(['keyword', v, 'Setor de saúde (contrato Arco)']);
  for (const v of DOUBT_REVIEW) r.push(['review_keyword', v, 'Possível saúde/beleza ou concorrente — revisar']);
  for (const v of HEALTH_CATEGORIES) r.push(['category', v, 'Categoria de saúde (contrato Arco)']);
  for (const v of REVIEW_CATEGORIES) r.push(['review_category', v, 'Categoria em dúvida — revisar']);
  for (const v of HEALTH_CNAE) r.push(['cnae', v, 'CNAE de saúde (contrato Arco)']);
  for (const v of REVIEW_CNAE) r.push(['review_cnae', v, 'CNAE em dúvida — revisar']);
  for (const v of COMPETITOR_COMPANIES) r.push(['company', v, 'Arco ou concorrente da Arco']);
  for (const v of COMPETITOR_DOMAINS) r.push(['domain', v, 'Arco']);
  return r;
}
