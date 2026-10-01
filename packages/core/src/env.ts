import { existsSync } from "node:fs";
import path from "node:path";
import type { z } from "zod";

/**
 * Carrega o .env da raiz do monorepo, procurando o pnpm-workspace.yaml a partir
 * da pasta atual. Variáveis já definidas no ambiente têm prioridade.
 */
export function loadRootEnv(fromDir: string = process.cwd()): void {
  let dir = path.resolve(fromDir);
  for (;;) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
      const file = path.join(dir, ".env");
      if (existsSync(file)) {
        process.loadEnvFile(file);
      }
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return;
    }
    dir = parent;
  }
}

/** Valida variáveis de ambiente e lista todas as que faltam ou estão erradas. */
export function parseEnv<T extends z.ZodType>(
  schema: T,
  source: NodeJS.ProcessEnv = process.env,
): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(raiz)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Variáveis de ambiente inválidas:\n${problems}`);
  }
  return result.data;
}
