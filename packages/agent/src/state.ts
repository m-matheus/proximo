import { z } from "zod";

/**
 * Estado do agente numa conversa, guardado em conversations.agent_state.
 * Guarda a proposta esperando confirmação e os apelidos dos agendamentos (a1, a2...).
 */

const executedSchema = z
  .object({ appointmentId: z.string(), result: z.string() })
  .nullable()
  .default(null);

const common = {
  /** Turno em que a proposta foi feita. A confirmação só vale num turno posterior. */
  turn: z.number().int(),
  createdAt: z.string(),
  summary: z.string(),
  /** Preenchido assim que a ação é executada, para uma nova tentativa não repetir. */
  executed: executedSchema,
};

export const pendingActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create"),
    ...common,
    serviceId: z.string(),
    professionalId: z.string(),
    startsAt: z.string(),
    customerName: z.string(),
    notes: z.string().nullable(),
  }),
  z.object({
    type: z.literal("reschedule"),
    ...common,
    appointmentId: z.string(),
    professionalId: z.string(),
    startsAt: z.string(),
  }),
  z.object({
    type: z.literal("cancel"),
    ...common,
    appointmentId: z.string(),
    reason: z.string().nullable(),
  }),
]);

export type PendingAction = z.infer<typeof pendingActionSchema>;

export const agentStateSchema = z.object({
  version: z.literal(1),
  /** Número do turno atual. Cada turno começa com mensagem nova do cliente. */
  turn: z.number().int().nonnegative(),
  pending: pendingActionSchema.nullable(),
  appointmentRefs: z.record(z.string(), z.string()),
});

export type AgentState = z.infer<typeof agentStateSchema>;

export function initialAgentState(): AgentState {
  return { version: 1, turn: 0, pending: null, appointmentRefs: {} };
}

/** Lê o estado salvo. Se estiver ausente ou num formato antigo, começa do zero. */
export function parseAgentState(value: unknown): AgentState {
  const parsed = agentStateSchema.safeParse(value);
  return parsed.success ? parsed.data : initialAgentState();
}

/** Propostas mais velhas que isso não podem mais ser confirmadas. */
export const PENDING_TTL_MS = 2 * 60 * 60 * 1000;
