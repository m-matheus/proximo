import { randomUUID } from "node:crypto";
import { type JobsOptions, Queue } from "bullmq";
import { Redis, type RedisOptions } from "ioredis";
import { z } from "zod";

/**
 * Filas e contratos de jobs compartilhados por API (produtora) e worker (consumidor).
 * IDs de job do BullMQ não aceitam ":", por isso usamos "-".
 */

export const QUEUE_NAMES = {
  /** Mensagens de clientes esperando o agente. */
  inbound: "inbound-messages",
  /** Mensagens prontas para enviar pelo canal. */
  outbound: "outbound-messages",
  /** Varredura periódica dos lembretes e envios avulsos pelo simulador. */
  reminders: "reminders",
} as const;

export const inboundJobSchema = z.object({
  businessId: z.string(),
  conversationId: z.string(),
  /** Mensagem que disparou o job. Se chegar outra depois, este job só encerra. */
  messageId: z.string(),
});
export type InboundJob = z.infer<typeof inboundJobSchema>;

export const outboundJobSchema = z.object({
  businessId: z.string(),
  messageId: z.string(),
});
export type OutboundJob = z.infer<typeof outboundJobSchema>;

export const REMINDER_KINDS = ["reminder_24h", "reminder_2h"] as const;
export type ReminderKind = (typeof REMINDER_KINDS)[number];

export const reminderJobSchema = z.discriminatedUnion("type", [
  /** Procura os horários que chegaram na hora do lembrete, em todos os negócios. */
  z.object({ type: z.literal("scan") }),
  /** Manda um lembrete agora, fora da janela. Usado pelo simulador. */
  z.object({
    type: z.literal("send"),
    businessId: z.string(),
    appointmentId: z.string(),
    kind: z.enum(REMINDER_KINDS),
  }),
]);
export type ReminderJob = z.infer<typeof reminderJobSchema>;

/** Conexão Redis no formato que o BullMQ exige para workers. */
export function createRedis(url: string, options: RedisOptions = {}): Redis {
  return new Redis(url, { maxRetriesPerRequest: null, ...options });
}

export interface Queues {
  inbound: Queue<InboundJob>;
  outbound: Queue<OutboundJob>;
  reminders: Queue<ReminderJob>;
  close(): Promise<void>;
}

export function createQueues(connection: Redis): Queues {
  const inbound = new Queue<InboundJob>(QUEUE_NAMES.inbound, { connection });
  const outbound = new Queue<OutboundJob>(QUEUE_NAMES.outbound, { connection });
  const reminders = new Queue<ReminderJob>(QUEUE_NAMES.reminders, { connection });
  return {
    inbound,
    outbound,
    reminders,
    async close() {
      await Promise.all([inbound.close(), outbound.close(), reminders.close()]);
    },
  };
}

const KEEP_COMPLETED: JobsOptions["removeOnComplete"] = { age: 60 * 60, count: 1000 };
const KEEP_FAILED: JobsOptions["removeOnFail"] = { age: 7 * 24 * 60 * 60 };

/**
 * Agenda o processamento de uma mensagem depois de uma espera curta. Se o cliente
 * mandar outra mensagem nesse meio-tempo, o job desta encerra sem fazer nada e o
 * da última responde tudo junto.
 */
export async function enqueueInbound(
  queue: Queue<InboundJob>,
  job: InboundJob,
  delayMs: number,
): Promise<void> {
  await queue.add("inbound", job, {
    jobId: `inbound-${job.messageId}`,
    delay: delayMs,
    attempts: 5,
    backoff: { type: "exponential", delay: 2_000 },
    removeOnComplete: KEEP_COMPLETED,
    removeOnFail: KEEP_FAILED,
  });
}

export async function enqueueOutbound(queue: Queue<OutboundJob>, job: OutboundJob): Promise<void> {
  await queue.add("outbound", job, {
    jobId: `outbound-${job.messageId}`,
    attempts: 8,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: KEEP_COMPLETED,
    removeOnFail: KEEP_FAILED,
  });
}

/**
 * Liga a varredura periódica dos lembretes. Chamar de novo só atualiza o intervalo:
 * o BullMQ guarda um único agendador com este ID, mesmo com vários workers.
 */
export async function scheduleReminderScan(
  queue: Queue<ReminderJob>,
  everyMs: number,
): Promise<void> {
  await queue.upsertJobScheduler(
    "reminder-scan",
    { every: everyMs },
    {
      name: "scan",
      data: { type: "scan" },
      opts: { removeOnComplete: KEEP_COMPLETED, removeOnFail: KEEP_FAILED },
    },
  );
}

/** Pede um lembrete avulso. A tabela de notificações impede o envio duplicado. */
export async function enqueueReminder(
  queue: Queue<ReminderJob>,
  job: Extract<ReminderJob, { type: "send" }>,
): Promise<void> {
  await queue.add("send", job, {
    attempts: 3,
    backoff: { type: "exponential", delay: 2_000 },
    removeOnComplete: KEEP_COMPLETED,
    removeOnFail: KEEP_FAILED,
  });
}

// ---------------------------------------------------------------------------
// Utilitários de Redis
// ---------------------------------------------------------------------------

const RELEASE_LOCK = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

/** Trava simples com expiração. Devolve o token do dono, ou null se já estiver travado. */
export async function acquireLock(
  redis: Redis,
  key: string,
  ttlMs: number,
): Promise<string | null> {
  const token = randomUUID();
  const result = await redis.set(key, token, "PX", ttlMs, "NX");
  return result === "OK" ? token : null;
}

/** Solta a trava só se ela ainda for deste dono. */
export async function releaseLock(redis: Redis, key: string, token: string): Promise<void> {
  await redis.eval(RELEASE_LOCK, 1, key, token);
}

export function conversationLockKey(conversationId: string): string {
  return `proximo:lock:conversation:${conversationId}`;
}

/** Soma 1 num contador que expira sozinho. Usado no limite diário por cliente. */
export async function incrementCounter(
  redis: Redis,
  key: string,
  ttlSeconds: number,
): Promise<number> {
  const results = await redis.multi().incr(key).expire(key, ttlSeconds, "NX").exec();
  const value = results?.[0]?.[1];
  return typeof value === "number" ? value : Number(value ?? 0);
}

export type { Redis } from "ioredis";
