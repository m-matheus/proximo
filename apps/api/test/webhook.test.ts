import { createHmac, randomBytes } from "node:crypto";
import { seedDemoBusiness } from "@proximo/db";
import { createTestDb, resetTestDatabase } from "@proximo/db/testing";
import type { InboundJob, ReminderJob } from "@proximo/queue";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";

const db = createTestDb();
const PHONE_NUMBER_ID = "106540352242922";
const APP_SECRET = "segredo-do-app";

let app: FastifyInstance;
let jobs: InboundJob[];
let reminderJobs: ReminderJob[];

function sign(body: string): string {
  return `sha256=${createHmac("sha256", APP_SECRET).update(body).digest("hex")}`;
}

function envelope(field: string, value: Record<string, unknown>) {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba",
        changes: [
          {
            field,
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "5551900000000", phone_number_id: PHONE_NUMBER_ID },
              ...value,
            },
          },
        ],
      },
    ],
  });
}

function textMessage(id: string, text: string) {
  return envelope("messages", {
    contacts: [{ profile: { name: "Ana" }, wa_id: "555199998888", user_id: "BR.123456" }],
    messages: [
      {
        from: "555199998888",
        from_user_id: "BR.123456",
        id,
        timestamp: "1790000000",
        type: "text",
        text: { body: text },
      },
    ],
  });
}

function post(body: string, signature: string | null = sign(body)) {
  return app.inject({
    method: "POST",
    url: "/webhooks/whatsapp",
    payload: body,
    headers: {
      "content-type": "application/json",
      ...(signature !== null ? { "x-hub-signature-256": signature } : {}),
    },
  });
}

beforeEach(async () => {
  await resetTestDatabase(db);
  await seedDemoBusiness(db, {
    whatsapp: {
      phoneNumberId: PHONE_NUMBER_ID,
      accessToken: "token",
      encryptionKey: randomBytes(32),
    },
  });
  jobs = [];
  reminderJobs = [];
  app = await buildApp({
    db,
    env: {
      WHATSAPP_APP_SECRET: APP_SECRET,
      WHATSAPP_VERIFY_TOKEN: "verifica",
      SIMULATOR_ENABLED: true,
      AGENT_HUMAN_MODE_HOURS: 12,
    },
    enqueueInbound: async (job) => {
      jobs.push(job);
    },
    enqueueReminder: async (job) => {
      reminderJobs.push(job);
    },
  });
});

afterAll(async () => {
  await app?.close();
  await db.$disconnect();
});

describe("verificação do webhook", () => {
  it("devolve o challenge com o token certo e recusa o errado", async () => {
    const ok = await app.inject({
      method: "GET",
      url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verifica&hub.challenge=12345",
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe("12345");

    const wrong = await app.inject({
      method: "GET",
      url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=outro&hub.challenge=12345",
    });
    expect(wrong.statusCode).toBe(403);
  });
});

describe("mensagens recebidas", () => {
  it("recusa assinatura inválida sem gravar nada", async () => {
    const body = textMessage("wamid.1", "oi");
    expect((await post(body, null)).statusCode).toBe(401);
    expect((await post(body, "sha256=abc")).statusCode).toBe(401);
    expect(await db.message.count()).toBe(0);
    expect(jobs).toHaveLength(0);
  });

  it("grava cliente, conversa e mensagem, e agenda o agente uma vez só", async () => {
    const body = textMessage("wamid.1", "quero marcar um corte");
    const first = await post(body);
    expect(first.statusCode).toBe(200);

    const customer = await db.customer.findFirstOrThrow();
    expect(customer).toMatchObject({
      waId: "555199998888",
      waUserId: "BR.123456",
      phoneE164: "+5551999998888",
      name: null,
    });
    const message = await db.message.findFirstOrThrow();
    expect(message).toMatchObject({
      direction: "inbound",
      author: "customer",
      kind: "text",
      body: "quero marcar um corte",
    });
    expect(message.payload).toEqual({ profileName: "Ana" });
    expect(jobs).toEqual([
      {
        businessId: message.businessId,
        conversationId: message.conversationId,
        messageId: message.id,
      },
    ]);

    // A Meta reenvia o mesmo evento: nada se repete.
    expect((await post(body)).statusCode).toBe(200);
    expect(await db.message.count()).toBe(1);
    expect(jobs).toHaveLength(1);
  });

  it("ignora número sem canal cadastrado", async () => {
    const body = textMessage("wamid.1", "oi").replace(PHONE_NUMBER_ID, "999");
    expect((await post(body)).statusCode).toBe(200);
    expect(await db.message.count()).toBe(0);
  });
});

describe("status e ecos", () => {
  it("atualiza a entrega sem voltar para trás", async () => {
    await post(textMessage("wamid.1", "oi"));
    const inbound = await db.message.findFirstOrThrow();
    const outbound = await db.message.create({
      data: {
        businessId: inbound.businessId,
        conversationId: inbound.conversationId,
        direction: "outbound",
        author: "agent",
        kind: "text",
        body: "Oi!",
        externalId: "wamid.out",
        deliveryStatus: "sent",
      },
    });
    const status = (state: string) =>
      envelope("messages", {
        statuses: [
          { id: "wamid.out", status: state, timestamp: "1790000001", recipient_id: "555199998888" },
        ],
      });

    await post(status("read"));
    await post(status("delivered"));
    expect(
      (await db.message.findUniqueOrThrow({ where: { id: outbound.id } })).deliveryStatus,
    ).toBe("read");
  });

  it("falha na entrega de um lembrete marca a notificação como falha", async () => {
    await post(textMessage("wamid.1", "oi"));
    const inbound = await db.message.findFirstOrThrow();
    const reminder = await db.message.create({
      data: {
        businessId: inbound.businessId,
        conversationId: inbound.conversationId,
        direction: "outbound",
        author: "system",
        kind: "template",
        body: "Olá! Seu horário...",
        externalId: "wamid.tpl",
        deliveryStatus: "sent",
      },
    });
    const notification = await db.notification.create({
      data: {
        businessId: inbound.businessId,
        appointmentRef: "appt-1",
        appointmentStartsAt: new Date(),
        kind: "reminder_2h",
        status: "sent",
        messageId: reminder.id,
      },
    });
    await post(
      envelope("messages", {
        statuses: [
          {
            id: "wamid.tpl",
            status: "failed",
            timestamp: "1790000001",
            recipient_id: "555199998888",
            errors: [{ code: 131026, title: "Message undeliverable" }],
          },
        ],
      }),
    );
    expect(
      await db.notification.findUniqueOrThrow({ where: { id: notification.id } }),
    ).toMatchObject({ status: "failed", error: "131026 Message undeliverable" });
  });

  it("resposta da equipe pelo celular tira o agente da conversa", async () => {
    await post(textMessage("wamid.1", "oi"));
    await post(
      envelope("smb_message_echoes", {
        message_echoes: [
          {
            from: "5551900000000",
            to: "555199998888",
            id: "wamid.echo",
            timestamp: "1790000002",
            type: "text",
            text: { body: "Pode vir às 15h!" },
          },
        ],
      }),
    );
    const conversation = await db.conversation.findFirstOrThrow();
    expect(conversation.mode).toBe("human");
    expect(conversation.humanUntil).not.toBeNull();
    const staff = await db.message.findFirstOrThrow({ where: { author: "staff" } });
    expect(staff.body).toBe("Pode vir às 15h!");
    expect(await db.customer.count()).toBe(1);
  });
});

describe("simulador", () => {
  it("manda mensagem pelo mesmo caminho do WhatsApp e mostra a conversa", async () => {
    const channels = await app.inject({ method: "GET", url: "/dev/simulator/channels" });
    const [channel] = channels.json() as Array<{ channelId: string; businessName: string }>;
    expect(channel?.businessName).toBe("Barbearia Exemplo");

    const sent = await app.inject({
      method: "POST",
      url: "/dev/simulator/messages",
      payload: { channelId: channel?.channelId, phone: "(51) 99999-8888", name: "Ana", text: "oi" },
    });
    expect(sent.statusCode).toBe(200);
    const { conversationId } = sent.json() as { conversationId: string };
    expect(jobs).toHaveLength(1);

    const conversation = await app.inject({
      method: "GET",
      url: `/dev/simulator/conversations/${conversationId}`,
    });
    expect(conversation.json()).toMatchObject({
      mode: "agent",
      customer: { phoneE164: "+5551999998888" },
      messages: [{ author: "customer", body: "oi" }],
    });

    const removed = await app.inject({
      method: "DELETE",
      url: `/dev/simulator/conversations/${conversationId}`,
    });
    expect(removed.statusCode).toBe(204);
    expect(await db.customer.count()).toBe(0);
  });

  it("manda lembrete na hora, mostra os botões e grava o toque como botão", async () => {
    const channels = await app.inject({ method: "GET", url: "/dev/simulator/channels" });
    const [channel] = channels.json() as Array<{ channelId: string }>;
    const send = (payload: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: "/dev/simulator/messages",
        payload: { channelId: channel?.channelId, phone: "(51) 99999-8888", ...payload },
      });
    const { conversationId } = (await send({ text: "oi" })).json() as { conversationId: string };
    const conversation = await db.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    const [professional, service] = await Promise.all([
      db.professional.findFirstOrThrow({ where: { name: "Carlos" } }),
      db.service.findFirstOrThrow({ where: { name: "Corte" } }),
    ]);
    const appointment = await db.appointment.create({
      data: {
        businessId: conversation.businessId,
        customerId: conversation.customerId,
        professionalId: professional.id,
        serviceId: service.id,
        startsAt: new Date("2026-10-01T18:00:00.000Z"),
        endsAt: new Date("2026-10-01T18:30:00.000Z"),
        source: "agent",
        priceCents: 5000,
      },
    });

    const remind = () =>
      app.inject({
        method: "POST",
        url: `/dev/simulator/appointments/${appointment.id}/reminders`,
        payload: { kind: "reminder_24h" },
      });
    expect((await remind()).statusCode).toBe(202);
    expect(reminderJobs).toEqual([
      {
        type: "send",
        businessId: conversation.businessId,
        appointmentId: appointment.id,
        kind: "reminder_24h",
      },
    ]);

    // O worker grava o lembrete; daí em diante o mesmo pedido é recusado.
    const notification = await db.notification.create({
      data: {
        businessId: conversation.businessId,
        appointmentRef: appointment.id,
        appointmentStartsAt: appointment.startsAt,
        kind: "reminder_24h",
      },
    });
    expect((await remind()).statusCode).toBe(409);
    await db.message.create({
      data: {
        businessId: conversation.businessId,
        conversationId,
        direction: "outbound",
        author: "system",
        kind: "template",
        body: "Olá! Passando para lembrar...",
        deliveryStatus: "sent",
        payload: {
          template: {
            name: "lembrete_24h",
            languageCode: "pt_BR",
            quickReplyPayloads: [`rem:${notification.id}:confirm`, `rem:${notification.id}:cancel`],
          },
          buttons: ["Confirmar presença", "Cancelar horário"],
        },
      },
    });
    const shown = await app.inject({
      method: "GET",
      url: `/dev/simulator/conversations/${conversationId}`,
    });
    expect(shown.json()).toMatchObject({
      messages: [
        { kind: "text", buttons: [] },
        {
          kind: "template",
          buttons: [
            { label: "Confirmar presença", payload: `rem:${notification.id}:confirm` },
            { label: "Cancelar horário", payload: `rem:${notification.id}:cancel` },
          ],
        },
      ],
    });

    const tapped = await send({
      text: "Confirmar presença",
      buttonPayload: `rem:${notification.id}:confirm`,
    });
    expect(tapped.statusCode).toBe(200);
    const button = await db.message.findFirstOrThrow({ where: { kind: "button" } });
    expect(button).toMatchObject({
      body: "Confirmar presença",
      payload: { buttonPayload: `rem:${notification.id}:confirm` },
    });
    expect(jobs).toHaveLength(2);
  });
});
