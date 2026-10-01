# Próximo

Assistente de IA no WhatsApp que agenda horários para negócios com hora marcada: barbearias,
salões, estética, estúdios de tatuagem, pet shops e clínicas. O cliente conversa com o agente,
que consulta a agenda de verdade, propõe um horário, espera a confirmação e só então grava.

Estado atual: etapa 2 do roadmap concluída. Veja [docs/architecture.md](docs/architecture.md).

- Fluxo mínimo de ponta a ponta: mensagem chega, o agente entende, consulta horários, agenda e responde.
- Remarcação, cancelamento e passagem para a equipe.
- Simulador de conversa no navegador, que usa o mesmo caminho das mensagens do WhatsApp.

## Pré-requisitos

| Ferramenta | Versão | Observação |
|---|---|---|
| pnpm | 12 | Instala tudo e baixa o Node 24 do projeto sozinho |
| Docker Desktop | recente | Sobe Postgres e Redis |
| Node.js | qualquer | O pnpm usa o Node 24.21 fixado no projeto, sem mexer no Node do sistema |

O Node do sistema não importa: `devEngines.runtime` no `package.json` faz o pnpm baixar e usar o
Node 24 em todos os scripts. Para o comando `node` puro também usar essa versão, rode
`pnpm shim add node` uma vez.

## Primeiros passos

```bash
# 1. Dependências
pnpm install

# 2. Variáveis de ambiente
cp .env.example .env
pnpm keygen            # copie o resultado para ENCRYPTION_KEY no .env
# Preencha ANTHROPIC_API_KEY no .env

# 3. Postgres e Redis
pnpm services:up

# 4. Banco: migrations e barbearia de exemplo
pnpm db:migrate
pnpm db:seed

# 5. API, worker e painel juntos
pnpm dev
```

Com tudo no ar:

| Serviço | Endereço |
|---|---|
| Painel e simulador | http://localhost:3000/simulador |
| API | http://localhost:3001 |
| Prisma Studio | `pnpm db:studio` |

## Testar pelo simulador

Abra http://localhost:3000/simulador e converse como se fosse um cliente, por exemplo:
"oi, queria cortar o cabelo quinta à tarde". A resposta leva alguns segundos: o worker espera
um instante para juntar mensagens picadas antes de chamar o agente.

A lateral mostra os agendamentos do cliente simulado. "Recomeçar do zero" apaga o cliente e os
agendamentos dele.

Sem `ANTHROPIC_API_KEY`, o agente não roda. O cliente recebe um aviso de falha técnica e a
conversa passa para a equipe. É o comportamento esperado quando a API do Claude falha.

## Conectar o número de teste da Meta

1. No [painel de desenvolvedores da Meta](https://developers.facebook.com), crie um app com o
   caso de uso do WhatsApp. A Meta fornece um número de teste.
2. Na configuração da API do WhatsApp, copie o Phone number ID e gere um token de acesso temporário.
3. Preencha `WHATSAPP_TEST_PHONE_NUMBER_ID`, `WHATSAPP_TEST_ACCESS_TOKEN` e, se quiser,
   `WHATSAPP_TEST_WABA_ID` no `.env`, e rode `pnpm db:seed` de novo.
4. Nas configurações básicas do app, copie o App secret para `WHATSAPP_APP_SECRET`.
5. Invente um token e coloque em `WHATSAPP_VERIFY_TOKEN`.
6. Exponha a API com um túnel HTTPS, por exemplo `cloudflared tunnel --url http://localhost:3001`.
7. Na configuração de webhooks do WhatsApp, cadastre `https://<seu-túnel>/webhooks/whatsapp` com o
   mesmo verify token e assine o campo `messages`.
8. Cadastre seu celular como destinatário de teste e mande uma mensagem para o número de teste.

O token temporário da Meta expira em 24 horas. Para produção, cada negócio conecta o próprio
número por Embedded Signup, o que exige o Próximo como Tech Provider da Meta.

## Comandos

| Comando | O que faz |
|---|---|
| `pnpm dev` | Sobe API, worker e painel com recarga automática |
| `pnpm test` | Roda todos os testes, em série por causa do banco de teste |
| `pnpm typecheck` | Checa os tipos de todos os pacotes |
| `pnpm lint` | Lint e formatação com Biome |
| `pnpm format` | Corrige formatação e o que o Biome souber corrigir |
| `pnpm build` | Build de produção do painel |
| `pnpm services:up` / `services:down` | Sobe ou derruba Postgres e Redis |
| `pnpm db:migrate` | Cria e aplica migrations em desenvolvimento |
| `pnpm db:deploy` | Aplica migrations pendentes, sem criar novas |
| `pnpm db:seed` | Cria a barbearia de exemplo |
| `pnpm db:studio` | Abre o Prisma Studio |
| `pnpm keygen` | Gera uma ENCRYPTION_KEY |

Os testes de integração usam o banco `proximo_test`, criado pelo docker-compose, e o Redis local.
Suba os serviços antes de `pnpm test`.

## Estrutura

```
apps/
  api/          Fastify: webhook do WhatsApp e rotas do simulador
  worker/       BullMQ: roda o agente e envia as respostas
  web/          Next.js + Tailwind: painel, por enquanto só o simulador
packages/
  core/         Tipos de domínio, segmentos, telefone, datas, cifra de segredos
  db/           Schema Prisma, migrations, escopo de tenant, seed
  scheduling/   SchedulingProvider, agenda própria, stub do AppBarber, suíte de contrato
  agent/        Loop com o Claude, prompts, ferramentas, sessões
  messaging/    Interface de canal, WhatsApp Cloud API, simulador
  queue/        Filas, formatos dos jobs, trava por conversa
docs/           Arquitetura e decisões
```

## Variáveis de ambiente

Todas estão no [.env.example](.env.example), com comentários. As principais:

| Variável | Para quê |
|---|---|
| `ANTHROPIC_API_KEY` | Chave da API do Claude |
| `ANTHROPIC_MODEL` | Modelo do agente. Padrão `claude-sonnet-5-5`; alternativa mais barata: `claude-haiku-4-5` |
| `ANTHROPIC_EFFORT` | Esforço de raciocínio: `low`, `medium` ou `high` |
| `ENCRYPTION_KEY` | Cifra tokens e credenciais guardados no banco |
| `WHATSAPP_APP_SECRET` | Valida a assinatura dos webhooks da Meta |
| `WHATSAPP_VERIFY_TOKEN` | Token da verificação do webhook |
| `SIMULATOR_ENABLED` | Liga as rotas do simulador. Deixe `false` em produção |

## Problemas comuns

- **`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`**: o pnpm 12 recusa versões publicadas há menos de
  um dia. Espere um dia ou fixe a versão anterior no catálogo do `pnpm-workspace.yaml`.
- **`ERR_PNPM_IGNORED_BUILDS`**: um pacote novo quer rodar script de instalação. Avalie e libere
  com `pnpm approve-builds <pacote>`.
- **Testes falham com erro de conexão**: suba os serviços com `pnpm services:up`.
- **Porta 5432 ou 6379 ocupada**: defina `POSTGRES_PORT` ou `REDIS_PORT` antes do
  `pnpm services:up` e ajuste as URLs no `.env`.
