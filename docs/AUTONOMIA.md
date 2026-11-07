# Rodar sozinho na nuvem

Depois de uma configuração única (cerca de 30 minutos, feita uma vez), o Aureon roda sozinho na Cloudflare: descobre, analisa, pontua, escreve, envia, lê respostas, descadastra, oferece agenda e marca reuniões, todo dia útil, com seu computador desligado. Atualizações de código são publicadas pelo GitHub a cada push.

## O que já está automatizado

| Peça | Como roda sozinha |
|---|---|
| Publicação | GitHub Actions **Testar e publicar**: a cada push na `main`, roda os 54 testes e, se passarem, publica. Na primeira vez cria o banco D1, aplica o schema, descobre a URL e gera a chave de criptografia |
| Rotina diária | 1 Cron da Cloudflare por minuto; o agendador central segue os horários de **Automação** |
| Falhas | retentativas com espera crescente, recuperação de tarefas travadas, tarefa diária perdida roda no próximo ciclo |
| Cotas gratuitas | ao chegar perto do limite, só a tarefa afetada pausa e volta sozinha às 00:00 UTC |
| Avisos | resumo diário de alertas por e-mail (17h) + **Vigia** no GitHub a cada 3 h: se o Cron parar, o Google expirar ou a pausa emergencial ficar ligada, a execução falha e o GitHub te manda e-mail |
| Backup | Time Travel do D1 (7 dias, automático) |

## Configuração única — o que só você pode fazer

Estes passos exigem login, aceite de termos ou criação de credenciais nas suas contas; por isso ficam com você.

### 1. Cloudflare (10 min)

1. Crie a conta gratuita em https://dash.cloudflare.com/sign-up.
2. Abra **Workers & Pages** uma vez: isso cria o seu subdomínio `*.workers.dev`.
3. Copie o **Account ID**: na página inicial da conta, menu **⋯** ao lado do nome da conta → **Copy account ID** (também aparece na barra lateral de Workers & Pages).
4. Crie o token: ícone de perfil → **My Profile** → **API Tokens** → **Create Token** → modelo **Edit Cloudflare Workers** → **Use template**.
   - Em **Permissions**, clique **+ Add more** e adicione **Account · D1 · Edit**.
   - **Account Resources**: Include → a sua conta. **Zone Resources**: All zones (ou deixe como o modelo sugere).
   - **Continue to summary** → **Create Token** → copie o token (ele só aparece uma vez).

### 2. Segredos no GitHub (5 min)

No repositório: **Settings → Secrets and variables → Actions → New repository secret**. Crie:

| Nome | Valor |
|---|---|
| `CLOUDFLARE_API_TOKEN` | o token do passo 1.4 |
| `CLOUDFLARE_ACCOUNT_ID` | o Account ID do passo 1.3 |
| `SETUP_TOKEN` | uma frase longa que só você sabe (vai pedir no primeiro acesso) |

Depois: aba **Actions** → **Testar e publicar** → **Run workflow**. Em ~3 minutos, o resumo da execução mostra **"Aureon publicado em https://aureon-sales-engine.SEU-SUBDOMINIO.workers.dev"**. Essa é a URL do sistema.

Opcional: se usar um domínio próprio, crie em **Variables** a variável `APP_URL` com ele.

### 3. Google (15 min)

Siga [CONFIGURACAO-GOOGLE.md](CONFIGURACAO-GOOGLE.md) usando a URL do passo 2 no redirecionamento (`URL/api/google/callback`). Depois cadastre no GitHub os segredos `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET` e rode **Run workflow** de novo (ele copia os segredos para o Worker).

**Para não precisar reconectar toda semana**, no Google Cloud deixe o app como **Interno** (conta Workspace) ou **Publicado / Em produção** (conta Gmail pessoal). Em "Teste", o Google derruba o acesso a cada 7 dias — é a única coisa que quebraria a autonomia.

### 4. No painel (10 min, pelo celular)

1. Abra a URL → **Instalar o Aureon** → código = `SETUP_TOKEN`, seu nome, e-mail e senha.
2. **Configurações → Remetente**: nome, empresa e o e-mail da conta Google.
3. **Configurações → Google → Conectar Google** → aceite → **Testar conexão** → **E-mail de teste**.
4. **Automação → Alvos de descoberta**: cadastre as cidades e segmentos que quer prospectar (ex.: 5 a 10 alvos). Sem alvos, a descoberta não tem onde procurar.
5. Deixe rodar um dia em simulação e leia as mensagens em **Conversas**.
6. **Configurações → Envio de e-mails** → digite `ATIVAR`. Esta aprovação é obrigatória por decisão do projeto: nenhuma campanha real começa sem você.
7. Opcional, para menos intervenção: **Configurações → Respostas automáticas** → ligue "Pedido de reunião → link de agenda" (e, se quiser, os outros dois).

A partir daqui, nada mais é obrigatório.

## O que ainda pode pedir você (e por quê)

| Situação | Frequência | O sistema faz | Você faz |
|---|---|---|---|
| Resposta ambígua, objeção, pergunta de preço | algumas por semana | marca **Revisão necessária**, nunca responde sozinho | responde pelo painel (é proteção, não falha) |
| Empresa em dúvida na lista de exclusão | eventual | não prospecta | libera ou bloqueia em **Empresas → Em revisão** |
| Alvos esgotados (as mesmas cidades param de render empresas novas) | a cada algumas semanas | segue as outras etapas; a busca registra "0 novas" | adiciona cidades/segmentos (o segmento "Descoberta automática" ajuda) |
| Google desconectado (troca de senha da conta, acesso revogado) | raro | para envios e leitura, alerta por e-mail e pelo Vigia | clica **Conectar Google** |
| Servidor público do OpenStreetMap fora do ar | raro | tenta de novo mais tarde | nada |
| Cota diária gratuita atingida | raro com os limites padrão | pausa só a tarefa, volta às 00:00 UTC | nada (ou ajusta limites) |
| Erro de CPU (1102) no plano gratuito | não observado ainda | a tarefa falha e tenta de novo | se repetir, reduz o lote do Investigator para 1 |

## Custos

Zero com os limites padrão: Workers, D1 e Cron no plano gratuito (que bloqueia em vez de cobrar), GitHub Actions dentro da cota gratuita de repositório privado (o Vigia usa cerca de 240 minutos por mês), APIs do Google sem cobrança para este uso.
