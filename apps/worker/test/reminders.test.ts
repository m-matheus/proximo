import { randomBytes, randomUUID } from "node:crypto";
import { DEFAULT_AGENT_CONFIG } from "@proximo/agent";
import { ScriptedLlm } from "@proximo/agent/testing";
import { type Appointment, loadRootEnv, localDateTimeToDate } from "@proximo/core";
import { seedDemoBusiness } from "@proximo/db";
import { createTestDb, resetTestDatabase } from "@proximo/db/testing";
import { ChannelError, SimulatorChannel, type TemplateMessage } from "@proximo/messaging";
import { createRedis, type OutboundJob } from "@proximo/queue";
import type { SchedulingProvider } from "@proximo/scheduling";
import { CONTRACT_NOW, demoCatalog, InMemorySchedulingProvider } from "@proximo/scheduling/testing";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ChannelRegistry } from "../src/channels";
import type { WorkerDeps } from "../src/inbound";
import { handleOutbound } from "../src/outbound";
import {
  parseReminderButtonPayload,
  type ReminderDeps,
  scanReminders,
  sendReminderNow,
} from "../src/reminders";

loadRootEnv();
const db = createTestDb();
const redis = createRedis(process.env.REDIS_URL ?? "redis://localhost:6379");
const TZ = "America/Sao_Paulo";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

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

let now: Date;
let provider: InMemorySchedulingProvider;
let simulator: SimulatorChannel;
let outboundJobs: OutboundJob[];
let deps: ReminderDeps;
let workerDeps: WorkerDeps;
let businessId: string;
let customerId: string;
let conversationId: string;

const silent = { info() {}, warn() {}, error() {} };

async function book(
  startsAt: Date,
  customer = customerId,
  professionalId = "prof-carlos",
): Promise<Appointment> {
  return provider.createAppointment({
    serviceId: "svc-corte",
    professionalId,
    startsAt,
    customer: { id: customer, name: "Ana", phoneE164: "+5551999998888" },
    source: "agent",
  });
}

async function newCustomer(data: { remindersOptOut?: boolean; anonymizedAt?: Date } = {}) {
  const customer = await db.customer.create({
    data: {
      businessId,
      waId: `55519${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
      waUserId: `SIM.${randomUUID()}`,
      ...data,
    },
  });
  provider.addCustomer({ id: customer.id, name: "Bia", phoneE164: null });
  return customer;
}

beforeEach(async () => {
  await resetTestDatabase(db);
  const demo = await seedDemoBusiness(db);
  businessId = demo.businessId;
  const customer = await db.customer.create({
    data: {
      businessId,
      waId: "5551999998888",
      waUserId: `SIM.${randomUUID()}`,
      phoneE164: "+5551999998888",
    },
  });
  customerId = customer.id;
  conversationId = (
    await db.conversation.create({
      data: { businessId, customerId, channelId: demo.simulatorChannelId },
    })
  ).id;

  now = CONTRACT_NOW;
  provider = new InMemorySchedulingProvider(demoCatalog(), () => now);
  provider.addCustomer({ id: customerId, name: "Ana", phoneE164: "+5551999998888" });
  simulator = new SimulatorChannel();
  outboundJobs = [];
  deps = {
    db,
    enqueueOutbound: async (job) => {
      outboundJobs.push(job);
    },
    providerFor: () => provider,
    now: () => now,
    logger: silent,
  };
  workerDeps = {
    db,
    redis,
    llm: new ScriptedLlm(),
    agentConfig: DEFAULT_AGENT_CONFIG,
    channels: new ChannelRegistry({ graphApiVersion: "v26.0", simulator }),
    enqueueOutbound: deps.enqueueOutbound,
    settings: {
      sessionIdleHours: 6,
      humanModeHours: 12,
      maxRunsPerCustomerPerDay: 40,
      maxSessionMessages: 80,
    },
    now: () => now,
    logger: silent,
  };
});

describe("lembretes", () => {
  it("manda o lembrete de 24h dentro da janela, uma vez só, e envia o template", async () => {
    const appointment = await book(at("2026-09-30", "15:00"));
    now = new Date(appointment.startsAt.getTime() - 23 * HOUR - 30 * MINUTE);

    expect(await scanReminders(deps)).toMatchObject({ queued: 1, skipped: 0 });
    expect(await scanReminders(deps)).toMatchObject({ queued: 0, skipped: 0 });

    const notification = await db.notification.findFirstOrThrow();
    expect(notification).toMatchObject({
      appointmentRef: appointment.id,
      appointmentStartsAt: appointment.startsAt,
      kind: "reminder_24h",
      status: "pending",
    });
    const message = await db.message.findUniqueOrThrow({
      where: { id: notification.messageId ?? "" },
    });
    expect(message).toMatchObject({
      conversationId,
      direction: "outbound",
      author: "system",
      kind: "template",
      deliveryStatus: "pending",
      body:
        "Olá! Passando para lembrar do seu horário amanhã em Barbearia Exemplo: Corte com Carlos, " +
        "quarta, 30/09 às 15:00. Você confirma presença? Se precisar, dá para remarcar ou cancelar pelos botões abaixo.",
    });
    expect(outboundJobs).toEqual([{ businessId, messageId: message.id }]);

    expect(await handleOutbound({ businessId, messageId: message.id }, workerDeps)).toBe("sent");
    const sent = simulator.sent[0]?.template as TemplateMessage;
    expect(sent).toMatchObject({
      name: "lembrete_24h",
      languageCode: "pt_BR",
      bodyParameters: ["Barbearia Exemplo", "Corte", "Carlos", "quarta, 30/09", "15:00"],
    });
    expect(sent.quickReplyPayloads?.map(parseReminderButtonPayload)).toEqual([
      { notificationId: notification.id, action: "confirm" },
      { notificationId: notification.id, action: "reschedule" },
      { notificationId: notification.id, action: "cancel" },
    ]);
    expect(
      await db.notification.findUniqueOrThrow({ where: { id: notification.id } }),
    ).toMatchObject({ status: "sent", sentAt: now });
  });

  it("não manda fora das janelas", async () => {
    const appointment = await book(at("2026-09-30", "15:00"));
    const start = appointment.startsAt.getTime();
    for (const before of [24 * HOUR, 22 * HOUR + 55 * MINUTE, 12 * HOUR, 2 * HOUR, 85 * MINUTE]) {
      now = new Date(start - before);
      expect(await scanReminders(deps)).toMatchObject({ queued: 0, skipped: 0 });
    }
    expect(await db.notification.count()).toBe(0);
  });

  it("manda o de 2h também para quem já confirmou", async () => {
    const appointment = await book(at("2026-09-30", "15:00"));
    await provider.confirmAppointment(appointment.id);
    now = new Date(appointment.startsAt.getTime() - 105 * MINUTE);

    expect(await scanReminders(deps)).toMatchObject({ queued: 1 });
    const message = await db.message.findFirstOrThrow({ where: { kind: "template" } });
    expect(message.body).toContain(
      "Seu horário em Barbearia Exemplo é hoje às 15:00: Corte com Carlos.",
    );
    expect((await db.notification.findFirstOrThrow()).kind).toBe("reminder_2h");
  });

  it("horário remarcado ganha os lembretes de novo", async () => {
    const appointment = await book(at("2026-09-30", "15:00"));
    now = new Date(appointment.startsAt.getTime() - 23 * HOUR - 30 * MINUTE);
    expect(await scanReminders(deps)).toMatchObject({ queued: 1 });

    const moved = await provider.rescheduleAppointment(appointment.id, {
      startsAt: at("2026-10-01", "15:00"),
    });
    now = new Date(moved.startsAt.getTime() - 23 * HOUR - 30 * MINUTE);
    expect(await scanReminders(deps)).toMatchObject({ queued: 1 });

    const notifications = await db.notification.findMany({ orderBy: { createdAt: "asc" } });
    expect(notifications.map((item) => item.appointmentStartsAt)).toEqual([
      appointment.startsAt,
      moved.startsAt,
    ]);
  });

  it("não lembra de horário cancelado", async () => {
    const appointment = await book(at("2026-09-30", "15:00"));
    await provider.cancelAppointment(appointment.id);
    now = new Date(appointment.startsAt.getTime() - 23 * HOUR - 30 * MINUTE);
    expect(await scanReminders(deps)).toMatchObject({ queued: 0, skipped: 0 });
  });

  it("registra o motivo de cada lembrete que não sai", async () => {
    const optOut = await newCustomer({ remindersOptOut: true });
    const anonymized = await newCustomer({ anonymizedAt: CONTRACT_NOW });
    const recent = await newCustomer();
    now = at("2026-09-29", "15:45");
    await db.conversation.create({
      data: {
        businessId,
        customerId: recent.id,
        channelId: (await db.channel.findFirstOrThrow({ where: { type: "simulator" } })).id,
        lastInboundAt: new Date(now.getTime() - 20 * MINUTE),
      },
    });
    await book(at("2026-09-30", "15:00"), optOut.id);
    await book(at("2026-09-30", "15:00"), anonymized.id, "prof-marcos");
    await book(at("2026-09-30", "15:30"), recent.id);

    expect(await scanReminders(deps)).toMatchObject({ queued: 0, skipped: 3 });
    const reasons = await db.notification.findMany({ select: { status: true, error: true } });
    expect(reasons).toHaveLength(3);
    expect(reasons).toEqual(
      expect.arrayContaining([
        { status: "skipped", error: "O cliente pediu para não receber lembretes." },
        { status: "skipped", error: "Cliente anonimizado." },
        { status: "skipped", error: "O cliente falou com o Próximo há menos de uma hora." },
      ]),
    );
    expect(await db.message.count({ where: { kind: "template" } })).toBe(0);
    // Pulado também é definitivo: a próxima varredura não tenta de novo.
    expect(await scanReminders(deps)).toMatchObject({ queued: 0, skipped: 0 });
  });

  it("sem conversa, usa o canal do WhatsApp do negócio; sem canal, não manda", async () => {
    const lone = await newCustomer();
    const first = await book(at("2026-09-30", "15:00"), lone.id);
    now = new Date(first.startsAt.getTime() - 23 * HOUR - 30 * MINUTE);
    expect(await scanReminders(deps)).toMatchObject({ skipped: 1 });
    expect((await db.notification.findFirstOrThrow()).error).toBe(
      "Negócio sem canal do WhatsApp ativo.",
    );

    await seedDemoBusiness(db, {
      whatsapp: {
        phoneNumberId: "106540352242922",
        accessToken: "token",
        encryptionKey: randomBytes(32),
      },
    });
    const second = await book(at("2026-10-01", "15:00"), lone.id);
    now = new Date(second.startsAt.getTime() - 23 * HOUR - 30 * MINUTE);
    expect(await scanReminders(deps)).toMatchObject({ queued: 1 });
    const conversation = await db.conversation.findFirstOrThrow({
      where: { customerId: lone.id },
      include: { channel: true },
    });
    expect(conversation.channel.type).toBe("whatsapp_cloud");
  });

  it("negócio cuja agenda já manda lembrete fica de fora", async () => {
    const appointment = await book(at("2026-09-30", "15:00"));
    const ownReminders = Object.create(provider) as SchedulingProvider;
    Object.defineProperty(ownReminders, "capabilities", {
      value: { manageCatalog: false, sendsOwnReminders: true },
    });
    deps.providerFor = () => ownReminders;
    now = new Date(appointment.startsAt.getTime() - 23 * HOUR - 30 * MINUTE);
    expect(await scanReminders(deps)).toMatchObject({ queued: 0, skipped: 0 });
  });

  it("envio avulso ignora a janela e a conversa recente, mas não duplica", async () => {
    const appointment = await book(at("2026-10-01", "15:00"));
    await db.conversation.update({
      where: { id: conversationId },
      data: { lastInboundAt: CONTRACT_NOW },
    });
    const job = { businessId, appointmentId: appointment.id, kind: "reminder_24h" as const };
    expect(await sendReminderNow(deps, job)).toBe("queued");
    expect(await sendReminderNow(deps, job)).toBe("duplicate");
    expect(await sendReminderNow(deps, { ...job, appointmentId: "appt-x" })).toBe("not_found");
  });

  it("reenfileira o lembrete gravado que ficou sem envio", async () => {
    const appointment = await book(at("2026-09-30", "15:00"));
    now = new Date(appointment.startsAt.getTime() - 23 * HOUR - 30 * MINUTE);
    await scanReminders(deps);
    const notification = await db.notification.findFirstOrThrow();
    outboundJobs.length = 0;

    now = new Date(now.getTime() + 10 * MINUTE);
    await db.notification.update({
      where: { id: notification.id },
      data: { createdAt: new Date(now.getTime() - 5 * MINUTE) },
    });
    expect(await scanReminders(deps)).toMatchObject({ requeued: 1, queued: 0 });
    expect(outboundJobs).toEqual([{ businessId, messageId: notification.messageId }]);
  });

  it("marca o lembrete como falho quando o canal recusa o template", async () => {
    class RefusingChannel extends SimulatorChannel {
      override async sendTemplate(): Promise<never> {
        throw new ChannelError("Meta recusou a requisição: template não aprovado", {
          retryable: false,
          code: 132001,
        });
      }
    }
    workerDeps.channels = new ChannelRegistry({
      graphApiVersion: "v26.0",
      simulator: new RefusingChannel(),
    });
    const appointment = await book(at("2026-09-30", "15:00"));
    now = new Date(appointment.startsAt.getTime() - 23 * HOUR - 30 * MINUTE);
    await scanReminders(deps);
    const notification = await db.notification.findFirstOrThrow();

    expect(
      await handleOutbound({ businessId, messageId: notification.messageId ?? "" }, workerDeps),
    ).toBe("failed");
    expect(
      await db.notification.findUniqueOrThrow({ where: { id: notification.id } }),
    ).toMatchObject({
      status: "failed",
      error: "Meta recusou a requisição: template não aprovado",
    });
  });
});
