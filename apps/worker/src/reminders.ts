import {
  ACTIVE_APPOINTMENT_STATUSES,
  type Appointment,
  formatDateLong,
  formatTime,
} from "@proximo/core";
import { type Business, type Db, isUniqueViolation, type Prisma } from "@proximo/db";
import {
  REMINDER_TEMPLATES,
  renderTemplateBody,
  sanitizeTemplateParameter,
  type TemplateMessage,
} from "@proximo/messaging";
import type { OutboundJob, ReminderKind } from "@proximo/queue";
import type { SchedulingProvider } from "@proximo/scheduling";
import type { Logger } from "./inbound";

/**
 * Lembretes de 24h e 2h antes do horário, por template aprovado e com botões.
 *
 * A agenda é lida só pelo SchedulingProvider. A tabela de notificações, com chave
 * única por agendamento, tipo e horário, impede lembrete duplicado mesmo com dois
 * workers varrendo ao mesmo tempo.
 */

export interface ReminderDeps {
  db: Db;
  enqueueOutbound: (job: OutboundJob) => Promise<void>;
  providerFor: (business: Business) => SchedulingProvider;
  now: () => Date;
  logger: Logger;
}

/**
 * Janela de cada lembrete, em minutos antes do horário: começa logo depois de `earliest`
 * e vai até `latest`, inclusive. Fora dela o lembrete não sai, e um horário marcado em
 * cima da hora não recebe um lembrete atrasado. O fim exclusivo bate com o
 * listAppointments, que devolve só horários que começam antes do `to`.
 */
export const REMINDER_WINDOWS: Record<ReminderKind, { earliest: number; latest: number }> = {
  reminder_24h: { earliest: 24 * 60, latest: 23 * 60 },
  reminder_2h: { earliest: 120, latest: 90 },
};

/** Intervalo da varredura. Precisa ser bem menor que a janela mais curta. */
export const REMINDER_SCAN_EVERY_MS = 5 * 60 * 1000;

/** Quem falou com o Próximo há menos disto acabou de tratar do horário. */
export const RECENT_CONVERSATION_MINUTES = 60;

/** Envio gravado mas sem job na fila, como numa queda entre gravar e enfileirar. */
const STUCK_AFTER_MS = 2 * 60 * 1000;
const STUCK_UNTIL_MS = 6 * 60 * 60 * 1000;

const MINUTE = 60_000;
const ACTIVE: readonly string[] = ACTIVE_APPOINTMENT_STATUSES;

// ---------------------------------------------------------------------------
// Botões
// ---------------------------------------------------------------------------

/** Ações dos botões, na ordem dos botões do template. */
export const REMINDER_ACTIONS = ["confirm", "reschedule", "cancel"] as const;
export type ReminderAction = (typeof REMINDER_ACTIONS)[number];

const PAYLOAD_PREFIX = "rem";
const PAYLOAD_PATTERN = /^rem:([0-9a-f-]{36}):(confirm|reschedule|cancel)$/;

export function reminderButtonPayload(notificationId: string, action: ReminderAction): string {
  return `${PAYLOAD_PREFIX}:${notificationId}:${action}`;
}

/** Lê o payload de um botão do lembrete. Botões de outra origem devolvem null. */
export function parseReminderButtonPayload(
  payload: string | null | undefined,
): { notificationId: string; action: ReminderAction } | null {
  const match = payload ? PAYLOAD_PATTERN.exec(payload) : null;
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return { notificationId: match[1], action: match[2] as ReminderAction };
}

// ---------------------------------------------------------------------------
// Envio
// ---------------------------------------------------------------------------

/** O que o template precisa saber do negócio. */
export type ReminderBusiness = Pick<Business, "id" | "name" | "timezone">;

export type ReminderOutcome = "queued" | "duplicate" | "skipped";

/** Dados do template guardados na mensagem, para a fila de saída enviar. */
export interface TemplatePayload {
  template: TemplateMessage;
  /** Textos dos botões, para o histórico e o simulador. */
  buttons: string[];
}

export function reminderParameters(
  business: ReminderBusiness,
  appointment: Appointment,
  kind: ReminderKind,
): string[] {
  const time = formatTime(appointment.startsAt, business.timezone);
  const values =
    kind === "reminder_24h"
      ? [
          business.name,
          appointment.serviceName,
          appointment.professionalName,
          formatDateLong(appointment.startsAt, business.timezone),
          time,
        ]
      : [business.name, time, appointment.serviceName, appointment.professionalName];
  return values.map(sanitizeTemplateParameter);
}

type Target = { conversationId: string } | { skip: string };

/** Acha a conversa por onde o lembrete sai, ou o motivo de não sair. */
async function resolveTarget(
  db: Db,
  businessId: string,
  appointment: Appointment,
): Promise<Target> {
  if (!appointment.customerId) {
    return { skip: "Agendamento sem cliente do Próximo." };
  }
  const customer = await db.customer.findFirst({
    where: { id: appointment.customerId, businessId },
  });
  if (!customer) {
    return { skip: "Cliente não encontrado." };
  }
  if (customer.anonymizedAt) {
    return { skip: "Cliente anonimizado." };
  }
  if (customer.remindersOptOut) {
    return { skip: "O cliente pediu para não receber lembretes." };
  }
  if (!customer.waId && !customer.waUserId) {
    return { skip: "Cliente sem WhatsApp." };
  }

  const conversation = await db.conversation.findFirst({
    where: { businessId, customerId: customer.id, channel: { status: "active" } },
    orderBy: [{ lastMessageAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    select: { id: true },
  });
  if (conversation) {
    return { conversationId: conversation.id };
  }
  const channel = await db.channel.findFirst({
    where: { businessId, type: "whatsapp_cloud", status: "active" },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!channel) {
    return { skip: "Negócio sem canal do WhatsApp ativo." };
  }
  const created = await db.conversation.upsert({
    where: {
      businessId_customerId_channelId: {
        businessId,
        customerId: customer.id,
        channelId: channel.id,
      },
    },
    update: {},
    create: { businessId, customerId: customer.id, channelId: channel.id },
    select: { id: true },
  });
  return { conversationId: created.id };
}

/**
 * Grava a notificação e a mensagem do lembrete e pede o envio.
 * Com `force`, ignora a regra de conversa recente: é o envio avulso do simulador.
 */
export async function sendReminder(
  deps: ReminderDeps,
  input: {
    business: ReminderBusiness;
    appointment: Appointment;
    kind: ReminderKind;
    force?: boolean;
  },
): Promise<ReminderOutcome> {
  const { db } = deps;
  const { business, appointment, kind } = input;
  const now = deps.now();
  const key = {
    businessId: business.id,
    appointmentRef: appointment.id,
    kind,
    appointmentStartsAt: appointment.startsAt,
  };
  const existing = await db.notification.findUnique({
    where: { businessId_appointmentRef_kind_appointmentStartsAt: key },
    select: { id: true },
  });
  if (existing) {
    return "duplicate";
  }

  const target = await resolveTarget(db, business.id, appointment);
  let skip = "skip" in target ? target.skip : null;
  if (!skip && !input.force && "conversationId" in target) {
    const conversation = await db.conversation.findUniqueOrThrow({
      where: { id: target.conversationId },
      select: { lastInboundAt: true },
    });
    if (
      conversation.lastInboundAt &&
      now.getTime() - conversation.lastInboundAt.getTime() < RECENT_CONVERSATION_MINUTES * MINUTE
    ) {
      skip = "O cliente falou com o Próximo há menos de uma hora.";
    }
  }

  try {
    if (skip || !("conversationId" in target)) {
      await db.notification.create({
        data: { ...key, status: "skipped", error: skip },
      });
      return "skipped";
    }

    const template = REMINDER_TEMPLATES[kind];
    const parameters = reminderParameters(business, appointment, kind);
    const messageId = await db.$transaction(async (tx) => {
      const notification = await tx.notification.create({ data: key });
      const payload: TemplatePayload = {
        template: {
          name: template.name,
          languageCode: template.languageCode,
          bodyParameters: parameters,
          quickReplyPayloads: REMINDER_ACTIONS.map((action) =>
            reminderButtonPayload(notification.id, action),
          ),
        },
        buttons: [...template.quickReplies],
      };
      const message = await tx.message.create({
        data: {
          businessId: business.id,
          conversationId: target.conversationId,
          direction: "outbound",
          author: "system",
          kind: "template",
          body: renderTemplateBody(template, parameters),
          payload: payload as unknown as Prisma.InputJsonValue,
          deliveryStatus: "pending",
        },
      });
      await tx.notification.update({
        where: { id: notification.id },
        data: { messageId: message.id },
      });
      await tx.conversation.update({
        where: { id: target.conversationId },
        data: { lastMessageAt: now },
      });
      return message.id;
    });
    await deps.enqueueOutbound({ businessId: business.id, messageId });
    return "queued";
  } catch (error) {
    // Outro worker gravou o mesmo lembrete no meio-tempo.
    if (isUniqueViolation(error)) {
      return "duplicate";
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Varredura
// ---------------------------------------------------------------------------

export interface ScanResult {
  queued: number;
  skipped: number;
  requeued: number;
  failedBusinesses: number;
}

/** Procura, em todos os negócios, os horários que chegaram na hora do lembrete. */
export async function scanReminders(deps: ReminderDeps): Promise<ScanResult> {
  const now = deps.now();
  const result: ScanResult = {
    queued: 0,
    skipped: 0,
    requeued: await requeueStuck(deps, now),
    failedBusinesses: 0,
  };

  const businesses = await deps.db.business.findMany({ where: { status: "active" } });
  for (const business of businesses) {
    try {
      const provider = deps.providerFor(business);
      if (provider.capabilities.sendsOwnReminders) {
        continue;
      }
      for (const kind of Object.keys(REMINDER_WINDOWS) as ReminderKind[]) {
        const window = REMINDER_WINDOWS[kind];
        const from = new Date(now.getTime() + window.latest * MINUTE);
        const to = new Date(now.getTime() + window.earliest * MINUTE);
        const appointments = await provider.listAppointments({ from, to });
        for (const appointment of appointments) {
          const startsAt = appointment.startsAt.getTime();
          if (
            !ACTIVE.includes(appointment.status) ||
            startsAt < from.getTime() ||
            startsAt >= to.getTime()
          ) {
            continue;
          }
          const outcome = await sendReminder(deps, { business, appointment, kind });
          if (outcome === "queued") {
            result.queued += 1;
          } else if (outcome === "skipped") {
            result.skipped += 1;
          }
        }
      }
    } catch (error) {
      result.failedBusinesses += 1;
      deps.logger.error(
        { businessId: business.id, error: String(error) },
        "falha ao varrer lembretes do negócio",
      );
    }
  }
  return result;
}

async function requeueStuck(deps: ReminderDeps, now: Date): Promise<number> {
  const stuck = await deps.db.notification.findMany({
    where: {
      status: "pending",
      messageId: { not: null },
      createdAt: {
        lt: new Date(now.getTime() - STUCK_AFTER_MS),
        gt: new Date(now.getTime() - STUCK_UNTIL_MS),
      },
    },
    select: { businessId: true, messageId: true },
  });
  for (const notification of stuck) {
    if (notification.messageId) {
      // O ID do job é o da mensagem: se o envio ainda estiver na fila, nada muda.
      await deps.enqueueOutbound({
        businessId: notification.businessId,
        messageId: notification.messageId,
      });
    }
  }
  return stuck.length;
}

/** Lembrete avulso pedido pelo simulador. */
export async function sendReminderNow(
  deps: ReminderDeps,
  job: { businessId: string; appointmentId: string; kind: ReminderKind },
): Promise<ReminderOutcome | "not_found"> {
  const business = await deps.db.business.findFirst({
    where: { id: job.businessId, status: "active" },
  });
  if (!business) {
    return "not_found";
  }
  const appointment = await deps.providerFor(business).getAppointment(job.appointmentId);
  if (!appointment || !ACTIVE.includes(appointment.status)) {
    return "not_found";
  }
  return sendReminder(deps, { business, appointment, kind: job.kind, force: true });
}
