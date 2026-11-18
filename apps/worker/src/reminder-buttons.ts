import { type Appointment, formatDateTimeLong, isDomainError } from "@proximo/core";
import type { Business, Db, Message } from "@proximo/db";
import type { SchedulingProvider } from "@proximo/scheduling";
import { parseReminderButtonPayload, type ReminderAction } from "./reminders";

/**
 * Toque num botão do lembrete, resolvido sem o Claude.
 *
 * Confirmar e cancelar mexem na agenda pelo SchedulingProvider e recebem uma resposta
 * fixa. Remarcar segue para o agente, descrito com o horário que o cliente quer mudar.
 * O botão só mexe em agendamento do próprio cliente.
 */

export const REMINDER_REPLIES = {
  confirmed: (when: string) => `Presença confirmada! Te esperamos ${when}.`,
  alreadyConfirmed: (when: string) => `Sua presença já está confirmada. Te esperamos ${when}.`,
  cancelled: (what: string) =>
    `Pronto, cancelei seu horário: ${what}. Se quiser marcar outro, é só me chamar por aqui.`,
  alreadyCancelled:
    "Esse horário já estava cancelado. Se quiser marcar outro, é só me chamar por aqui.",
  past: "Esse horário já passou. Se quiser marcar outro, é só me chamar por aqui.",
  changed: (what: string) =>
    `Esse lembrete era de um horário que mudou. Agora seu horário é ${what}. Se quiser mudar alguma coisa, é só me chamar por aqui.`,
  notFound:
    "Não encontrei esse horário no seu nome. Me conta o que você precisa que eu te ajudo por aqui.",
  scheduleUnavailable:
    "Opa, não estou conseguindo acessar a agenda agora. Vou pedir pra alguém da equipe te responder, tá?",
} as const;

export interface ButtonContext {
  db: Db;
  provider: SchedulingProvider;
  business: Pick<Business, "id" | "timezone">;
  customerId: string;
  now: Date;
}

export type ButtonOutcome =
  /** Resposta fixa ao cliente; com `handoff`, a conversa passa para a equipe. */
  | { type: "reply"; text: string; handoff: string | null }
  /** Segue para o agente com esta descrição no lugar do texto do botão. */
  | { type: "agent"; description: string };

function describe(appointment: Appointment, timezone: string): string {
  return `${appointment.serviceName} com ${appointment.professionalName}, ${formatDateTimeLong(
    appointment.startsAt,
    timezone,
  )}`;
}

function reply(text: string, handoff: string | null = null): ButtonOutcome {
  return { type: "reply", text, handoff };
}

async function resolve(
  ctx: ButtonContext,
  notificationId: string,
  action: ReminderAction,
): Promise<ButtonOutcome> {
  const notification = await ctx.db.notification.findFirst({
    where: { id: notificationId, businessId: ctx.business.id },
  });
  if (!notification) {
    return reply(REMINDER_REPLIES.notFound);
  }

  const { timezone } = ctx.business;
  try {
    const appointment = await ctx.provider.getAppointment(notification.appointmentRef);
    if (!appointment || appointment.customerId !== ctx.customerId) {
      return reply(REMINDER_REPLIES.notFound);
    }
    if (appointment.status === "cancelled") {
      return reply(REMINDER_REPLIES.alreadyCancelled);
    }
    if (
      appointment.status === "completed" ||
      appointment.status === "no_show" ||
      appointment.startsAt.getTime() <= ctx.now.getTime()
    ) {
      return reply(REMINDER_REPLIES.past);
    }
    if (action === "reschedule") {
      return {
        type: "agent",
        description: `[o cliente tocou em "Remarcar" no lembrete e quer remarcar este horário: ${describe(appointment, timezone)}]`,
      };
    }
    if (appointment.startsAt.getTime() !== notification.appointmentStartsAt.getTime()) {
      return reply(REMINDER_REPLIES.changed(describe(appointment, timezone)));
    }

    const when = `${formatDateTimeLong(appointment.startsAt, timezone)}, com ${appointment.professionalName}`;
    if (action === "confirm") {
      if (appointment.status === "confirmed") {
        return reply(REMINDER_REPLIES.alreadyConfirmed(when));
      }
      await ctx.provider.confirmAppointment(appointment.id);
      return reply(REMINDER_REPLIES.confirmed(when));
    }
    await ctx.provider.cancelAppointment(appointment.id, "Cancelado pelo cliente no lembrete.");
    return reply(REMINDER_REPLIES.cancelled(describe(appointment, timezone)));
  } catch (error) {
    if (isDomainError(error) && error.code !== "PROVIDER_UNAVAILABLE") {
      return reply(`${error.message} Se precisar, é só me chamar por aqui.`);
    }
    return reply(
      REMINDER_REPLIES.scheduleUnavailable,
      "A agenda não respondeu ao botão do lembrete.",
    );
  }
}

/** Separa os toques em botões de lembrete entre as mensagens pendentes e resolve cada um. */
export async function resolveReminderButtons(
  ctx: ButtonContext,
  pending: Array<Pick<Message, "id" | "kind" | "payload">>,
): Promise<Map<string, ButtonOutcome>> {
  const outcomes = new Map<string, ButtonOutcome>();
  for (const message of pending) {
    if (message.kind !== "button") {
      continue;
    }
    const payload = (message.payload as { buttonPayload?: string } | null)?.buttonPayload;
    const parsed = parseReminderButtonPayload(payload);
    if (parsed) {
      outcomes.set(message.id, await resolve(ctx, parsed.notificationId, parsed.action));
    }
  }
  return outcomes;
}
