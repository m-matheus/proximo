import { createDb } from "@proximo/db";
import { createQueues, createRedis, enqueueInbound } from "@proximo/queue";
import { buildApp } from "./app";
import { loadApiEnv } from "./env";

const env = loadApiEnv();
const db = createDb(env.DATABASE_URL);
const redis = createRedis(env.REDIS_URL);
const queues = createQueues(redis);

const app = await buildApp({
  db,
  env,
  enqueueInbound: (job) => enqueueInbound(queues.inbound, job, env.AGENT_DEBOUNCE_MS),
  logger: {
    level: env.LOG_LEVEL,
    // Nunca registrar tokens nem assinaturas.
    redact: ["req.headers.authorization", 'req.headers["x-hub-signature-256"]'],
    ...(env.NODE_ENV === "development"
      ? {
          transport: {
            target: "pino-pretty",
            options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" },
          },
        }
      : {}),
  },
});

if (!env.WHATSAPP_APP_SECRET) {
  app.log.warn("WHATSAPP_APP_SECRET vazio: o webhook do WhatsApp vai recusar todas as chamadas.");
}
if (env.SIMULATOR_ENABLED) {
  app.log.info("Simulador de conversa ligado em /dev/simulator.");
}

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "encerrando a API");
  await app.close();
  await queues.close();
  await redis.quit();
  await db.$disconnect();
  process.exit(0);
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ port: env.API_PORT, host: "0.0.0.0" });
