import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRootEnv } from "@proximo/core";
import { createDb, type Db } from "./client";

/**
 * Utilitários para testes de integração com o banco de teste.
 * Nunca apontam para o banco de desenvolvimento: exigem DATABASE_URL_TEST com "test" no nome.
 */

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function getTestDatabaseUrl(): string {
  loadRootEnv(packageDir);
  const url = process.env.DATABASE_URL_TEST;
  if (!url) {
    throw new Error(
      "DATABASE_URL_TEST não definida. Copie o .env.example para .env e suba os serviços com pnpm services:up.",
    );
  }
  const databaseName = new URL(url).pathname.replace(/^\//, "");
  if (!databaseName.includes("test")) {
    throw new Error(
      `DATABASE_URL_TEST precisa apontar para um banco de teste, veio "${databaseName}".`,
    );
  }
  return url;
}

/** Aplica as migrations no banco de teste. Chame no globalSetup do Vitest. */
export function migrateTestDatabase(): void {
  const url = getTestDatabaseUrl();
  const require = createRequire(import.meta.url);
  const prismaCli = require.resolve("prisma/build/index.js");
  execFileSync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: packageDir,
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
}

export function createTestDb(): Db {
  return createDb(getTestDatabaseUrl());
}

/** Apaga os dados de todas as tabelas, mantendo o schema. */
export async function resetTestDatabase(db: Db): Promise<void> {
  const rows = await db.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `;
  if (rows.length === 0) {
    return;
  }
  const tables = rows.map((row) => `"public"."${row.tablename}"`).join(", ");
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
}
