# Publicar na Cloudflare

**Caminho recomendado: pelo GitHub**, sem terminal — veja [AUTONOMIA.md](AUTONOMIA.md). O workflow `.github/workflows/deploy.yml` faz sozinho os passos 2 a 4 abaixo (cria o D1, aplica migrations, publica, gera a `ENCRYPTION_KEY` e acerta o `APP_URL`).

Este arquivo descreve o caminho manual, pelo terminal, caso prefira ou precise depurar. Tudo cabe no plano gratuito; nenhum passo pede cartão de crédito. Faça na ordem.

## 0. Pré-requisitos

- **Node.js 22+** — baixe o instalador LTS em https://nodejs.org e confira com `node -v`.
- Uma conta Cloudflare gratuita: https://dash.cloudflare.com/sign-up.
- (Para o deploy automático) uma conta GitHub.

Na pasta do projeto:

```bash
npm install
```

## 1. Entrar na Cloudflare pelo terminal

```bash
npx wrangler login
```

Abre o navegador; clique em **Allow**. Para conferir:

```bash
npx wrangler whoami
```

## 2. Criar o banco D1

```bash
npx wrangler d1 create aureon
```

A saída mostra um bloco com `"database_id": "…"`. Abra `wrangler.jsonc` e troque `00000000-0000-0000-0000-000000000000` por esse id.

Aplique o schema no banco da nuvem:

```bash
npx wrangler d1 migrations apply aureon --remote
```

Deve listar `0001_init.sql ✅`.

## 3. Criar os segredos

Gere uma chave de criptografia (copie a saída):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Cadastre cada segredo (o terminal pede o valor; cole e Enter):

```bash
npx wrangler secret put ENCRYPTION_KEY
```

```bash
npx wrangler secret put SETUP_TOKEN
```

`SETUP_TOKEN` é um código que só você sabe, usado uma vez para criar o administrador (ex.: uma frase longa aleatória).

As credenciais Google entram depois do passo 5 (ver [CONFIGURACAO-GOOGLE.md](CONFIGURACAO-GOOGLE.md)):

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
```

```bash
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

Opcional, para medir velocidade com o PageSpeed:

```bash
npx wrangler secret put PSI_API_KEY
```

> **Importante:** guarde o `ENCRYPTION_KEY` num gerenciador de senhas. Se ele mudar, os tokens Google salvos deixam de abrir (basta reconectar o Google) e os links de descadastro já enviados deixam de ser reconhecidos (os pedidos por resposta "descadastrar" continuam funcionando).

## 4. Publicar

```bash
npx wrangler deploy
```

No fim aparece a URL, algo como `https://aureon-sales-engine.SEU-SUBDOMINIO.workers.dev`.

Abra `wrangler.jsonc`, troque `"APP_URL": "http://localhost:8787"` por essa URL (sem barra no fim) e publique de novo:

```bash
npx wrangler deploy
```

O `APP_URL` é usado nos links de agendamento e descadastro e no retorno do login Google.

## 5. Primeiro acesso

1. Abra a URL no celular ou no computador.
2. A tela **Instalar o Aureon** aparece: informe o `SETUP_TOKEN`, seu nome, e-mail e uma senha de 12+ caracteres.
3. Vá em **Mais → Configurações → Remetente** e preencha nome e e-mail (o mesmo da conta Google que vai enviar).
4. Siga [CONFIGURACAO-GOOGLE.md](CONFIGURACAO-GOOGLE.md) para conectar Gmail e Agenda.

**Como validar que funcionou:** em **Mais → Automação**, o texto "último ciclo" deve mostrar "há 1 min" (o Cron roda a cada minuto). Em **Mais → Uso e limites**, "Ciclos do Cron" cresce ao longo do dia.

### Instalar no iPhone

Abra a URL no **Safari** → botão Compartilhar → **Adicionar à Tela de Início**. O app abre em tela cheia, com a barra inferior de navegação.

## 6. Alternativa: Workers Builds da Cloudflare

O repositório já publica pelo GitHub Actions. Use o Workers Builds só se preferir que a própria Cloudflare puxe do GitHub (não ligue os dois ao mesmo tempo).

1. Crie um repositório **privado** em https://github.com/new (ex.: `aureon-sales-engine`), sem README.
2. Na pasta do projeto:

```bash
git init
```

```bash
git add .
```

```bash
git commit -m "Aureon: primeira versão"
```

```bash
git branch -M main
```

```bash
git remote add origin https://github.com/SEU-USUARIO/aureon-sales-engine.git
```

```bash
git push -u origin main
```

O `.gitignore` já impede o envio de `.dev.vars`, `.wrangler/` e `node_modules/`. Antes do primeiro push, confira com `git status` que nenhum arquivo de segredo aparece.

3. Ligue o deploy automático: Cloudflare Dashboard → **Workers & Pages** → `aureon-sales-engine` → **Settings** → **Builds** → **Connect** → escolha o repositório e a branch `main`.
   - Build command: deixe vazio.
   - Deploy command: `npx wrangler d1 migrations apply aureon --remote && npx wrangler deploy`
   - Plano gratuito do Workers Builds (conferido na documentação): 3.000 minutos de build por mês, 1 build por vez, 20 minutos por build.
4. A cada `git push` na `main`, a Cloudflare aplica migrations novas e publica.

## Backups

- **Time Travel do D1** (gratuito, 7 dias): restaura o banco para qualquer minuto da última semana.

```bash
npx wrangler d1 time-travel info aureon
```

- **Exportação completa** do banco para um arquivo SQL local:

```bash
npx wrangler d1 export aureon --remote --output=backup-aureon.sql
```

- Pelo painel: **Configurações → Baixar backup (JSON)** (dados de negócio, sem senhas nem tokens).

## Atualizar depois

Com GitHub ligado: `git push`. Sem GitHub: `npm run deploy` (aplica migrations e publica).
