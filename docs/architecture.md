# Arquitetura do Próximo

Plano aprovado em 30/09/2026, atualizado com o que mudou durante a implementação.

## Visão geral

O Próximo atende clientes de negócios com hora marcada pelo WhatsApp. Um agente Claude conversa
com o cliente, consulta a agenda, propõe um horário, espera a confirmação e grava.

Há dois cenários de agenda, e o agente funciona igual nos dois:

- **Cenário A: agenda no AppBarber.** Depende de API oficial. Em 30/09/2026 não havia API pública,
  e os termos de uso do AppBarber proíbem engenharia reversa e captura de dados, nas cláusulas 9 e
  17. Existe só como stub.
- **Cenário B: agenda própria do Próximo.** Implementado e testado.

Sem API, uma barbearia só adota o Próximo se trocar de sistema, porque duas agendas geram horário
duplicado. A troca é o maior risco: numa entrevista com um barbeiro da região, ele contou que outro
sistema já foi oferecido a eles e não pegou, porque a equipe não se adaptou à interface. Por isso:

- O painel segue o jeito de usar do AppBarber: fluxos, nomes e onde fica cada coisa. A identidade
  visual é do Próximo.
- A fase de troca, com as funções que o dono usa todo dia, vem antes do primeiro cliente real.

## Estrutura

```
apps/
  api/          Fastify: webhook do WhatsApp, rotas do simulador
  worker/       BullMQ: roda o agente, envia respostas
  web/          Next.js + Tailwind: painel; hoje, o simulador
packages/
  core/         tipos de domínio, segmentos, telefone, datas, cifra, env
  db/           schema Prisma, migrations, escopo de tenant, seed, utilitários de teste
  scheduling/   SchedulingProvider, agenda própria, stub do AppBarber, suíte de contrato
  agent/        loop com o Claude, prompt, ferramentas, estado, sessões
  messaging/    MessagingChannel, WhatsApp Cloud API, simulador
  queue/        filas, formatos dos jobs, trava por conversa, contadores
```

## Caminho de uma mensagem

1. A Meta chama `POST /webhooks/whatsapp`. A API confere a assinatura `X-Hub-Signature-256` com o
   app secret e acha o canal pelo `phone_number_id`.
2. A API grava cliente, conversa e mensagem numa transação. O `wamid` é único, então um webhook
   repetido não duplica nada. Em seguida agenda um job com espera curta e responde 200.
3. O worker pega o job. Se chegou mensagem mais nova do mesmo cliente, este job encerra e o da
   última responde tudo junto.
4. O worker trava a conversa no Redis. Se outro job já está com ela, este volta para a fila sem
   gastar tentativa.
5. Se a conversa está com a equipe, o agente fica quieto. Se o cliente mandou só áudio ou imagem,
   o worker pede texto sem chamar o Claude.
6. O worker monta o contexto: catálogo pelo provider, prompt do segmento, sessão ativa. Então roda
   o turno do agente.
7. Tudo é gravado numa transação: histórico da sessão, resposta, estado do agente, custo do turno e
   handoff, se houver. Depois agenda o envio.
8. O job de envio manda a resposta pelo canal da conversa. Erro temporário é tentado de novo; erro
   definitivo fica registrado na mensagem.

O simulador entra no passo 2, pelo mesmo serviço de entrada, com um canal do tipo `simulator`.

## Contrato da agenda

```ts
interface SchedulingProvider {
  readonly kind: "internal" | "appbarber";
  readonly capabilities: { manageCatalog: boolean; sendsOwnReminders: boolean };
  listServices(): Promise<Service[]>;
  listProfessionals(filter?: { serviceId?: string }): Promise<Professional[]>;
  getOpeningHours(): Promise<WeeklyHours>;
  getAvailability(query: AvailabilityQuery): Promise<Slot[]>;
  createAppointment(input: NewAppointment): Promise<Appointment>;
  rescheduleAppointment(id: string, change: { startsAt: Date; professionalId?: string }): Promise<Appointment>;
  cancelAppointment(id: string, reason?: string): Promise<Appointment>;
  getAppointment(id: string): Promise<Appointment | null>;
  findCustomerAppointments(query: CustomerAppointmentsQuery): Promise<Appointment[]>;
  listAppointments(query: AppointmentsRangeQuery): Promise<Appointment[]>;
}
```

- Cada instância pertence a um negócio. A fábrica `createSchedulingProvider` escolhe a implementação
  pelo campo `schedulingProvider` do negócio.
- O motor de disponibilidade é uma função pura, usada pelo provider interno e pelo provider em
  memória dos testes. O que é oferecido é exatamente o que a criação aceita.
- A suíte de contrato roda os mesmos doze testes nos dois providers.

## Modelo de dados

| Tabela | Papel |
|---|---|
| businesses | O tenant: segmento, fuso, provider de agenda, regras de marcação, orientações do agente |
| users, memberships | Login do painel e papel em cada negócio |
| channels | Número de WhatsApp ou simulador; token cifrado |
| professionals, services, professional_services | Catálogo e quem faz o quê, com preço e duração próprios |
| working_hours, schedule_blocks | Horário semanal e bloqueios, do negócio ou do profissional |
| customers | Identidade no WhatsApp, telefone normalizado, nome |
| appointments | Agendamentos, com preço no momento da marcação |
| conversations, messages | Chat com o cliente, modo agente ou equipe, estado do agente |
| agent_sessions, agent_runs | Histórico exato enviado ao Claude e custo de cada turno |
| notifications | Lembretes enviados, sem duplicidade |
| audit_logs | Handoffs, exclusões de dados, mudanças de configuração |

Garantias no banco:

- **Sem horário sobreposto.** Uma exclusion constraint impede dois agendamentos ativos sobrepostos
  do mesmo profissional, venham do agente, do painel ou de importação.
- **Sem cruzar tenants.** As relações obrigatórias usam chave estrangeira composta
  `(business_id, id)`. No código, `scopeToBusiness` injeta o negócio em toda consulta.
- **Datas em UTC.** Horários de funcionamento ficam em minutos no fuso do negócio.

## Agente

**Modelo.** Padrão `claude-sonnet-5-5` com esforço `low`, configurável por variável de ambiente.
Cada modelo tem um perfil do que aceita. No Haiku 4.5, a alternativa mais barata, o agente não manda
esforço nem mensagens de sistema no meio da conversa, e o cache só vale a partir de 4.096 tokens de
prefixo.

| Modelo | Entrada por milhão de tokens | Saída por milhão de tokens |
|---|---|---|
| Sonnet 5.5 | US$ 2 | US$ 10 |
| Haiku 4.5 | US$ 1 | US$ 5 |

**Ferramentas.** `check_availability`, `find_my_appointments`, `propose_appointment`,
`propose_reschedule`, `propose_cancellation`, `confirm_proposal` e `handoff_to_human`. Todas em
modo estrito. Serviços e profissionais aparecem com códigos curtos, como s1 e p1, e os esquemas só
aceitam códigos do catálogo.

**Garantias no código:**
- Um horário só é aceito se a agenda o oferece no momento da proposta e de novo na gravação.
- Nada é gravado sem proposta. A confirmação só vale num turno posterior, ou seja, depois de uma
  mensagem nova do cliente.
- O cliente só lista e altera os próprios agendamentos.
- A confirmação é idempotente: se o worker cair depois de gravar, a nova tentativa não duplica.

**Sessões.** A Anthropic exige, em contas criadas a partir de 31/08/2026, que o histórico reenviado
só cresça. Cada sessão congela modelo, prompt de sistema e ferramentas, e guarda o histórico exato.
Abre-se uma sessão nova quando a configuração muda, depois de horas sem conversa, quando o histórico
fica longo ou quando a equipe devolve a conversa. A sessão nova começa com um resumo: próximos
agendamentos e últimas mensagens.

**Contexto do turno.** Data, hora, calendário de catorze dias com dia da semana, nome do cliente e
proposta pendente vão numa mensagem de sistema depois da fala do cliente. O prompt de sistema fica
estável e em cache.

**Falhas.**
- Recusa do modelo: o turno é descartado e a conversa passa para a equipe. O fallback do servidor
  fica ligado.
- Erro permanente da API, como credencial ausente: falha na primeira tentativa, avisa o cliente e
  chama a equipe.
- Erro temporário: o BullMQ tenta de novo; na última tentativa, o mesmo aviso.
- Limite diário de execuções por cliente contra abuso e custo.

## WhatsApp

- Um app da Meta e um webhook para todos os negócios.
- O cliente é identificado pelo BSUID, campo `user_id` nos webhooks desde abril de 2026. Quem usa
  nome de usuário pode não mandar telefone.
- Respostas vão para o `wa_id` como a Meta enviou, por causa do nono dígito dos números antigos.
- Coexistência: quando a equipe responde pelo app WhatsApp Business, o eco chega por webhook, a
  mensagem entra no histórico e o agente sai da conversa por algumas horas.
- Embedded Signup v4 para conectar o número de cada negócio. A versão 2 é descontinuada em
  15/10/2026. Exige o Próximo como Tech Provider da Meta.

## LGPD

- O negócio é o controlador; o Próximo, operador. Anthropic e Meta são suboperadores com
  transferência internacional, o que precisa constar na política de privacidade.
- Dados mínimos: identidade do WhatsApp, telefone e nome informado. Sem CPF, e-mail ou data de
  nascimento; mídia não é guardada.
- Clientes são anonimizados, não apagados, para os agendamentos continuarem nos relatórios.
- Tokens e credenciais cifrados com AES-256-GCM. Logs sem telefone, nome ou conteúdo.
- Em clínicas, o agente não pergunta sintomas nem motivo da consulta.

## Decisões de stack

| Escolha | Motivo |
|---|---|
| pnpm workspaces + Turborepo | Dependências por pacote e tarefas com cache |
| Node 24 via `devEngines.runtime` | O pnpm baixa a versão certa sem mexer no Node do sistema |
| TypeScript 6 | O TypeScript 7 nativo não expõe a API JavaScript que o Next.js usa |
| Fastify | A regra de negócio mora nos pacotes; a API é fina |
| Prisma 7 com adaptador pg | Versão estável atual; SQL à mão para o que o schema não expressa |
| BullMQ 6 com Redis | Espera, retentativa e reagendamento sem gastar tentativa |
| Luxon | Fusos e dias da semana corretos |
| Zod | Validação de env, rotas e entradas das ferramentas |
| Biome | Lint e formatação numa ferramenta só |

## Mudanças em relação ao plano aprovado

- **Chave do cliente.** A Meta passou a mandar o BSUID e pode omitir o telefone, então o contrato
  busca agendamentos por `findCustomerAppointments`, com ID ou telefone, e não só por telefone.
- **Contrato da agenda.** Ganhou `getOpeningHours` e `getAppointment`, e a consulta de horários
  aceita ignorar o próprio agendamento numa remarcação.
- **Catálogo no prompt.** Serviços e profissionais vão no prompt de sistema, e não em ferramentas de
  listagem. Isso economiza uma ida e volta por conversa, e mudanças no catálogo abrem sessão nova.
- **Login.** As tabelas de usuário e vínculo existem; as de sessão de login entram com o painel.
- **Versões.** O pnpm 12 recusou três pacotes publicados no mesmo dia; ficaram as versões anteriores.
- **Roadmap.** A fase de troca passou para antes do Tech Provider, e o primeiro cliente real só entra
  depois dela. Veio da entrevista com um barbeiro: a dor dele é demorar a responder no WhatsApp, que
  o agente já resolve, e o risco é a troca de sistema.

## Roadmap

1. Concluído: estrutura do monorepo, docker-compose, schema, README, CLAUDE.md, .env.example.
2. Concluído: agente de ponta a ponta, com agendar, remarcar, cancelar e passar para a equipe.
3. Lembretes de 24h e 2h e confirmação de presença, com templates aprovados e botões tratados sem o
   Claude.
4. Painel do dia a dia com login, no jeito de usar do AppBarber: agenda, cadastros, bloqueios,
   conversas, assumir e devolver, e exclusão de dados.
5. Fase de troca: comandas, comissões e vales, caixa, relatórios, lista de espera. O escopo final
   depende de quais funções do AppBarber os barbeiros usam todo dia.
6. Tech Provider e Embedded Signup. A verificação da Meta costuma demorar, então a papelada pode
   começar antes.
7. Crescimento, na ordem que as entrevistas com barbeiros indicarem.

O primeiro cliente real entra depois das etapas 4 a 6.

## Pendências conhecidas

- Avaliar o agente com o modelo real, comparando Sonnet 5.5 e Haiku 4.5 em conversas roteirizadas,
  antes do primeiro cliente.
- As rotas do simulador não têm autenticação: nunca ligar `SIMULATOR_ENABLED` em produção.
- Transcrição de áudio.
- Rotina de retenção que apaga mensagens e sessões antigas.
- API e worker rodam com `tsx`; o empacotamento para produção fica para a etapa de deploy.
