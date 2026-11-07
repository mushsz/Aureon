# Aureon — Autonomous Sales Engine

Plataforma de prospecção comercial que roda sozinha na Cloudflare (plano gratuito): descobre empresas em fontes abertas, analisa a presença digital com evidências, pontua, encontra canais comerciais publicados, escreve abordagens personalizadas, envia pelo seu Gmail dentro de limites e horários, lê as respostas, encaminha interessados para a sua agenda Google e mostra tudo num painel instalável no iPhone.

> Projeto pessoal, independente da Arco. A única ligação é a **lista de exclusão permanente**: nada de saúde e nada de concorrentes da Arco. Na dúvida, o sistema não prospecta.

## Estado atual (07/11/2026)

| Item | Situação |
|---|---|
| Código (backend, agentes, painel PWA) | Pronto, rodando localmente |
| Testes automatizados | 54 testes passando no runtime real dos Workers (`npm test`), também no GitHub Actions |
| Teste ponta a ponta com dados reais | Feito localmente: OpenStreetMap real, sites reais, envio em simulação |
| Publicação na Cloudflare | Automática pelo GitHub Actions assim que você cadastrar o token da Cloudflare no repositório ([docs/AUTONOMIA.md](docs/AUTONOMIA.md)) |
| Gmail e Google Agenda | **Não conectados** — precisam das suas credenciais ([docs/CONFIGURACAO-GOOGLE.md](docs/CONFIGURACAO-GOOGLE.md)). O fluxo foi testado com respostas simuladas da API do Google, não com a sua conta |
| Repositório GitHub | Privado, com deploy (`deploy.yml`) e vigia de saúde a cada 3 h (`monitor.yml`) |

## Como funciona

```
Cron (1 gatilho, a cada minuto) ──► agendador central (src/engine.js)
                                      │ lê a rotina na tabela schedules
                                      │ cria jobs (fila persistente no D1, com dedupe)
                                      ▼
  FINDER ──► INVESTIGATOR ──► CONTACT FINDER + SCORER ──► COPYWRITER ──► OUTREACH ──► INBOX ──► CLOSER ──► SCHEDULER
  OSM/import   site + robots     canais + base legal       mensagem        Gmail         Gmail     resposta    Google Agenda
               + CNPJ (opcional) + pontuação 0–100         com evidência   (ou simulação) regras    autorizada  + página pública
        └──────────── lista de exclusão aplicada na descoberta, depois da análise e antes de cada envio ────────────┘
```

- **Um único Worker** serve a API, as páginas públicas (agendamento e descadastro), o painel (Static Assets) e o Cron.
- **D1** guarda tudo: as 19 tabelas pedidas mais sessões, limites de tentativa, estados OAuth, histórico de etapas e auditoria (24 no total).
- **Execução em pequenos lotes**: cada ciclo faz pouco, grava o progresso e sai. Nada depende do seu computador.
- **Sem IA paga**: classificação, pontuação e textos são regras e modelos próprios, determinísticos e testados.

Detalhes e decisões: [docs/ARQUITETURA.md](docs/ARQUITETURA.md).

## Comandos

Requer **Node.js 22 ou mais novo** (o wrangler atual exige).

```bash
npm install
```

```bash
npm run db:migrate:local
```

```bash
npm run dev
```

```bash
npm test
```

Teste de fumaça contra o Worker rodando (consulta dados reais do OSM e de sites; e-mails em simulação):

```bash
node scripts/smoke.mjs http://localhost:8787
```

Disparar um ciclo do Cron no ambiente local:

```bash
npm run cron:local
```

## Documentação

- [docs/AUTONOMIA.md](docs/AUTONOMIA.md) — **comece aqui**: configuração única para rodar sozinho na nuvem, e o que ainda pode pedir você.
- [docs/DEPLOY.md](docs/DEPLOY.md) — publicação manual pelo terminal (alternativa).
- [docs/CONFIGURACAO-GOOGLE.md](docs/CONFIGURACAO-GOOGLE.md) — criar as credenciais OAuth do Gmail e do Google Agenda.
- [docs/OPERACAO.md](docs/OPERACAO.md) — configurar horários, ativar a primeira campanha, rotina diária, manutenção.
- [docs/ARQUITETURA.md](docs/ARQUITETURA.md) — arquitetura, limites gratuitos verificados, decisões, segurança, LGPD.
- [docs/TESTES.md](docs/TESTES.md) — o que foi testado, como, e o que ainda depende das suas contas.

## Estrutura

```
src/
  index.js          entrada do Worker (fetch + scheduled)
  engine.js         agendador central, fila, retentativas, recuperação, cotas
  api.js            rotas do painel e páginas públicas
  auth.js           senha PBKDF2, sessão, CSRF, limite de tentativas
  db.js             acesso ao D1 com contagem de consultas/linhas, logs e métricas em lote
  exclusion.js      lista de exclusão (saúde, concorrentes, CNAE, domínios) e supressão
  google.js         OAuth, Gmail API e Calendar API via REST
  defaults.js       configurações, rotina, serviços e regras padrão
  agents/           finder, investigator, contacts, scorer, copywriter, outreach, inbox, closer, scheduler
public/             painel PWA (HTML/CSS/JS sem build), páginas públicas, service worker, ícones
migrations/         schema SQL do D1
test/               testes (unidade + integração) no runtime dos Workers
scripts/            teste de fumaça e gerador de ícones
```
