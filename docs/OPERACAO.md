# Operação: horários, primeira campanha, rotina e manutenção

## Sua rotina de 10 minutos (tela Hoje)

A primeira aba do app é **Hoje**: a lista do dia, montada às 06:30, com no máximo 12 cartões (ajustável em Configurações → Rotina diária). Às 06:30 também sai um e-mail para você com o resumo e o link. Abra no celular antes do trabalho e resolva de cima para baixo:

| Cartão | O que é | O que você faz |
|---|---|---|
| **Responder agora** | alguém respondeu o e-mail | "Enviar horários" (manda 3 horários livres + link da agenda), "Pedir telefone" ou "Responder". Você revisa o texto antes de enviar |
| **Quentes** | a empresa abriu a sua análise nas últimas 48 h | toque em WhatsApp/Instagram/Ligar: abre com a mensagem pronta |
| **Reuniões de hoje** | reunião marcada hoje | lembrete pronto no WhatsApp (o e-mail de lembrete sai sozinho 24 h e 1 h antes) |
| **Toques do dia** | próximo passo da sequência | WhatsApp, Instagram ou ligação com texto/roteiro pronto |
| **Decidir rápido** | empresa em dúvida na lista de exclusão | Liberar ou Bloquear |

Botões de cada cartão: **Feito** (registra o contato e agenda o próximo passo), **Amanhã** (adia), **Pular** (encerra os toques manuais dessa empresa) e **Não contatar** (tira a empresa de todos os canais para sempre).

- **WhatsApp** abre a conversa da empresa com o texto preenchido (link oficial `wa.me`); você só toca em enviar.
- **Instagram**: o texto é copiado e a DM da empresa abre (`ig.me`); cole e envie.
- **Ligar** abre o discador e mostra um roteiro de 30 segundos.
- Nada sai por WhatsApp ou Instagram sem você: as regras da Meta não permitem mensagem automática a frio, e um robô arriscaria bloquear o seu perfil.

### A sequência completa de cada empresa

| Dia | Com e-mail publicado | Só com WhatsApp/Instagram/telefone |
|---|---|---|
| 0 | E-mail automático com a observação e o link da análise | Cartão: primeira mensagem (WhatsApp → Instagram → ligação) |
| 2 | Cartão: Instagram ou WhatsApp | — |
| 4 | E-mail automático: novo ponto + link da agenda | Cartão: segundo toque em outro canal |
| 6 | Cartão: WhatsApp ou ligação | — |
| 9 | — | Cartão: ligação ou WhatsApp |
| 12 | E-mail automático de encerramento | — |
| 19 | Sem resposta → Perdido | — |

Quem responde, abre a análise ou marca reunião sai da sequência e vai para o cartão certo. Os dias são editáveis em Configurações (e-mails) e em `planner` no banco (toques manuais).

### A mini-auditoria

Cada empresa ganha uma página pública (`/analise/...`) com o que foi observado no site, por que importa e os botões "Escolher um horário", "Falar no WhatsApp" (o seu telefone do remetente) e "Responder por e-mail". O link vai no primeiro e-mail e nas mensagens manuais. Quando a empresa abre (e fica 4 segundos na página), ela vira cartão **Quente**. Suas próprias visitas, logado no painel, não contam. Em **Empresas → Contatos** você vê quantas vezes ela foi aberta e pode copiar o link.

### E-mail do responsável

O sistema agora lê também as páginas de contato, sobre e equipe do site. Com **Configurações → Envio → "Usar e-mail nominal publicado pela própria empresa"** ligado, um endereço como `joao@empresa.com.br` encontrado no site da própria empresa passa a ser usado (e tem prioridade sobre `contato@`), com a saudação pelo nome quando o nome aparece escrito na página. Vem desligado; ligue se concordar com a base legal descrita em [ARQUITETURA.md](ARQUITETURA.md).

## Rotina padrão (editável em Mais → Automação)

Todos os horários estão no fuso `America/Sao_Paulo`, de segunda a sexta.

| Tarefa | Janela | Frequência | Lote | O que faz |
|---|---|---|---|---|
| Descobrir novas empresas | 08:00–08:59 | a cada 10 min | 1 alvo | Consulta o OpenStreetMap para o próximo alvo cadastrado |
| Montar a rotina do dia | a partir de 06:30 | 1×/dia | — | Monta a tela Hoje e manda o e-mail da manhã |
| Investigar empresas | 09:00–10:29 | a cada 1 min | 1 site | Lê robots.txt, a página inicial e até 2 páginas de contato/equipe |
| Encontrar contatos e classificar | 10:30–10:59 | a cada 2 min | 15 | Canais (e-mail, WhatsApp, Instagram, telefone) + base legal + pontuação |
| Preparar novos contatos | 11:00–11:59 | a cada 2 min | 10 | Gera as mensagens (rascunhos) |
| Executar prospecção | 13:00–13:59 | a cada 1 min | 1 | Envia (ou simula) dentro dos limites |
| Verificar respostas | 08:00–19:00 | a cada 15 min | 10 | Lê o Gmail, classifica, descadastra, responde se autorizado |
| Sequência de e-mails | 15:00–15:59 | a cada 1 min | 1 | 2º e-mail (dia 4) e encerramento (dia 12) para quem não respondeu |
| Lembretes de reunião | 06:00–22:00, todos os dias | a cada 15 min | — | E-mail 24 h e 1 h antes de cada reunião |
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

- **Diariamente (10 min)**: abra **Hoje** no celular e resolva os cartões.
- **Semanalmente**: **Empresas → Em revisão**; **Automação → Erros e alertas**; **Uso e limites**.
- **Pausa emergencial**: Automação → botão vermelho. Para tudo, inclusive a fila. Para retomar: **Liberar sistema**.

## Manutenção

- **Lista de exclusão** (Mais → Lista de exclusão): adicione palavras, categorias OSM, CNAEs, domínios ou concorrentes. A regra nova é reaplicada às empresas ainda não contatadas. Regras do sistema não podem ser apagadas, só desativadas — evite desativar.
- **Limites** (Configurações → Limites diários): ficam abaixo das cotas gratuitas de propósito. Ao atingir um, só a tarefa afetada pausa até 00:00 UTC (21:00 em Brasília) e um alerta aparece.
- **Google "Acesso expirado"**: reconecte em Configurações (ver nota sobre status "Teste").
- **Fonte Overpass lenta**: o servidor público às vezes demora ~1 min ou recusa (HTTP 429/504); o sistema tenta de novo depois. Se ficar ruim por dias, troque `finder.overpass_url` por outra instância pública (ex.: `https://overpass.kumi.systems/api/interpreter`) — por ora isso é feito no banco: `UPDATE settings SET value = json_set(value, '$.overpass_url', 'URL') WHERE key = 'finder'`.
- **Novas regras padrão**: ao mudar a lista em `src/defaults.js`, suba `SEED_VERSION`; as regras novas entram no próximo ciclo sem duplicar.
- **Logs** completos do Worker: Cloudflare Dashboard → Workers & Pages → `aureon-sales-engine` → **Logs** (observability ligada no `wrangler.jsonc`).
