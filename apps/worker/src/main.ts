import { createAnthropicLlm, isPermanentLlmError } from "@proximo/agent";
import { parseEncryptionKey } from "@proximo/core";
import { createDb } from "@proximo/db";
import {
  createQueues,
  createRedis,
  enqueueOutbound,
  type InboundJob,
  inboundJobSchema,
  type OutboundJob,
  outboundJobSchema,
  QUEUE_NAMES,
  type ReminderJob,
  reminderJobSchema,
  scheduleReminderScan,
} from "@proximo/queue";
import { DelayedError, UnrecoverableError, Worker } from "bullmq";
import { pino } from "pino";
import { ChannelRegistry } from "./channels";
import { loadWorkerEnv } from "./env";
import {
  ConversationBusyError,
  giveUpInbound,
  handleInbound,
  schedulingProviderFor,
  type WorkerDeps,
} from "./inbound";
import { handleOutbound } from "./outbound";
import {
  REMINDER_SCAN_EVERY_MS,
  type ReminderDeps,
  scanReminders,
  sendReminderNow,
} from "./reminders";

const env = loadWorkerEnv();
const logger = pino({
  level: env.LOG_LEVEL,
  ...(env.NODE_ENV === "development"
    ? {
        transport: {
          target: "pino-pretty",
          options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" },
        },
      }
    : {}),
});

const encryptionKey = env.ENCRYPTION_KEY ? parseEncryptionKey(env.ENCRYPTION_KEY) : undefined;
const db = createDb(env.DATABASE_URL);
const redis = createRedis(env.REDIS_URL);
const queues = createQueues(redis);

if (!env.ANTHROPIC_API_KEY) {
  logger.warn("ANTHROPIC_API_KEY vazia: o SDK vai procurar um perfil do 'ant auth login'.");
}

const deps: WorkerDeps = {
  db,
  redis,
  llm: createAnthropicLlm(env.ANTHROPIC_API_KEY ? { apiKey: env.ANTHROPIC_API_KEY } : {}),
  agentConfig: {
    model: env.ANTHROPIC_MODEL,
    effort: env.ANTHROPIC_EFFORT,
    maxTokens: env.ANTHROPIC_MAX_TOKENS,
    fallbacks: env.ANTHROPIC_FALLBACKS,
    prefixMismatch: env.ANTHROPIC_PREFIX_MISMATCH,
    maxRequestsPerTurn: 8,
  },
  channels: new ChannelRegistry({
    graphApiVersion: env.WHATSAPP_GRAPH_API_VERSION,
    ...(encryptionKey ? { encryptionKey } : {}),
  }),
  enqueueOutbound: (job) => enqueueOutbound(queues.outbound, job),
  ...(encryptionKey ? { encryptionKey } : {}),
  settings: {
    sessionIdleHours: env.AGENT_SESSION_IDLE_HOURS,
    humanModeHours: env.AGENT_HUMAN_MODE_HOURS,
    maxRunsPerCustomerPerDay: env.AGENT_MAX_RUNS_PER_CUSTOMER_PER_DAY,
    maxSessionMessages: 80,
  },
  now: () => new Date(),
  logger,
};

const inboundWorker = new Worker<InboundJob>(
  QUEUE_NAMES.inbound,
  async (job, token) => {
    try {
      return await handleInbound(inboundJobSchema.parse(job.data), deps);
    } catch (error) {
      if (error instanceof ConversationBusyError) {
        // Outro job está com a conversa: volta para a fila sem gastar tentativa.
        await job.moveToDelayed(Date.now() + 1_500, token);
        throw new DelayedError();
      }
      if (isPermanentLlmError(error)) {
        // Tentar de novo não resolve: falha já, avisa o cliente e chama a equipe.
        throw new UnrecoverableError(error instanceof Error ? error.message : String(error));
      }
      throw error;
    }
  },
  { connection: createRedis(env.REDIS_URL), concurrency: env.WORKER_CONCURRENCY },
);

const outboundWorker = new Worker<OutboundJob>(
  QUEUE_NAMES.outbound,
  async (job) => handleOutbound(outboundJobSchema.parse(job.data), deps),
  { connection: createRedis(env.REDIS_URL), concurrency: env.WORKER_CONCURRENCY * 2 },
);

const reminderDeps: ReminderDeps = {
  db,
  enqueueOutbound: deps.enqueueOutbound,
  providerFor: (business) => schedulingProviderFor(deps, business),
  now: deps.now,
  logger,
};

const remindersWorker = new Worker<ReminderJob>(
  QUEUE_NAMES.reminders,
  async (job) => {
    const data = reminderJobSchema.parse(job.data);
    if (data.type === "scan") {
      const result = await scanReminders(reminderDeps);
      if (result.queued || result.skipped || result.requeued || result.failedBusinesses) {
        logger.info(result, "varredura de lembretes");
      }
      return result;
    }
    const outcome = await sendReminderNow(reminderDeps, data);
    logger.info({ businessId: data.businessId, kind: data.kind, outcome }, "lembrete avulso");
    return outcome;
  },
  { connection: createRedis(env.REDIS_URL), concurrency: 1 },
);

inboundWorker.on("failed", (job, error) => {
  logger.error(
    { jobId: job?.id, attempts: job?.attemptsMade, error: error.message },
    "falha ao processar mensagem",
  );
  const lastAttempt = job && job.attemptsMade >= (job.opts.attempts ?? 1);
  if (
    job &&
    (lastAttempt || error instanceof UnrecoverableError || error.name === "UnrecoverableError")
  ) {
    giveUpInbound(job.data, deps).catch((giveUpError: unknown) => {
      logger.error({ error: String(giveUpError) }, "falha ao avisar o cliente sobre o erro");
    });
  }
});
outboundWorker.on("failed", (job, error) => {
  logger.error(
    { jobId: job?.id, attempts: job?.attemptsMade, error: error.message },
    "falha ao enviar mensagem",
  );
});
remindersWorker.on("failed", (job, error) => {
  logger.error({ jobId: job?.id, error: error.message }, "falha nos lembretes");
});

await scheduleReminderScan(queues.reminders, REMINDER_SCAN_EVERY_MS);

logger.info({ model: env.ANTHROPIC_MODEL, effort: env.ANTHROPIC_EFFORT }, "worker no ar");

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "encerrando o worker");
  await Promise.all([inboundWorker.close(), outboundWorker.close(), remindersWorker.close()]);
  await queues.close();
  await redis.quit();
  await db.$disconnect();
  process.exit(0);
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
