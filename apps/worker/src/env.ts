import { loadRootEnv, parseEnv } from "@proximo/core";
import { z } from "zod";

const optional = z
  .string()
  .optional()
  .transform((value) => value || undefined);

export const workerEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.string().default("info"),
  DATABASE_URL: z.string().min(1, "obrigatória"),
  REDIS_URL: z.string().min(1, "obrigatória"),
  ENCRYPTION_KEY: optional,
  ANTHROPIC_API_KEY: optional,
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-5-5"),
  ANTHROPIC_EFFORT: z.enum(["low", "medium", "high"]).default("low"),
  ANTHROPIC_MAX_TOKENS: z.coerce.number().int().positive().default(8000),
  ANTHROPIC_FALLBACKS: z.enum(["default", "off"]).default("default"),
  ANTHROPIC_PREFIX_MISMATCH: z.enum(["drop_block", "error"]).default("drop_block"),
  WHATSAPP_GRAPH_API_VERSION: z.string().default("v26.0"),
  AGENT_SESSION_IDLE_HOURS: z.coerce.number().positive().default(6),
  AGENT_HUMAN_MODE_HOURS: z.coerce.number().positive().default(12),
  AGENT_MAX_RUNS_PER_CUSTOMER_PER_DAY: z.coerce.number().int().positive().default(40),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export function loadWorkerEnv(): WorkerEnv {
  loadRootEnv();
  return parseEnv(workerEnvSchema);
}
