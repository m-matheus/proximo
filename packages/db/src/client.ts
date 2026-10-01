import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";

export type Db = PrismaClient;

/** Cria o cliente do Prisma com o adaptador do Postgres. */
export function createDb(databaseUrl: string): Db {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL não definida.");
  }
  const adapter = new PrismaPg({ connectionString: databaseUrl });
  return new PrismaClient({ adapter });
}
