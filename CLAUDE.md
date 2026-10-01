# CLAUDE.md

Guia para quem trabalha neste repositório, pessoa ou agente. Arquitetura e decisões completas em
[docs/architecture.md](docs/architecture.md).

## O que é

Próximo: SaaS multi-tenant de agendamento por WhatsApp com um agente Claude. Primeiro nicho:
barbearias do RS, mas o produto serve qualquer negócio com hora marcada.

## Comandos

```bash
pnpm services:up      # Postgres e Redis no Docker; necessário para testes e dev
pnpm dev              # API :3001, worker e painel :3000
pnpm test             # todos os testes, em série
pnpm typecheck
pnpm lint             # Biome; pnpm format corrige
pnpm db:migrate       # nova migration em desenvolvimento
```

Rode `pnpm lint`, `pnpm typecheck` e `pnpm test` antes de considerar uma mudança pronta.

## Regras que não se quebram

**Vocabulário neutro.** No código e no banco: business, professional, service, appointment,
customer. Nunca "barber". O que muda por segmento vem de `getSegmentProfile` em `@proximo/core`:
rótulos, tom do agente, regras extras e serviços sugeridos.

**Idiomas.** Código, nomes de tabela e commits em inglês. Textos para o cliente final, prompts do
agente, mensagens de erro de domínio e documentação em português do Brasil.

**Multi-tenant.**
- Toda tabela de tenant tem `businessId`. No código de negócio, use `scopeToBusiness(db, businessId)`.
- Relações obrigatórias entre tabelas de tenant usam chave estrangeira composta `(businessId, id)`.
- O tenant vem do canal, pelo `phone_number_id` do webhook, ou da sessão do painel. Nunca do corpo
  da requisição.

**Agenda só pelo `SchedulingProvider`.** Agente, painel e lembretes não leem appointments direto do
banco. Todo provider novo precisa passar em `describeSchedulingProviderContract`, de
`@proximo/scheduling/testing`. O provider do AppBarber é stub: não há API pública, e os termos de
uso proíbem engenharia reversa e captura de dados.

**Agente.**
- O histórico enviado ao Claude só cresce. Nunca edite nem apague itens de `AgentSession.transcript`.
  A coluna é `json`, não `jsonb`, para preservar a ordem das chaves.
- O prompt de sistema e as ferramentas são congelados por sessão e precisam ser determinísticos:
  nada de data, hora ou dado do cliente neles. O contexto do turno vai numa mensagem de sistema
  depois da fala do cliente.
- Se o prompt, as ferramentas ou o modelo mudarem, `agentVersion` muda e o worker abre uma sessão
  nova com resumo. Não é preciso migrar sessões antigas.
- Regras críticas moram no código das ferramentas, não só no prompt: horário revalidado na agenda,
  proposta antes de gravar, confirmação só em turno posterior, cliente só mexe no que é dele.
- IDs de modelo exatos, sem sufixo de data. Capacidades por modelo ficam em
  `packages/agent/src/config.ts`. No Sonnet 5.5, `tool_choice` forçado e thinking desligado
  retornam 400.

**LGPD.**
- Nunca registre em log corpo de mensagem, telefone, nome ou token.
- Não guarde mídia nem o payload bruto do webhook. Do cliente, só identidade do WhatsApp, telefone e
  o nome que ele informar.
- Segredos no banco sempre cifrados com `encryptSecret` ou `encryptJson`.

**WhatsApp.**
- Responda sempre ao `wa_id` exatamente como a Meta enviou. Números antigos do RS vêm sem o nono
  dígito, e o formato errado é aceito pela Meta sem ser entregue.
- `waUserId`, o BSUID, é a chave durável do cliente; o telefone pode faltar.
- `normalizePhoneE164` serve para busca e exibição, não para envio.

## Banco e migrations

- Tabelas e colunas em snake_case com `@map` e `@@map`; datas em `@db.Timestamptz(3)`.
- O que o Prisma não expressa vai em SQL escrito à mão: exclusion constraint contra horário
  sobreposto e checks. Crie com `pnpm --filter @proximo/db exec prisma migrate dev --create-only
  --name <nome>`, edite o SQL e aplique com `pnpm db:migrate`.
- Nunca edite uma migration que já foi aplicada em algum ambiente.

## Testes

- Vitest em todos os pacotes. Testes com banco usam `proximo_test`, por `@proximo/db/testing`, com
  `resetTestDatabase` no começo de cada teste e `fileParallelism: false`.
- O agente é testado sem rede, com `ScriptedLlm` de `@proximo/agent/testing` e o provider em
  memória.
- Relógio fixo nos testes de agenda: `CONTRACT_NOW`, terça 29/09/2026 às 08:00 de Brasília.

## Dependências e ambiente

- Versões no catálogo do `pnpm-workspace.yaml`; nos `package.json`, use `"catalog:"`.
- O pnpm 12 recusa versões com menos de um dia de publicação. Não crie exceções: fixe a versão
  anterior.
- Scripts de instalação só com aprovação em `allowBuilds`.
- TypeScript 6, não 7: o Next.js depende da API JavaScript do compilador.
- Node 24 vem do `devEngines.runtime`: rode tudo via pnpm.
- Pacotes do workspace exportam TypeScript direto de `src`; API e worker rodam com `tsx`.
  O painel não importa pacotes de servidor: ele fala com a API por `/api/*`.
- No Windows, grave arquivos com LF. O Biome acusa CRLF; `pnpm format` corrige.
