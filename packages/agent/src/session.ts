import { createHash } from "node:crypto";
import { type Appointment, formatDateTimeLong } from "@proximo/core";
import type { BetaTool } from "./llm";

/**
 * Sessões do agente.
 *
 * O histórico enviado ao Claude só pode crescer: editar um turno anterior invalida
 * o raciocínio guardado e o cache. Por isso cada sessão congela modelo, prompt de
 * sistema e ferramentas. Quando algo disso muda, ou a conversa esfria, abre-se uma
 * sessão nova que começa com um resumo curto do cliente, sem repetir o histórico.
 */

export function computeAgentVersion(
  model: string,
  systemPrompt: string,
  tools: BetaTool[],
): string {
  return createHash("sha256")
    .update(JSON.stringify({ model, systemPrompt, tools }))
    .digest("hex")
    .slice(0, 32);
}

export type RotationReason = "no_session" | "config_changed" | "idle" | "too_long";

export interface SessionInfo {
  agentVersion: string;
  lastActivityAt: Date;
  messageCount: number;
}

export interface RotationOptions {
  idleHours: number;
  maxMessages: number;
}

export function sessionRotationReason(
  existing: SessionInfo | null,
  agentVersion: string,
  now: Date,
  options: RotationOptions,
): RotationReason | null {
  if (!existing) {
    return "no_session";
  }
  if (existing.agentVersion !== agentVersion) {
    return "config_changed";
  }
  if (now.getTime() - existing.lastActivityAt.getTime() > options.idleHours * 60 * 60 * 1000) {
    return "idle";
  }
  if (existing.messageCount >= options.maxMessages) {
    return "too_long";
  }
  return null;
}

export interface CarryOverMessage {
  author: "customer" | "agent" | "staff";
  text: string;
}

const AUTHOR_LABEL: Record<CarryOverMessage["author"], string> = {
  customer: "cliente",
  agent: "assistente",
  staff: "equipe",
};

/** Resumo que abre uma sessão nova: próximos agendamentos e últimas mensagens. */
export function buildCarryOver(input: {
  upcoming: Appointment[];
  recent: CarryOverMessage[];
  timezone: string;
}): string {
  const lines = ["- Este atendimento continua uma conversa anterior com o mesmo cliente."];
  if (input.upcoming.length > 0) {
    const list = input.upcoming
      .slice(0, 5)
      .map(
        (appointment) =>
          `${appointment.serviceName} com ${appointment.professionalName}, ${formatDateTimeLong(
            appointment.startsAt,
            input.timezone,
          )}`,
      )
      .join("; ");
    lines.push(`- Próximos agendamentos do cliente: ${list}.`);
  } else {
    lines.push("- O cliente não tem agendamentos futuros.");
  }
  const recent = input.recent.slice(-8);
  if (recent.length > 0) {
    lines.push("- Últimas mensagens, da mais antiga para a mais recente:");
    for (const message of recent) {
      const text = message.text.replace(/\s+/g, " ").trim().slice(0, 300);
      lines.push(`  ${AUTHOR_LABEL[message.author]}: ${text}`);
    }
  }
  return lines.join("\n");
}
