import { randomUUID } from "node:crypto";
import { DEFAULT_AGENT_CONFIG } from "@proximo/agent";
import { ScriptedLlm, textReply } from "@proximo/agent/testing";
import { type Appointment, loadRootEnv, localDateTimeToDate } from "@proximo/core";
import { seedDemoBusiness } from "@proximo/db";
import { createTestDb, resetTestDatabase } from "@proximo/db/testing";
import { SimulatorChannel } from "@proximo/messaging";
import { createRedis, type OutboundJob } from "@proximo/queue";
import type { SchedulingProvider } from "@proximo/scheduling";
import { CONTRACT_NOW } from "@proximo/scheduling/testing";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ChannelRegistry } from "../src/channels";
import { handleInbound, schedulingProviderFor, type WorkerDeps } from "../src/inbound";
import { REMINDER_REPLIES } from "../src/reminder-buttons";
import { type ReminderAction, reminderButtonPayload, sendReminderNow } from "../src/reminders";

loadRootEnv();
const db = createTestDb();
const redis = createRedis(process.env.REDIS_URL ?? "redis://localhost:6379");
const TZ = "America/Sao_Paulo";
const BUTTON_TEXT: Record<ReminderAction, string> = {
  confirm: "Confirmar presença",
  reschedule: "Remarcar",
  cancel: "Cancelar horário",
};

afterAll(async () => {
  await db.$disconnect();
  await redis.quit();
});

function at(date: string, time: string): Date {
  const instant = localDateTimeToDate(date, time, TZ);
  if (!instant) {
    throw new Error(`Data inválida: ${date} ${time}`);
  }
  return instant;
}

let llm: ScriptedLlm;
let outboundJobs: OutboundJob[];
let deps: WorkerDeps;
let provider: SchedulingProvider;
let businessId: string;
let conversationId: string;
let customerId: string;
let appointment: Appointment;
let notificationId: string;
let now: Date;
let clock: number;

const silent = { info() {}, warn() {}, error() {} };

async function customerMessage(
  data:
    | { kind: "button"; action: ReminderAction; notification?: string }
    | { kind: "text"; text: string },
) {
  clock += 1_000;
  return db.message.create({
    data: {
      businessId,
      conversationId,
      direction: "inbound",
      author: "customer",
      kind: data.kind,
      body: data.kind === "button" ? BUTTON_TEXT[data.action] : data.text,
      payload:
        data.kind === "button"
          ? {
              buttonPayload: reminderButtonPayload(
                data.notification ?? notificationId,
                data.action,
              ),
            }
          : {},
      externalId: `sim.${randomUUID()}`,
      createdAt: new Date(clock),
    },
  });
}

async function tap(action: ReminderAction, notification?: string) {
  const message = await customerMessage({ kind: "button", action, notification });
  return handleInbound({ businessId, conversationId, messageId: message.id }, deps);
}

async function lastReply(): Promise<string | null> {
  const reply = await db.message.findFirst({
    where: { direction: "outbound", kind: "text" },
    orderBy: { createdAt: "desc" },
  });
  return reply?.body ?? null;
}

beforeEach(async () => {
  await resetTestDatabase(db);
  const demo = await seedDemoBusiness(db);
  businessId = demo.businessId;
  customerId = (
    await db.customer.create({
      data: {
        businessId,
        waId: "5551999998888",
        waUserId: `SIM.${randomUUID()}`,
        phoneE164: "+5551999998888",
        name: "Ana",
      },
    })
  ).id;
  conversationId = (
    await db.conversation.create({
      data: { businessId, customerId, channelId: demo.simulatorChannelId },
    })
  ).id;
  now = CONTRACT_NOW;
  clock = CONTRACT_NOW.getTime();

  llm = new ScriptedLlm();
  outboundJobs = [];
  deps = {
    db,
    redis,
    llm,
    agentConfig: DEFAULT_AGENT_CONFIG,
    channels: new ChannelRegistry({ graphApiVersion: "v26.0", simulator: new SimulatorChannel() }),
    enqueueOutbound: async (job) => {
      outboundJobs.push(job);
    },
    settings: {
      sessionIdleHours: 6,
      humanModeHours: 12,
      maxRunsPerCustomerPerDay: 40,
      maxSessionMessages: 80,
    },
    now: () => now,
    logger: silent,
  };
  const business = await db.business.findUniqueOrThrow({ where: { id: businessId } });
  provider = schedulingProviderFor(deps, business);
  appointment = await provider.createAppointment({
    serviceId: demo.services.Corte ?? "",
    professionalId: demo.professionals.carlos,
    startsAt: at("2026-09-30", "15:00"),
    customer: { id: customerId, name: "Ana", phoneE164: "+5551999998888" },
    source: "agent",
  });
  await sendReminderNow(
    {
      db,
      enqueueOutbound: deps.enqueueOutbound,
      providerFor: () => provider,
      now: () => now,
      logger: silent,
    },
    { businessId, appointmentId: appointment.id, kind: "reminder_24h" },
  );
  notificationId = (await db.notification.findFirstOrThrow()).id;
});

describe("botões do lembrete", () => {
  it("confirma presença sem chamar o Claude", async () => {
    expect(await tap("confirm")).toBe("reminder_button");
    expect(llm.requests).toHaveLength(0);
    expect((await provider.getAppointment(appointment.id))?.status).toBe("confirmed");
    expect(await lastReply()).toBe(
      REMINDER_REPLIES.confirmed("quarta, 30/09 às 15:00, com Carlos"),
    );
    expect(await db.message.count({ where: { direction: "inbound", handledAt: null } })).toBe(0);

    expect(await tap("confirm")).toBe("reminder_button");
    expect(await lastReply()).toBe(
      REMINDER_REPLIES.alreadyConfirmed("quarta, 30/09 às 15:00, com Carlos"),
    );
  });

  it("cancela pelo botão e oferece marcar outro", async () => {
    expect(await tap("cancel")).toBe("reminder_button");
    expect(llm.requests).toHaveLength(0);
    const cancelled = await db.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(cancelled).toMatchObject({
      status: "cancelled",
      cancelReason: "Cancelado pelo cliente no lembrete.",
    });
    expect(await lastReply()).toBe(
      REMINDER_REPLIES.cancelled("Corte com Carlos, quarta, 30/09 às 15:00"),
    );

    expect(await tap("confirm")).toBe("reminder_button");
    expect(await lastReply()).toBe(REMINDER_REPLIES.alreadyCancelled);
  });

  it("remarcar segue para o agente com o horário do lembrete", async () => {
    llm.push(textReply("Claro! Para quando você quer?"));
    expect(await tap("reschedule")).toBe("agent");
    expect(llm.requests).toHaveLength(1);
    const sent = JSON.stringify(llm.requests[0]?.messages);
    expect(sent).toContain(
      '[o cliente tocou em \\"Remarcar\\" no lembrete e quer remarcar este horário: Corte com Carlos, quarta, 30/09 às 15:00]',
    );
    expect((await provider.getAppointment(appointment.id))?.status).toBe("scheduled");
  });

  it("resolve o botão e manda o texto que veio junto para o agente", async () => {
    await customerMessage({ kind: "button", action: "confirm" });
    const text = await customerMessage({ kind: "text", text: "e vocês aceitam pix?" });
    llm.push(textReply("Aceitamos sim!"));

    expect(await handleInbound({ businessId, conversationId, messageId: text.id }, deps)).toBe(
      "agent",
    );
    expect((await provider.getAppointment(appointment.id))?.status).toBe("confirmed");
    // A fala do cliente é só o texto; o toque já resolvido aparece no resumo da conversa.
    const [customerTurn, context] = llm.requests[0]?.messages ?? [];
    expect(customerTurn?.content).toEqual([{ type: "text", text: "e vocês aceitam pix?" }]);
    expect(JSON.stringify(context?.content)).toContain("Presença confirmada!");
    expect(await db.message.count({ where: { direction: "inbound", handledAt: null } })).toBe(0);
  });

  it("não mexe em horário de outro cliente", async () => {
    const other = await db.customer.create({
      data: { businessId, waId: "5551988887777", waUserId: `SIM.${randomUUID()}` },
    });
    const otherAppointment = await provider.createAppointment({
      serviceId: appointment.serviceId,
      professionalId: appointment.professionalId,
      startsAt: at("2026-09-30", "16:00"),
      customer: { id: other.id, name: "Bia", phoneE164: null },
      source: "agent",
    });
    const otherNotification = await db.notification.create({
      data: {
        businessId,
        appointmentRef: otherAppointment.id,
        appointmentStartsAt: otherAppointment.startsAt,
        kind: "reminder_24h",
      },
    });

    expect(await tap("cancel", otherNotification.id)).toBe("reminder_button");
    expect(await lastReply()).toBe(REMINDER_REPLIES.notFound);
    expect((await provider.getAppointment(otherAppointment.id))?.status).toBe("scheduled");
  });

  it("avisa quando o horário já passou", async () => {
    now = new Date(appointment.startsAt.getTime() + 60_000);
    expect(await tap("confirm")).toBe("reminder_button");
    expect(await lastReply()).toBe(REMINDER_REPLIES.past);
  });

  it("não confirma um horário que mudou depois do lembrete", async () => {
    await provider.rescheduleAppointment(appointment.id, { startsAt: at("2026-10-01", "15:00") });
    expect(await tap("confirm")).toBe("reminder_button");
    expect(await lastReply()).toBe(
      REMINDER_REPLIES.changed("Corte com Carlos, quinta, 01/10 às 15:00"),
    );
    expect((await provider.getAppointment(appointment.id))?.status).toBe("scheduled");
  });

  it("botão que não é de lembrete continua indo para o agente", async () => {
    clock += 1_000;
    const message = await db.message.create({
      data: {
        businessId,
        conversationId,
        direction: "inbound",
        author: "customer",
        kind: "button",
        body: "Sim",
        payload: { buttonPayload: "outra-coisa" },
        externalId: `sim.${randomUUID()}`,
        createdAt: new Date(clock),
      },
    });
    llm.push(textReply("Oi!"));
    expect(await handleInbound({ businessId, conversationId, messageId: message.id }, deps)).toBe(
      "agent",
    );
    expect(JSON.stringify(llm.requests[0]?.messages)).toContain("Sim");
  });
});
