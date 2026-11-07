# Testes

## Automatizados — `npm test` (54 testes, todos passando em 07/11/2026)

Rodam dentro do runtime real dos Workers (workerd/Miniflare) com D1 local e as migrations aplicadas. As APIs externas são substituídas por um `fetch` falso que devolve respostas no formato real (Overpass, sites, Gmail, Calendar).

| Pedido (item 18) | Coberto por |
|---|---|
| 1. Cadastro e autenticação | setup só uma vez, código errado, login, cookie HttpOnly, CSRF, limite de tentativas, senha fraca |
| 2–3. Pesquisa e coleta | consulta Overpass por UF/cidade, conversão OSM, origem registrada, importação manual |
| 4. Filtro de saúde | nomes, categorias OSM, CNAE; dentista e clínica bloqueados e sites nunca visitados |
| 5. Filtro de concorrentes | Feegow/Clinicorp/arco.ag bloqueados; "Arco Construções", software e beleza em revisão |
| 6. Análise de sites | HTMLRewriter real: viewport, formulário, mailto, WhatsApp, ferramentas, CNPJ, copyright; robots.txt |
| 7. Classificação | faixas, explicação por critério, soma = nota, revisão nunca automática, serviços desativados |
| 8. Duplicidade | descoberta repetida, envio repetido, inbox repetido, jobs com chave única |
| 9. Mensagens | nome da empresa, finalidade comercial, descadastro, sem preço/promessa/relacionamento falso, curta |
| 10. Envio | modo real com Gmail simulado: MIME, `List-Unsubscribe`, fio salvo; simulação não chama o Gmail |
| 11. Recebimento | só guarda respostas de conversas do sistema; e-mail pessoal ignorado |
| 12. Descadastramento | por resposta e por link; supressão; follow-up e resposta manual bloqueados depois |
| 13. Agendamento | link do Closer → horários (freeBusy) → reserva → evento relido → confirmação → cancelamento; evento "fantasma" não confirma |
| 14. Cron | `scheduled()` real: tarefa diária roda uma vez; recuperação de atraso |
| 15. Pausa emergencial | nada roda, fila cancelada, "rodar agora" recusado; pausa normal mantém só leitura |
| 16. Recuperação | job "rodando" travado e empresa "investigando" voltam à fila |
| 17. Dashboard | números do banco após o fluxo |
| Limites | limite atingido pausa só a tarefa afetada e gera alerta |
| Janela de envio | fora do horário configurado não envia |
| Vigia | `/api/health` aponta Cron parado, Google expirado e pausa emergencial, sem expor dados |

## Ponta a ponta com dados reais — `node scripts/smoke.mjs`

Executado contra o Worker local (`wrangler dev`) em 07/11/2026:

- OpenStreetMap real: 6 construtoras de Joinville/SC descobertas (Civilcon, Okasa, Daxo, CR Fernandes…).
- Sites reais visitados respeitando robots.txt, com achados e evidências; 6 pontuadas.
- 1 mensagem preparada para um e-mail institucional publicado no site e **simulada** (nada enviado).
- O envio foi barrado por estar fora da janela (sábado à noite) até a janela ser aberta só para o teste.
- Pausa emergencial bloqueou a execução manual.
- Dois problemas reais encontrados e corrigidos nesse teste: consulta Overpass pesada demais (estourava o tempo do servidor) e termos de dúvida no texto do site de construtoras ("academia do condomínio", "salão de festas") mandando empresas boas para revisão.

## Painel

Verificado no navegador embutido (lendo a página e o console, sem capturas de tela): login, as 10 telas, detalhe da empresa com abas, busca; nenhum erro de JavaScript; em 375 px (iPhone) nenhuma tela tem rolagem horizontal e a barra inferior aparece.

## Ainda não testado (depende das suas contas)

- Envio e leitura com a **sua conta Gmail real** e reunião criada na **sua Agenda real** — o código usa os endpoints oficiais e foi testado com respostas no formato real, mas só a sua conexão confirma.
- **Deploy na Cloudflare** e o Cron disparando sozinho na nuvem (localmente o gatilho foi disparado pelo endpoint de teste do wrangler).
- **CPU de 10 ms** do plano gratuito em produção: o trabalho foi dividido em lotes pequenos para caber, mas só a medição na nuvem confirma (Dashboard → Worker → Metrics → CPU time). Se aparecer erro 1102 (CPU), reduza o lote do Investigator para 1.
- PageSpeed Insights (desligado por padrão).
- Instalação como app no iPhone real (Safari → Adicionar à Tela de Início).
