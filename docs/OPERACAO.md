# Operação: horários, primeira campanha, rotina e manutenção

## Rotina padrão (editável em Mais → Automação)

Todos os horários estão no fuso `America/Sao_Paulo`, de segunda a sexta.

| Tarefa | Janela | Frequência | Lote | O que faz |
|---|---|---|---|---|
| Descobrir novas empresas | 08:00–08:59 | a cada 10 min | 1 alvo | Consulta o OpenStreetMap para o próximo alvo cadastrado |
| Investigar empresas | 09:00–09:59 | a cada 1 min | 2 sites | Lê robots.txt e a página inicial, registra achados |
| Encontrar contatos e classificar | 10:00–10:59 | a cada 2 min | 15 | Canais + base legal + pontuação |
| Preparar novos contatos | 11:00–11:59 | a cada 2 min | 10 | Gera as mensagens (rascunhos) |
| Executar prospecção | 13:00–13:59 | a cada 1 min | 1 | Envia (ou simula) dentro dos limites |
| Verificar respostas | 08:00–19:00 | a cada 15 min | 10 | Lê o Gmail, classifica, descadastra, responde se autorizado |
| Follow-ups | 15:00–15:59 | a cada 1 min | 1 | Retoma quem não respondeu |
| Relatórios e limpeza | a partir de 17:00 | 1×/dia | — | Limpa dados vencidos, e-mail de alertas para você |

### Como configurar um horário

Em **Automação → Rotina**, cada tarefa tem:

- **Dias**: toque nos dias para ligar/desligar.
- **Início / Fim**: janela em que a tarefa pode rodar. Sem "Fim" = uma vez por dia a partir do início.
- **A cada (min)**: `0` = uma vez por dia; `5` = a cada 5 min dentro da janela.
- **Lote**: quantos itens por execução. Mantenha baixo no plano gratuito (10 ms de CPU por execução).
- **Salvar**. **Rodar agora** executa uma vez na hora, fora do horário.

Recuperação automática: se a tarefa diária não rodou no horário (ex.: instabilidade), ela roda no próximo ciclo do mesmo dia. Tarefas interrompidas no meio voltam para a fila em até 10 minutos.

Os **horários de envio** (quando e-mails podem sair) ficam em **Configurações → Envio de e-mails**: dias, início e fim. Mesmo que a tarefa "Executar prospecção" rode fora disso, nada é enviado fora dessa janela.

## Alvos de descoberta

Em **Automação → Alvos de descoberta automática → Adicionar alvo**: UF, cidade, segmento, tipo (tag OSM opcional, ex. `office=lawyer`), palavras-chave e máximo de resultados. A tarefa percorre os alvos em rodízio. Para uma busca na hora: **Empresas → Descobrir**.

O segmento **Descoberta automática** pega qualquer escritório/ofício com site e nomeia o segmento pela própria categoria encontrada (ex.: `insurance`), revelando segmentos novos.

## Ativar a primeira campanha real

O sistema começa em **modo simulação**: tudo roda, as mensagens são escritas e registradas como "Simulado", mas nada é enviado.

1. Preencha **Configurações → Remetente** (nome, empresa, e-mail = conta Google).
2. Conecte o Google e clique **Testar conexão** ([CONFIGURACAO-GOOGLE.md](CONFIGURACAO-GOOGLE.md)).
3. Cadastre 1–2 alvos e deixe a rotina rodar um dia, ou use **Rodar agora** em cada tarefa, na ordem.
4. Em **Conversas → Rascunhos/Todas**, leia as mensagens simuladas. Confira nome da empresa, observações e tom. Cancele qualquer uma que não estiver boa.
5. Em **Empresas → Em revisão**, decida as empresas em dúvida (libere só se não for saúde nem concorrente da Arco).
6. Ajuste **Limite diário** (comece com 5–10), **Por segmento**, **Intervalo** (10+ min) e a janela de envio.
7. Em **Configurações → Envio de e-mails**, digite `ATIVAR` e confirme. O sistema recusa se faltar algum dos itens acima.
8. Acompanhe em **Início** e **Conversas**. Para voltar atrás: **Voltar para simulação**, **Pausar** ou **Pausa emergencial** (Automação).

### Respostas automáticas (Closer)

Desligadas por padrão. Em **Configurações → Respostas automáticas**, ligue só os casos que quiser. Quando ligado, o Closer responde **apenas** mensagens classificadas com segurança como pedido de reunião, resposta positiva ou pedido de informações, com o link da sua agenda e três perguntas de qualificação, sem preços. Depois da primeira resposta automática, qualquer nova mensagem daquela conversa vai para você.

## Rotina sugerida para você

- **Diariamente (2 min)**: abra **Início**. Se houver "itens aguardando revisão", abra **Conversas → Revisão** e responda/classifique.
- **Semanalmente**: **Empresas → Em revisão**; **Automação → Erros e alertas**; **Uso e limites**.
- **Pausa emergencial**: Automação → botão vermelho. Para tudo, inclusive a fila. Para retomar: **Liberar sistema**.

## Manutenção

- **Lista de exclusão** (Mais → Lista de exclusão): adicione palavras, categorias OSM, CNAEs, domínios ou concorrentes. A regra nova é reaplicada às empresas ainda não contatadas. Regras do sistema não podem ser apagadas, só desativadas — evite desativar.
- **Limites** (Configurações → Limites diários): ficam abaixo das cotas gratuitas de propósito. Ao atingir um, só a tarefa afetada pausa até 00:00 UTC (21:00 em Brasília) e um alerta aparece.
- **Google "Acesso expirado"**: reconecte em Configurações (ver nota sobre status "Teste").
- **Fonte Overpass lenta**: o servidor público às vezes demora ~1 min ou recusa (HTTP 429/504); o sistema tenta de novo depois. Se ficar ruim por dias, troque `finder.overpass_url` por outra instância pública (ex.: `https://overpass.kumi.systems/api/interpreter`) — por ora isso é feito no banco: `UPDATE settings SET value = json_set(value, '$.overpass_url', 'URL') WHERE key = 'finder'`.
- **Novas regras padrão**: ao mudar a lista em `src/defaults.js`, suba `SEED_VERSION`; as regras novas entram no próximo ciclo sem duplicar.
- **Logs** completos do Worker: Cloudflare Dashboard → Workers & Pages → `aureon-sales-engine` → **Logs** (observability ligada no `wrangler.jsonc`).
