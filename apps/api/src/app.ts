import type { Db } from "@proximo/db";
import type { InboundJob, ReminderJob } from "@proximo/queue";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { ApiEnv } from "./env";
import { simulatorRoutes } from "./routes/simulator";
import { whatsappRoutes } from "./routes/whatsapp";

export interface AppDeps {
  db: Db;
  env: Pick<
    ApiEnv,
    "WHATSAPP_APP_SECRET" | "WHATSAPP_VERIFY_TOKEN" | "SIMULATOR_ENABLED" | "AGENT_HUMAN_MODE_HOURS"
  >;
  enqueueInbound: (job: InboundJob) => Promise<void>;
  /** Só o simulador usa, para mandar um lembrete na hora. */
  enqueueReminder?: (job: Extract<ReminderJob, { type: "send" }>) => Promise<void>;
  logger?: FastifyServerOptions["logger"];
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false, bodyLimit: 1024 * 1024 });

  app.get("/health", async () => {
    await deps.db.$queryRaw`SELECT 1`;
    return { ok: true };
  });

  await app.register(whatsappRoutes, {
    db: deps.db,
    appSecret: deps.env.WHATSAPP_APP_SECRET,
    verifyToken: deps.env.WHATSAPP_VERIFY_TOKEN,
    humanModeHours: deps.env.AGENT_HUMAN_MODE_HOURS,
    enqueueInbound: deps.enqueueInbound,
  });

  if (deps.env.SIMULATOR_ENABLED) {
    await app.register(simulatorRoutes, {
      db: deps.db,
      enqueueInbound: deps.enqueueInbound,
      enqueueReminder:
        deps.enqueueReminder ??
        (async () => {
          throw new Error("Fila de lembretes não configurada.");
        }),
    });
  }

  return app;
}
