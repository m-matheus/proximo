/**
 * Reconhece violações de restrição do Postgres, venham elas do Prisma ou do driver.
 * O Prisma embrulha erros do adaptador de formas diferentes conforme a versão,
 * então procuramos o código SQLSTATE e o nome da restrição em todo o erro.
 */

function collectText(error: unknown, depth = 0): string {
  if (!error || depth > 4) {
    return "";
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error !== "object") {
    return "";
  }
  const record = error as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["code", "message", "constraint", "originalCode", "originalMessage"]) {
    const value = record[key];
    if (typeof value === "string") {
      parts.push(value);
    }
  }
  if (record.meta) {
    parts.push(JSON.stringify(record.meta));
  }
  parts.push(collectText(record.cause, depth + 1));
  return parts.join(" ");
}

/** Agendamento sobreposto barrado pela exclusion constraint appointments_no_overlap. */
export function isAppointmentOverlapError(error: unknown): boolean {
  const text = collectText(error);
  return text.includes("23P01") || text.includes("appointments_no_overlap");
}

/** Violação de chave única, como um webhook repetido. */
export function isUniqueViolation(error: unknown): boolean {
  const text = collectText(error);
  return /\bP2002\b/.test(text) || text.includes("23505");
}
