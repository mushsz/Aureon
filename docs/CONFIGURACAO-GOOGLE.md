# Credenciais Google (Gmail API e Google Calendar API)

O Aureon envia e lê e-mails **pela sua própria conta Gmail** e marca reuniões **na sua agenda**, com autorização OAuth sua. Nenhuma senha é guardada; o token de acesso fica cifrado no banco.

Tempo estimado: 15 minutos. Custo: zero.

## 1. Projeto no Google Cloud

1. Entre em https://console.cloud.google.com com a conta que vai enviar os e-mails.
2. No topo, seletor de projetos → **Novo projeto** → nome `Aureon` → **Criar**. Confirme que o projeto `Aureon` está selecionado.

## 2. Ativar as APIs

Menu ☰ → **APIs e serviços** → **Biblioteca**. Procure e clique **Ativar** em:

- **Gmail API**
- **Google Calendar API**
- (opcional) **PageSpeed Insights API** — só se quiser medir velocidade dos sites.

## 3. Tela de consentimento (Google Auth Platform)

Menu ☰ → **APIs e serviços** → **Tela de consentimento OAuth** (ou **Google Auth Platform**).

1. **Branding / Informações do app**: nome `Aureon`, e-mail de suporte = seu e-mail. Domínio autorizado: `workers.dev` (ou o seu domínio, se usar um).
2. **Público (Audience)**:
   - Conta **Google Workspace** (e-mail da sua empresa): escolha **Interno**. Não precisa de verificação e o acesso não expira em 7 dias.
   - Conta **Gmail pessoal**: escolha **Externo** e, em **Usuários de teste**, adicione o seu e-mail.
3. **Acesso a dados (Data access) → Adicionar escopos**. Marque:
   - `openid` e `.../auth/userinfo.email`
   - `https://www.googleapis.com/auth/gmail.send`
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/calendar.events`
   - `https://www.googleapis.com/auth/calendar.freebusy`

### Atenção ao status "Teste" (conta Gmail pessoal)

A documentação do Google diz que, em apps **Externos com status "Teste"**, o refresh token **expira em 7 dias**. Na prática: a cada semana o painel mostra "Acesso expirado" e você precisa clicar em **Conectar Google** de novo.

Para evitar, em **Público → Publicar app** (status "Em produção"). Como o app usa escopos restritos do Gmail e não será verificado, o Google mostra a tela "O Google não verificou este app" ao conectar; para a sua própria conta, clique em **Avançado → Acessar Aureon**. Apps não verificados ficam limitados a 100 usuários — irrelevante aqui, porque só você usa. Se preferir não publicar, mantenha "Teste" e reconecte semanalmente.

## 4. Criar o ID do cliente OAuth

Menu ☰ → **APIs e serviços** → **Credenciais** → **Criar credenciais** → **ID do cliente OAuth**.

- Tipo: **Aplicativo da Web**. Nome: `Aureon Worker`.
- **URIs de redirecionamento autorizados** → **Adicionar URI**:
  - `https://aureon-sales-engine.SEU-SUBDOMINIO.workers.dev/api/google/callback` (o seu `APP_URL` + `/api/google/callback`)
  - para testar localmente, também: `http://localhost:8787/api/google/callback`
- **Criar**. Copie o **ID do cliente** e a **Chave secreta do cliente**.

## 5. Guardar no Worker

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
```

```bash
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

Para o ambiente local, coloque os mesmos valores em `.dev.vars` (esse arquivo nunca vai para o Git).

## 6. Conectar e validar no painel

1. **Mais → Configurações → Google → Conectar Google**.
2. Escolha a conta, aceite as permissões (Gmail: enviar e ler; Agenda: eventos e disponibilidade).
3. De volta ao painel, aparece "Google conectado". Clique **Testar conexão**:
   - "Gmail: ok (seu@email)" e "Agenda: ok (N compromissos…)" = funcionando.
4. Clique **E-mail de teste**: chega na sua caixa um e-mail "Aureon: e-mail de teste". Isso valida o envio.
5. Em **Agenda → Horários livres**: lista os horários vagos da sua agenda conforme a disponibilidade configurada. Isso valida a consulta à agenda.

## O que o Aureon faz e não faz com a sua conta

- **Envia** só mensagens de prospecção aprovadas (depois que você ativa o envio real), respostas autorizadas do Closer, confirmações de reunião, respostas que você mesmo escreve no painel e o resumo diário de alertas para você.
- **Lê** a caixa de entrada, mas **só guarda** mensagens que pertencem a conversas que o próprio sistema iniciou (mesmo fio do Gmail ou remetente igual ao contato abordado). Os demais e-mails são ignorados e não ficam registrados.
- **Agenda**: consulta horários ocupados (sem ler o conteúdo dos eventos) e cria/cancela só os eventos das reuniões marcadas pelo link.
- Para revogar a qualquer momento: painel → **Desconectar**, ou https://myaccount.google.com/permissions.
