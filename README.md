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

## Conectar o WhatsApp

Um único webhook atende qualquer número: a API acha o canal pelo `phone_number_id` de cada evento.
O seed cria o canal da barbearia de exemplo com os dados de `WHATSAPP_DEMO_*` e grava o token
cifrado. Sem o canal, a API recebe o webhook e descarta o evento.

Há dois caminhos. O número de teste da Meta é rápido e não exige pagamento, mas o token dele vence
em poucas horas. Um número próprio, como um chip pré-pago, tem token permanente.

Para produção, cada negócio conecta o próprio número por Embedded Signup, o que exige o Próximo
como Tech Provider da Meta.

### Configuração comum

1. No [painel de desenvolvedores da Meta](https://developers.facebook.com), crie um app com o
   caso de uso do WhatsApp.
2. Nas configurações básicas do app, copie o App secret para `WHATSAPP_APP_SECRET`.
3. Invente um token e coloque em `WHATSAPP_VERIFY_TOKEN`.
4. Abra o túnel com `pnpm tunnel` (veja [Túnel](#túnel)).
5. Na configuração de webhooks do WhatsApp, cadastre `https://<domínio do ngrok>/webhooks/whatsapp`
   com o mesmo verify token e assine o campo `messages`.

O app também precisa estar inscrito na conta do WhatsApp do número. Sem a inscrição, o webhook
nunca dispara, mesmo verificado e com `messages` assinado, e o painel não mostra isso. Com as
variáveis do `.env` no terminal:

```bash
# lista os apps inscritos; o seu app precisa aparecer
curl "https://graph.facebook.com/v26.0/$WHATSAPP_DEMO_WABA_ID/subscribed_apps" \
  -H "Authorization: Bearer $WHATSAPP_DEMO_ACCESS_TOKEN"
# inscreve o app; basta uma vez por conta
curl -X POST "https://graph.facebook.com/v26.0/$WHATSAPP_DEMO_WABA_ID/subscribed_apps" \
  -H "Authorization: Bearer $WHATSAPP_DEMO_ACCESS_TOKEN"
```

### Número de teste

1. Na Etapa 1 da configuração da API, em **Para → Gerenciar lista de números de telefone**,
   cadastre seu celular e confirme o código que chega no WhatsApp. O número de teste só envia
   para quem está nessa lista.
2. Ainda na Etapa 1, gere o token de acesso e copie o Phone number ID e o ID da conta do WhatsApp.
3. Preencha `WHATSAPP_DEMO_PHONE_NUMBER_ID`, `WHATSAPP_DEMO_ACCESS_TOKEN` e
   `WHATSAPP_DEMO_WABA_ID` no `.env` e rode `pnpm db:seed`.
4. Confira a inscrição do app. Na conta de teste, o painel não inscreveu o app sozinho.
5. Mande uma mensagem do celular para o número de teste.

O token da Etapa 1 vence em poucas horas, não em um dia: nos testes, durou menos de duas. Quando
ele vencer, as mensagens continuam chegando, mas a resposta do agente não sai. Gere outro, atualize
o `.env` e rode `pnpm db:seed` de novo.

### Número próprio

Não ative o WhatsApp no número antes: um número em uso no app precisa ser apagado de lá para
entrar na Cloud API. Se for um chip pré-pago, mantenha a recarga em dia para não perder o número.

1. Na Etapa 2 da configuração da API, clique em **Adicionar número de telefone**. Escolha o
   portfólio empresarial da empresa, crie uma conta do WhatsApp, defina o nome de exibição e
   confirme o número pelo código por SMS. A Etapa 1 continua mostrando só o número de teste; não
   cadastre o número próprio como destinatário lá.
2. Cadastre a forma de pagamento. Só templates são cobrados, como os lembretes; respostas dentro
   da janela de 24 horas, não. Escolha a moeda com cuidado: a Meta não deixa trocar depois.
3. Pule o envio de mensagem da Etapa 2. Ele manda um template, que é cobrado, e não testa o Próximo.
4. Gere o token permanente em [Configurações do negócio](https://business.facebook.com/settings):
   - **Usuários → Usuários do sistema → Adicionar**, com a função **Funcionário**;
   - **Atribuir ativos**: o app e a conta do WhatsApp, os dois com controle total;
   - **Gerar token**: o app, validade **Nunca**, permissões `whatsapp_business_messaging` e
     `whatsapp_business_management`.
5. Em **Contas → Contas do WhatsApp**, a conta mostra o ID. O Phone number ID sai da API, e o
   número precisa aparecer com `"status": "CONNECTED"`:
   ```bash
   curl "https://graph.facebook.com/v26.0/$WHATSAPP_DEMO_WABA_ID/phone_numbers" \
     -H "Authorization: Bearer $WHATSAPP_DEMO_ACCESS_TOKEN"
   ```
6. Preencha `WHATSAPP_DEMO_*` no `.env`, rode `pnpm db:seed` e confira a inscrição do app. No
   número próprio, o painel registrou o número na Cloud API e inscreveu o app sozinho.
7. Mande uma mensagem do celular para o número.

### Túnel

`pnpm tunnel` expõe a API pelo ngrok, no domínio fixo da conta. O domínio não muda entre
execuções, então o webhook é cadastrado na Meta uma vez só. A regra em `ngrok-policy.yml` deixa
passar só `/webhooks/whatsapp`. Sem ela, as rotas do simulador ficariam abertas na internet.

O script lê só o `ngrok.local.yml`, que fica fora do git e guarda o authtoken. Crie uma vez:

```bash
ngrok config add-authtoken <authtoken> --config ngrok.local.yml
```

A conta grátis do ngrok tem um único domínio, e dois projetos não usam o mesmo domínio ao mesmo
tempo. Use uma conta só para o Próximo.

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
| `pnpm tunnel` | Abre o túnel do ngrok para o webhook do WhatsApp |

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
- **Mensagem do celular não chega à API**: confira se o `pnpm tunnel` está aberto (endpoint
  offline no ngrok dá 404) e se o app está inscrito na conta do WhatsApp (veja
  [Configuração comum](#configuração-comum)).
- **Mensagem chega, mas a resposta não**: token vencido ou celular fora da lista de destinatários.
  O worker registra `envio recusado pelo canal` com o código da Meta (190 é token vencido; 131030,
  destinatário fora da lista), e a mensagem enviada guarda o erro na coluna `error`.
