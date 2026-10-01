import { loadRootEnv, parseEnv } from "@proximo/core";
import { z } from "zod";

export const apiEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.string().default("info"),
  API_PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().min(1, "obrigatória"),
  REDIS_URL: z.string().min(1, "obrigatória"),
  WHATSAPP_APP_SECRET: z.string().default(""),
  WHATSAPP_VERIFY_TOKEN: z.string().default(""),
  SIMULATOR_ENABLED: z.stringbool().default(false),
  AGENT_DEBOUNCE_MS: z.coerce.number().int().min(0).default(2500),
  AGENT_HUMAN_MODE_HOURS: z.coerce.number().positive().default(12),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;

export function loadApiEnv(): ApiEnv {
  loadRootEnv();
  return parseEnv(apiEnvSchema);
}
