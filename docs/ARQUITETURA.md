# Arquitetura e decisões

## Componentes

| Peça | Serviço | Por quê |
|---|---|---|
| API, páginas públicas, Cron | **Cloudflare Workers** (1 Worker) | Sem servidor ligado; paga-se zero no plano gratuito |
| Painel PWA | **Workers Static Assets** (mesmo Worker) | Veja a decisão 1 |
| Banco | **Cloudflare D1** | SQLite gerenciado, gratuito, com Time Travel de 7 dias |
| Agendamento | **1 Cron Trigger** (`* * * * *`) + agendador central | Rotina inteira configurável no banco, sem dezenas de gatilhos |
| Fila | Tabela `automation_jobs` no D1 | Veja a decisão 2 |
| E-mail | **Gmail API** (OAuth do usuário) | Envia da conta real do usuário, sem contas falsas |
| Agenda | **Google Calendar API** (freeBusy + events) | Disponibilidade real e convite oficial |
| Descoberta | **OpenStreetMap / Overpass API** + importação manual | Dados abertos (ODbL) com reutilização permitida |
| CNPJ/CNAE | **BrasilAPI** (dados públicos da Receita) | Gratuito; usado para reforçar a exclusão de saúde |
| Velocidade | **PageSpeed Insights API** (opcional) | Gratuito; desligado por padrão |

## Limites do plano gratuito (conferidos na documentação oficial em 07/11/2026)

- **Workers**: 100.000 requisições/dia (zera 00:00 UTC); **10 ms de CPU** por requisição e por Cron; 50 subrequisições externas por execução; **5 Cron Triggers por conta**; 128 MB de memória.
- **D1**: 5 milhões de linhas lidas/dia, 100.000 linhas gravadas/dia, 5 GB no total, 500 MB por banco, **50 consultas por execução** (um `batch()` conta como uma), 100 parâmetros por consulta. Ao estourar a cota diária, as consultas falham até 00:00 UTC — **não há cobrança**.
- **Queues**: disponível no gratuito com 10.000 operações/dia e retenção de 24 h.
- **Overpass (servidor público)**: uso leve (para uso recorrente, ~100 consultas e ~10 MB/dia), identificado por User-Agent, sem consultas paralelas, pausa após 429. A política pede servidor próprio/pago para uso comercial pesado — o Aureon usa no máximo 40 consultas/dia por padrão e permite trocar a instância.
- **Workers Builds** (deploy pelo GitHub): 3.000 minutos/mês, 1 build por vez.
- **Google OAuth**: app Externo em "Teste" → refresh token expira em 7 dias; app não verificado → limite de 100 usuários.

## Decisões

1. **Workers Static Assets em vez de Cloudflare Pages.** Pages não tem Cron Triggers, então o backend teria de ser um Worker separado de qualquer forma; com tudo num Worker, painel e API ficam no mesmo domínio (cookie de sessão HttpOnly sem CORS nem cookies de terceiros, o que no Safari/iPhone evita bloqueios). Arquivos estáticos não contam como invocações pagas. É a recomendação atual da Cloudflare para projetos novos. Se ainda quiser o Pages, o diretório `public/` funciona como site estático, mas as rotas `/api`, `/u` e `/agendar` precisariam de proxy para o Worker.
2. **Fila no D1 em vez de Cloudflare Queues.** Queues é gratuito, mas guarda mensagens só por 24 h e é mais um serviço para manter. A fila em tabela é inspecionável no painel, permite deduplicação por chave única, retentativas com backoff, "desistiu" após 5 tentativas e recuperação de tarefas travadas — tudo com o que já existe.
3. **Um Cron por minuto + lotes pequenos.** Por causa dos 10 ms de CPU e 50 consultas por execução, cada ciclo processa pouco (ex.: 2 sites) e para quando o orçamento de consultas acaba (`QUERY_BUDGET = 45`). Os estados (`pending → investigating → investigated`, `draft → sending → sent`) são a própria fila: se algo cair no meio, a recuperação devolve à fila.
4. **HTMLRewriter nativo** para ler HTML (streaming, barato em CPU) e leitura limitada a 400 KB por página.
5. **Nada de IA paga.** Classificação de respostas por regras com tratamento de negação ("não tenho interesse" não casa com "tenho interesse"), descadastro sempre vence, ambiguidade → revisão humana.
6. **Sem dependências em produção.** O Worker usa só APIs da plataforma (fetch, WebCrypto, Intl, HTMLRewriter). O painel é HTML/CSS/JS sem build.

## Fluxo de um lead

`descoberto` → (Investigator) `em_analise` → (Scorer) `qualificado` → (Copywriter) `aguardando_contato` → (Outreach) `contatado` → (Inbox) `respondeu` / `interessado` / `perdido` / `nao_contatar` → (Scheduler) `reuniao_agendada` → (você) `convertido`.

Cada mudança de etapa grava `lead_stage_history` (quem, quando, por quê).

## Rotina diária (tela Hoje)

- O **Planner** (`src/agents/planner.js`) roda às 06:30 e monta a tabela `tasks`: responder (100), quentes (90), reuniões (80), toques da sequência (60–70) e decisões (30). Cada tarefa tem chave única por empresa/passo/dia, então montar de novo não duplica. Eventos criam tarefas na hora: resposta recebida (Inbox) e abertura da análise (`/analise/:token/visto`).
- **Toques manuais**: o sistema escolhe o canal (WhatsApp → Instagram → ligação, sem repetir o anterior), escreve o texto e gera o link oficial (`wa.me` com texto, `ig.me/m`, `tel:`). Quem envia é você. Por isso não há violação das regras da Meta, que só permitem mensagem de empresa a quem escreveu antes (Instagram) ou com autorização prévia e modelo aprovado (WhatsApp Business).
- **Supressão em todos os canais**: descadastro, recusa, falha de entrega ou "Não contatar" gravam o e-mail, o telefone/WhatsApp e o @ do Instagram na lista de supressão.
- **Mini-auditoria** (`/analise/:token`): página pública só com observações do site da empresa (nada interno, nada pessoal), fora do Google (`noindex`). A abertura conta por um sinal enviado pela própria página depois de 4 s visível, para ignorar robôs de segurança de e-mail.
- **Confirmações e lembretes de reunião** saem pelo Gmail mesmo em modo simulação: são mensagens transacionais para quem pediu a reunião, não prospecção.

## Lista de exclusão (contrato Arco)

Aplicada em 4 pontos: ao descobrir (nome, categoria OSM, domínio, e-mail), depois de ler o site (texto + CNAE do CNPJ), ao preparar a mensagem e imediatamente antes de cada envio.

- **Bloqueia**: palavras de saúde (clínica, consultório, hospital, laboratório, odonto, estética, fisioterapia, farmácia, veterinária…), categorias OSM de saúde (`amenity=dentist`, `healthcare=*`…), CNAEs de saúde (86, 87, 75, farmacêuticos, instrumentos médicos, comércio de produtos de saúde, planos de saúde, estética 9602-5/02), softwares de gestão de clínicas (Feegow, iClinic, Clinicorp, Doctoralia…) e o domínio `arco.ag`.
- **Segura para revisão** (não prospecta sem você liberar): beleza, salão, academia, ótica, pet, agências de marketing, software houses, CNAE de software, o nome "Arco" e termos de saúde que aparecem só no texto do site.
- Empresas bloqueadas nem têm o site visitado.

## Segurança

- Senhas com PBKDF2-SHA256 (100.000 iterações, o máximo aceito pelo runtime dos Workers), sal aleatório, comparação em tempo constante.
- Sessão: token aleatório só no cookie `HttpOnly; Secure; SameSite=Lax`; no banco fica o SHA-256. Expira em 14 dias; trocar a senha derruba as outras sessões.
- CSRF: toda rota que altera dados exige o cabeçalho `X-CSRF-Token` da sessão e Origin do próprio app. Formulários públicos (agendamento) levam um HMAC do link.
- Limite de tentativas: login (8 por e-mail e 20 por IP a cada 15 min), instalação, descadastro e agendamento por IP.
- Tokens Google cifrados com AES-256-GCM (chave derivada do `ENCRYPTION_KEY` por HKDF); nunca vão ao frontend. Links de descadastro assinados com HMAC.
- Cabeçalhos: CSP restrita (sem script ou estilo inline), `X-Frame-Options: DENY`, HSTS, `nosniff`.
- Entradas validadas no servidor; cabeçalhos de e-mail limpos contra injeção; HTML de terceiros (nomes de empresas, e-mails recebidos) sempre escapado.
- Auditoria (`audit_log`): logins, falhas, mudanças de configuração, regras, aprovações, pausas, exclusões, exportações.
- Segredos só em `wrangler secret`/`.dev.vars` (fora do Git). `.env.example` e `.dev.vars.example` sem valores reais.

## LGPD e comunicação comercial

- Só dados de empresas e canais **publicados pela própria empresa**. O quadro societário retornado pela consulta de CNPJ é descartado.
- Base legal registrada por contato: **legítimo interesse (art. 7º, IX)** para e-mail institucional (contato@, comercial@…) no domínio da própria empresa. E-mails de provedores gratuitos ou de outro domínio ficam **pendentes de revisão** e não recebem envio automático. Não se presume consentimento.
- **E-mail nominal** (joao@empresa.com.br) só é usado se você ligar a opção, e só quando está **publicado pela própria empresa no site dela** e no domínio dela. O contato registra a avaliação de balanceamento: endereço profissional ligado à função, sem dado sensível, finalidade B2B explícita e descadastro em toda mensagem. O nome usado na saudação precisa estar escrito na página; nunca é deduzido só do endereço. Não há adivinhação de e-mails, cruzamento com sócios do CNPJ nem uso do LinkedIn.
- WhatsApp, Instagram e telefone vêm do site da empresa ou do OpenStreetMap e são usados só por você, manualmente, com a opção "Não contatar" sempre à mão.
- Toda mensagem identifica o remetente, diz que é contato comercial, não inventa relacionamento, não promete resultado e traz descadastro por resposta ou link (incluindo o cabeçalho `List-Unsubscribe` de um clique).
- Descadastro, recusa e falha de entrega entram na lista de supressão permanente e cancelam rascunhos pendentes.
- Exclusão de dados de uma empresa a pedido: **Empresas → Ações → Excluir dados**.
- Ainda vale uma revisão jurídica sua do texto e da política antes de escalar o volume.
