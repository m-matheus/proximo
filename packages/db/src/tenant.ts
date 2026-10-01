import type { Db } from "./client";

/**
 * Escopo de tenant: devolve um cliente do Prisma que só enxerga um negócio.
 *
 * - Leituras, atualizações e exclusões recebem `businessId` no `where`.
 * - Criações recebem `businessId` nos dados. Se vier outro negócio, é erro.
 * - Tentar mudar o `businessId` de um registro é erro.
 *
 * Funciona como rede de segurança. As chaves estrangeiras compostas no banco
 * são a segunda camada: mesmo um bug aqui não liga dados de negócios diferentes.
 * Relações aninhadas em escritas não passam por este filtro, então nas tabelas
 * de tenant prefira escrever com IDs escalares.
 */

/** Modelos que pertencem a um negócio e têm a coluna businessId. */
export const TENANT_MODELS: ReadonlySet<string> = new Set([
  "Membership",
  "Channel",
  "Professional",
  "Service",
  "ProfessionalService",
  "WorkingHours",
  "ScheduleBlock",
  "Customer",
  "Appointment",
  "Conversation",
  "Message",
  "AgentSession",
  "AgentRun",
  "Notification",
  "AuditLog",
]);

const OPERATIONS_WITH_WHERE = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "delete",
  "deleteMany",
  "upsert",
]);

const OPERATIONS_WITH_UPDATE_DATA = new Set(["update", "updateMany", "updateManyAndReturn"]);

export class TenantScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantScopeError";
  }
}

type Row = Record<string, unknown>;

function asRow(value: unknown): Row {
  return value && typeof value === "object" ? (value as Row) : {};
}

function assertSameBusiness(value: unknown, businessId: string, where: string): void {
  if (value !== undefined && value !== businessId) {
    throw new TenantScopeError(`${where}: businessId de outro negócio no escopo ${businessId}.`);
  }
}

function withBusinessId(data: unknown, businessId: string, model: string): Row {
  const row = asRow(data);
  assertSameBusiness(row.businessId, businessId, `${model}.create`);
  if ("business" in row) {
    throw new TenantScopeError(
      `${model}.create: use businessId escalar no escopo do tenant, não business: { connect }.`,
    );
  }
  return { ...row, businessId };
}

export function scopeToBusiness(db: Db, businessId: string) {
  return db.$extends({
    name: "tenant-scope",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!TENANT_MODELS.has(model)) {
            return query(args);
          }
          const scoped: Row = { ...asRow(args) };

          if (OPERATIONS_WITH_WHERE.has(operation)) {
            const where = asRow(scoped.where);
            assertSameBusiness(where.businessId, businessId, `${model}.${operation}`);
            scoped.where = { ...where, businessId };
          }

          if (OPERATIONS_WITH_UPDATE_DATA.has(operation)) {
            assertSameBusiness(asRow(scoped.data).businessId, businessId, `${model}.${operation}`);
          }

          if (operation === "create") {
            scoped.data = withBusinessId(scoped.data, businessId, model);
          }

          if (operation === "createMany" || operation === "createManyAndReturn") {
            const data = scoped.data;
            scoped.data = Array.isArray(data)
              ? data.map((item) => withBusinessId(item, businessId, model))
              : withBusinessId(data, businessId, model);
          }

          if (operation === "upsert") {
            scoped.create = withBusinessId(scoped.create, businessId, model);
            assertSameBusiness(asRow(scoped.update).businessId, businessId, `${model}.upsert`);
          }

          return query(scoped as typeof args);
        },
      },
    },
  });
}

export type TenantDb = ReturnType<typeof scopeToBusiness>;
