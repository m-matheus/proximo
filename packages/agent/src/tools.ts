import {
  ACTIVE_APPOINTMENT_STATUSES,
  type Appointment,
  formatDateTimeLong,
  type IsoWeekday,
  isDomainError,
  localDateTimeToDate,
  NotAllowedError,
  SlotUnavailableError,
  toZoned,
  WEEKDAY_NAMES_PT,
} from "@proximo/core";
import type { SchedulingProvider } from "@proximo/scheduling";
import { z } from "zod";
import {
  type Catalog,
  professionalAlias,
  professionalByAlias,
  professionalName,
  serviceByAlias,
} from "./catalog";
import type { BetaTool } from "./llm";
import { formatPrice } from "./prompt";
import { type AgentState, PENDING_TTL_MS, type PendingAction } from "./state";

/**
 * Ferramentas do agente. As regras que importam são garantidas aqui, no código,
 * e não só no prompt:
 * - horário só é aceito se a agenda o oferece agora;
 * - nada é gravado sem proposta anterior e sem uma mensagem nova do cliente depois dela;
 * - o cliente só enxerga e altera os próprios agendamentos.
 */

export const TOOL_NAMES = [
  "check_availability",
  "find_my_appointments",
  "propose_appointment",
  "propose_reschedule",
  "propose_cancellation",
  "confirm_proposal",
  "handoff_to_human",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

const MAX_TIMES_PER_DAY = 16;
const MINUTE = 60_000;
const ACTIVE: readonly string[] = ACTIVE_APPOINTMENT_STATUSES;

type JsonSchema = Record<string, unknown>;

function nullable(schema: JsonSchema, description: string): JsonSchema {
  return { description, anyOf: [schema, { type: "null" }] };
}

function strictObject(properties: Record<string, JsonSchema>): BetaTool["input_schema"] {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

/** Definições das ferramentas. Os enums vêm do catálogo congelado da sessão. */
export function buildTools(catalog: Catalog): BetaTool[] {
  const serviceAliases = catalog.services.map((entry) => entry.alias);
  const professionalAliases = catalog.professionals.map((entry) => entry.alias);
  const service: JsonSchema = {
    type: "string",
    ...(serviceAliases.length ? { enum: serviceAliases } : {}),
    description: "Código do serviço, como s1.",
  };
  const professional = nullable(
    { type: "string", ...(professionalAliases.length ? { enum: professionalAliases } : {}) },
    "Código do profissional, como p1. Use null quando o cliente não tiver preferência.",
  );
  const date: JsonSchema = {
    type: "string",
    format: "date",
    description: "Dia no formato AAAA-MM-DD.",
  };
  const time: JsonSchema = { type: "string", description: "Hora no formato HH:MM, 24 horas." };
  const appointment: JsonSchema = {
    type: "string",
    description: "Código do agendamento devolvido por find_my_appointments, como a1.",
  };

  return [
    {
      name: "check_availability",
      description:
        "Consulta os horários livres na agenda. Use sempre antes de oferecer, sugerir ou aceitar qualquer horário. Devolve os horários por dia e os profissionais livres em cada um.",
      strict: true,
      input_schema: strictObject({
        service,
        professional,
        date_from: date,
        days: {
          type: "integer",
          enum: [1, 2, 3, 4, 5, 6, 7],
          description: "Quantos dias consultar a partir de date_from.",
        },
        period: {
          type: "string",
          enum: ["any", "morning", "afternoon", "evening"],
          description:
            "Filtro de período: morning até 12h, afternoon das 12h às 18h, evening depois das 18h.",
        },
      }),
    },
    {
      name: "find_my_appointments",
      description:
        "Lista os próximos agendamentos do cliente desta conversa, com um código para cada um. Use antes de remarcar ou cancelar.",
      strict: true,
      input_schema: strictObject({}),
    },
    {
      name: "propose_appointment",
      description:
        "Registra uma proposta de agendamento para o cliente confirmar. Não grava na agenda. Depois, mostre o resumo e peça a confirmação.",
      strict: true,
      input_schema: strictObject({
        service,
        professional,
        date,
        time,
        customer_name: nullable(
          { type: "string" },
          "Nome informado pelo cliente. Obrigatório se ainda não houver nome salvo.",
        ),
        notes: nullable(
          { type: "string" },
          "Observação curta para o profissional, se o negócio pedir.",
        ),
      }),
    },
    {
      name: "propose_reschedule",
      description:
        "Registra uma proposta para mudar um agendamento de horário ou de profissional. Não altera nada até o cliente confirmar.",
      strict: true,
      input_schema: strictObject({ appointment, professional, date, time }),
    },
    {
      name: "propose_cancellation",
      description: "Registra uma proposta de cancelamento. Não cancela até o cliente confirmar.",
      strict: true,
      input_schema: strictObject({
        appointment,
        reason: nullable({ type: "string" }, "Motivo, se o cliente contou."),
      }),
    },
    {
      name: "confirm_proposal",
      description:
        "Executa a proposta pendente depois que o cliente disse que sim numa mensagem nova. Grava, remarca ou cancela de verdade.",
      strict: true,
      input_schema: strictObject({}),
    },
    {
      name: "handoff_to_human",
      description:
        "Passa a conversa para alguém da equipe. O agente para de responder este cliente por um tempo.",
      strict: true,
      input_schema: strictObject({
        reason: { type: "string", description: "Motivo em poucas palavras, para a equipe." },
      }),
    },
  ];
}

// ---------------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------------

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use AAAA-MM-DD");
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM");
const optionalText = z
  .string()
  .nullish()
  .transform((value) => value ?? null);

const inputSchemas = {
  check_availability: z.object({
    service: z.string(),
    professional: optionalText,
    date_from: dateSchema,
    days: z.number().int().min(1).max(7),
    period: z.enum(["any", "morning", "afternoon", "evening"]),
  }),
  find_my_appointments: z.object({}),
  propose_appointment: z.object({
    service: z.string(),
    professional: optionalText,
    date: dateSchema,
    time: timeSchema,
    customer_name: optionalText,
    notes: optionalText,
  }),
  propose_reschedule: z.object({
    appointment: z.string(),
    professional: optionalText,
    date: dateSchema,
    time: timeSchema,
  }),
  propose_cancellation: z.object({ appointment: z.string(), reason: optionalText }),
  confirm_proposal: z.object({}),
  handoff_to_human: z.object({ reason: z.string().min(1) }),
} satisfies Record<ToolName, z.ZodType>;

export interface ToolCustomer {
  id: string;
  name: string | null;
  phoneE164: string | null;
}

export interface ToolContext {
  provider: SchedulingProvider;
  catalog: Catalog;
  timezone: string;
  customer: ToolCustomer;
  /** Estado do turno. As ferramentas alteram este objeto. */
  state: AgentState;
  now: Date;
  /** Persiste o estado na hora, depois de uma ação que grava na agenda. */
  saveState: (state: AgentState) => Promise<void>;
  /** Preenchido por handoff_to_human. */
  handoff: { reason: string } | null;
}

export interface ToolOutcome {
  content: string;
  isError: boolean;
  /** Erro inesperado, para log. Não vai para o modelo. */
  internalError?: string;
}

const ok = (content: string): ToolOutcome => ({ content, isError: false });
const fail = (content: string): ToolOutcome => ({ content, isError: true });

/** Aceita pequenas variações de nome, como maiúsculas ou hífen. */
export function resolveToolName(name: string): ToolName | null {
  const normalized = name.trim().toLowerCase().replace(/-/g, "_");
  return TOOL_NAMES.find((tool) => tool === normalized) ?? null;
}

export async function executeTool(
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const tool = resolveToolName(name);
  if (!tool) {
    return fail(`Ferramenta desconhecida: ${name}. As ferramentas são: ${TOOL_NAMES.join(", ")}.`);
  }
  const parsed = inputSchemas[tool].safeParse(input ?? {});
  if (!parsed.success) {
    return fail(`Parâmetros inválidos para ${tool}: ${z.prettifyError(parsed.error)}`);
  }
  try {
    switch (tool) {
      case "check_availability":
        return await checkAvailability(
          parsed.data as z.infer<typeof inputSchemas.check_availability>,
          ctx,
        );
      case "find_my_appointments":
        return await findMyAppointments(ctx);
      case "propose_appointment":
        return await proposeAppointment(
          parsed.data as z.infer<typeof inputSchemas.propose_appointment>,
          ctx,
        );
      case "propose_reschedule":
        return await proposeReschedule(
          parsed.data as z.infer<typeof inputSchemas.propose_reschedule>,
          ctx,
        );
      case "propose_cancellation":
        return await proposeCancellation(
          parsed.data as z.infer<typeof inputSchemas.propose_cancellation>,
          ctx,
        );
      case "confirm_proposal":
        return await confirmProposal(ctx);
      case "handoff_to_human":
        ctx.handoff = { reason: (parsed.data as { reason: string }).reason.trim() };
        return ok(
          "Pedido registrado. Avise o cliente que alguém da equipe vai responder assim que possível, sem prometer horário.",
        );
    }
  } catch (error) {
    if (isDomainError(error)) {
      return fail(error.message);
    }
    return {
      content:
        "A agenda não respondeu agora. Tente de novo uma vez; se falhar de novo, chame alguém da equipe.",
      isError: true,
      internalError: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }
}

function period(minuteOfDay: number): "morning" | "afternoon" | "evening" {
  if (minuteOfDay < 12 * 60) {
    return "morning";
  }
  return minuteOfDay < 18 * 60 ? "afternoon" : "evening";
}

function dayLabel(date: Date, timezone: string): string {
  const zoned = toZoned(date, timezone);
  return `${WEEKDAY_NAMES_PT[zoned.weekday as IsoWeekday].slice(0, 3)} ${zoned.toFormat("yyyy-MM-dd")}`;
}

async function checkAvailability(
  input: z.infer<typeof inputSchemas.check_availability>,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const service = serviceByAlias(ctx.catalog, input.service);
  if (!service) {
    return fail(`Serviço desconhecido: ${input.service}.`);
  }
  const professional = input.professional
    ? professionalByAlias(ctx.catalog, input.professional)
    : null;
  if (input.professional && !professional) {
    return fail(`Profissional desconhecido: ${input.professional}.`);
  }
  const from = localDateTimeToDate(input.date_from, "00:00", ctx.timezone);
  if (!from) {
    return fail(`Data inválida: ${input.date_from}.`);
  }
  const to = toZoned(from, ctx.timezone).plus({ days: input.days }).toJSDate();
  const slots = await ctx.provider.getAvailability({
    serviceId: service.id,
    ...(professional ? { professionalId: professional.id } : {}),
    from,
    to,
  });

  const byDay = new Map<string, Map<string, string[]>>();
  for (const slot of slots) {
    const zoned = toZoned(slot.startsAt, ctx.timezone);
    if (input.period !== "any" && period(zoned.hour * 60 + zoned.minute) !== input.period) {
      continue;
    }
    const day = zoned.toFormat("yyyy-MM-dd");
    const times = byDay.get(day) ?? new Map<string, string[]>();
    const time = zoned.toFormat("HH:mm");
    times.set(time, [
      ...(times.get(time) ?? []),
      professionalAlias(ctx.catalog, slot.professionalId),
    ]);
    byDay.set(day, times);
  }

  const prices = new Set(service.offerings.map((offering) => offering.priceCents));
  const lines = [
    `${service.name} (${input.service}), ${service.durationMinutes} min, ${
      prices.size > 1 ? "preço varia por profissional" : formatPrice(service.priceCents)
    }.`,
  ];
  let truncated = false;
  for (let offset = 0; offset < input.days; offset += 1) {
    const day = toZoned(from, ctx.timezone).plus({ days: offset });
    const key = day.toFormat("yyyy-MM-dd");
    const label = dayLabel(day.toJSDate(), ctx.timezone);
    const times = [...(byDay.get(key) ?? new Map<string, string[]>()).entries()];
    if (times.length === 0) {
      lines.push(`${label}: sem horários livres`);
      continue;
    }
    const shown = times
      .slice(0, MAX_TIMES_PER_DAY)
      .map(([time, aliases]) => `${time} (${aliases.join(", ")})`);
    const rest = times.length - shown.length;
    truncated ||= rest > 0;
    lines.push(`${label}: ${shown.join(", ")}${rest > 0 ? `, e mais ${rest} horários` : ""}`);
  }
  if (truncated) {
    lines.push("Há mais horários do que os mostrados. Para ver outros, filtre por período.");
  }
  return ok(lines.join("\n"));
}

async function findMyAppointments(ctx: ToolContext): Promise<ToolOutcome> {
  const appointments = await ctx.provider.findCustomerAppointments({
    customer: { id: ctx.customer.id, phoneE164: ctx.customer.phoneE164 },
  });
  const refs: Record<string, string> = {};
  const lines = appointments.map((appointment, index) => {
    const ref = `a${index + 1}`;
    refs[ref] = appointment.id;
    return `${ref}: ${describeAppointment(appointment, ctx.timezone)}${
      appointment.status === "confirmed" ? ", presença confirmada" : ""
    }`;
  });
  ctx.state.appointmentRefs = refs;
  return ok(
    lines.length
      ? `Próximos agendamentos do cliente:\n${lines.join("\n")}`
      : "O cliente não tem agendamentos futuros.",
  );
}

function describeAppointment(appointment: Appointment, timezone: string): string {
  return `${appointment.serviceName} com ${appointment.professionalName}, ${formatDateTimeLong(
    appointment.startsAt,
    timezone,
  )}, ${formatPrice(appointment.priceCents)}`;
}

async function proposeAppointment(
  input: z.infer<typeof inputSchemas.propose_appointment>,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const service = serviceByAlias(ctx.catalog, input.service);
  if (!service) {
    return fail(`Serviço desconhecido: ${input.service}.`);
  }
  const professional = input.professional
    ? professionalByAlias(ctx.catalog, input.professional)
    : null;
  if (input.professional && !professional) {
    return fail(`Profissional desconhecido: ${input.professional}.`);
  }
  const startsAt = localDateTimeToDate(input.date, input.time, ctx.timezone);
  if (!startsAt) {
    return fail(`Data ou hora inválida: ${input.date} ${input.time}.`);
  }
  const customerName = input.customer_name?.trim() || ctx.customer.name?.trim() || "";
  if (!customerName) {
    return fail("Pergunte o nome do cliente antes de propor o horário.");
  }

  const slots = await ctx.provider.getAvailability({
    serviceId: service.id,
    ...(professional ? { professionalId: professional.id } : {}),
    from: startsAt,
    to: new Date(startsAt.getTime() + MINUTE),
  });
  const slot = slots.find((item) => item.startsAt.getTime() === startsAt.getTime());
  if (!slot) {
    return fail(
      `${input.time} de ${input.date} não está livre${professional ? ` com ${professional.name}` : ""}. Consulte check_availability e ofereça só horários da lista.`,
    );
  }

  const price =
    service.offerings.find((item) => item.professionalId === slot.professionalId)?.priceCents ??
    service.priceCents;
  const summary = `${service.name} com ${professionalName(ctx.catalog, slot.professionalId)}, ${formatDateTimeLong(
    startsAt,
    ctx.timezone,
  )}, ${formatPrice(price)}, no nome de ${customerName}`;
  ctx.state.pending = {
    type: "create",
    turn: ctx.state.turn,
    createdAt: ctx.now.toISOString(),
    summary,
    executed: null,
    serviceId: service.id,
    professionalId: slot.professionalId,
    startsAt: startsAt.toISOString(),
    customerName,
    notes: input.notes?.trim() || null,
  };
  return ok(
    `Proposta registrada, esperando confirmação: ${summary}. Mostre o resumo ao cliente e pergunte se pode confirmar. Só chame confirm_proposal depois que ele disser que sim.`,
  );
}

async function loadOwnAppointment(
  ref: string,
  ctx: ToolContext,
): Promise<Appointment | ToolOutcome> {
  const appointmentId = ctx.state.appointmentRefs[ref];
  if (!appointmentId) {
    return fail(
      `Agendamento desconhecido: ${ref}. Use find_my_appointments e passe um código como a1.`,
    );
  }
  const appointment = await ctx.provider.getAppointment(appointmentId);
  if (
    !appointment ||
    (appointment.customerId !== null && appointment.customerId !== ctx.customer.id)
  ) {
    return fail("Agendamento não encontrado para este cliente.");
  }
  if (!ACTIVE.includes(appointment.status) || appointment.startsAt.getTime() <= ctx.now.getTime()) {
    return fail("Esse agendamento não pode mais ser alterado.");
  }
  return appointment;
}

function isOutcome<T extends object>(value: T | ToolOutcome): value is ToolOutcome {
  return "isError" in value && "content" in value;
}

async function proposeReschedule(
  input: z.infer<typeof inputSchemas.propose_reschedule>,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const current = await loadOwnAppointment(input.appointment, ctx);
  if (isOutcome(current)) {
    return current;
  }
  const professional = input.professional
    ? professionalByAlias(ctx.catalog, input.professional)
    : null;
  if (input.professional && !professional) {
    return fail(`Profissional desconhecido: ${input.professional}.`);
  }
  const professionalId = professional?.id ?? current.professionalId;
  const startsAt = localDateTimeToDate(input.date, input.time, ctx.timezone);
  if (!startsAt) {
    return fail(`Data ou hora inválida: ${input.date} ${input.time}.`);
  }
  const slots = await ctx.provider.getAvailability({
    serviceId: current.serviceId,
    professionalId,
    from: startsAt,
    to: new Date(startsAt.getTime() + MINUTE),
    excludeAppointmentId: current.id,
  });
  if (!slots.some((slot) => slot.startsAt.getTime() === startsAt.getTime())) {
    return fail(
      `${input.time} de ${input.date} não está livre. Consulte check_availability e ofereça só horários da lista.`,
    );
  }
  const summary = `${current.serviceName} com ${professionalName(ctx.catalog, professionalId)}, de ${formatDateTimeLong(
    current.startsAt,
    ctx.timezone,
  )} para ${formatDateTimeLong(startsAt, ctx.timezone)}`;
  ctx.state.pending = {
    type: "reschedule",
    turn: ctx.state.turn,
    createdAt: ctx.now.toISOString(),
    summary,
    executed: null,
    appointmentId: current.id,
    professionalId,
    startsAt: startsAt.toISOString(),
  };
  return ok(
    `Remarcação registrada, esperando confirmação: ${summary}. Pergunte se o cliente confirma. Só chame confirm_proposal depois que ele disser que sim.`,
  );
}

async function proposeCancellation(
  input: z.infer<typeof inputSchemas.propose_cancellation>,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const current = await loadOwnAppointment(input.appointment, ctx);
  if (isOutcome(current)) {
    return current;
  }
  const summary = `cancelar ${describeAppointment(current, ctx.timezone)}`;
  ctx.state.pending = {
    type: "cancel",
    turn: ctx.state.turn,
    createdAt: ctx.now.toISOString(),
    summary,
    executed: null,
    appointmentId: current.id,
    reason: input.reason?.trim() || null,
  };
  return ok(
    `Cancelamento registrado, esperando confirmação: ${summary}. Pergunte se o cliente confirma. Só chame confirm_proposal depois que ele disser que sim.`,
  );
}

async function confirmProposal(ctx: ToolContext): Promise<ToolOutcome> {
  const pending = ctx.state.pending;
  if (!pending) {
    return fail("Não há proposta esperando confirmação. Faça a proposta antes.");
  }
  if (pending.executed) {
    return ok(pending.executed.result);
  }
  if (pending.turn >= ctx.state.turn) {
    return fail(
      "O cliente ainda não respondeu a esta proposta. Mostre o resumo e espere a resposta dele numa nova mensagem.",
    );
  }
  if (ctx.now.getTime() - new Date(pending.createdAt).getTime() > PENDING_TTL_MS) {
    ctx.state.pending = null;
    return fail("A proposta expirou. Consulte a agenda de novo e faça outra proposta.");
  }

  const executed = await executePending(pending, ctx);
  if (isOutcome(executed)) {
    ctx.state.pending = null;
    await ctx.saveState(ctx.state);
    return executed;
  }
  ctx.state.pending = { ...pending, executed };
  await ctx.saveState(ctx.state);
  return ok(executed.result);
}

async function executePending(
  pending: PendingAction,
  ctx: ToolContext,
): Promise<{ appointmentId: string; result: string } | ToolOutcome> {
  const tz = ctx.timezone;
  switch (pending.type) {
    case "create": {
      const startsAt = new Date(pending.startsAt);
      let appointment: Appointment;
      try {
        appointment = await ctx.provider.createAppointment({
          serviceId: pending.serviceId,
          professionalId: pending.professionalId,
          startsAt,
          customer: {
            id: ctx.customer.id,
            name: pending.customerName,
            phoneE164: ctx.customer.phoneE164,
          },
          source: "agent",
          ...(pending.notes ? { notes: pending.notes } : {}),
        });
      } catch (error) {
        if (!(error instanceof SlotUnavailableError)) {
          throw error;
        }
        // Uma tentativa anterior pode ter gravado antes de falhar: nesse caso, é sucesso.
        const own = await ctx.provider.findCustomerAppointments({
          customer: { id: ctx.customer.id },
        });
        const existing = own.find(
          (item) =>
            item.serviceId === pending.serviceId &&
            item.professionalId === pending.professionalId &&
            item.startsAt.getTime() === startsAt.getTime(),
        );
        if (!existing) {
          return fail(
            "Esse horário acabou de ser ocupado. Consulte a agenda de novo e ofereça outras opções.",
          );
        }
        appointment = existing;
      }
      ctx.customer.name = pending.customerName;
      return {
        appointmentId: appointment.id,
        result: `Agendamento confirmado: ${describeAppointment(appointment, tz)}. Avise o cliente.`,
      };
    }
    case "reschedule": {
      const startsAt = new Date(pending.startsAt);
      let appointment: Appointment;
      try {
        appointment = await ctx.provider.rescheduleAppointment(pending.appointmentId, {
          startsAt,
          professionalId: pending.professionalId,
        });
      } catch (error) {
        const current = await ctx.provider.getAppointment(pending.appointmentId);
        const alreadyDone =
          current &&
          current.startsAt.getTime() === startsAt.getTime() &&
          current.professionalId === pending.professionalId &&
          ACTIVE.includes(current.status);
        if (!alreadyDone || !current) {
          if (error instanceof SlotUnavailableError) {
            return fail(
              "Esse horário acabou de ser ocupado. Consulte a agenda de novo e ofereça outras opções.",
            );
          }
          throw error;
        }
        appointment = current;
      }
      return {
        appointmentId: appointment.id,
        result: `Agendamento remarcado: ${describeAppointment(appointment, tz)}. Avise o cliente.`,
      };
    }
    case "cancel": {
      let appointment: Appointment;
      try {
        appointment = await ctx.provider.cancelAppointment(
          pending.appointmentId,
          pending.reason ?? undefined,
        );
      } catch (error) {
        const current = await ctx.provider.getAppointment(pending.appointmentId);
        if (!(error instanceof NotAllowedError) || current?.status !== "cancelled") {
          throw error;
        }
        appointment = current;
      }
      return {
        appointmentId: appointment.id,
        result: `Agendamento cancelado: ${appointment.serviceName} com ${appointment.professionalName}, ${formatDateTimeLong(
          appointment.startsAt,
          tz,
        )}. Avise o cliente.`,
      };
    }
  }
}
