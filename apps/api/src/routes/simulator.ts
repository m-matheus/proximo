import { randomUUID } from "node:crypto";
import { normalizePhoneE164 } from "@proximo/core";
import type { Db } from "@proximo/db";
import type { InboundJob } from "@proximo/queue";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ingestInboundMessage } from "../ingest";

/**
 * Simulador de conversa, só para desenvolvimento. Faz a mensagem passar pelo mesmo
 * caminho do WhatsApp: entrada, fila, worker e agente. Ligue com SIMULATOR_ENABLED=true.
 */

export interface SimulatorRouteOptions {
  db: Db;
  enqueueInbound: (job: InboundJob) => Promise<void>;
}

const sendSchema = z.object({
  channelId: z.string().uuid(),
  phone: z.string().min(8),
  name: z.string().trim().max(80).optional(),
  text: z.string().trim().min(1).max(2000),
});

export async function simulatorRoutes(
  app: FastifyInstance,
  options: SimulatorRouteOptions,
): Promise<void> {
  const { db } = options;

  app.get("/dev/simulator/channels", async () => {
    const channels = await db.channel.findMany({
      where: { type: "simulator", status: "active", business: { status: "active" } },
      include: { business: { select: { name: true, segment: true } } },
      orderBy: { createdAt: "asc" },
    });
    return channels.map((channel) => ({
      channelId: channel.id,
      businessName: channel.business.name,
      segment: channel.business.segment,
    }));
  });

  app.post("/dev/simulator/messages", async (request, reply) => {
    const parsed = sendSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: z.prettifyError(parsed.error) });
    }
    const { channelId, phone, name, text } = parsed.data;
    const phoneE164 = normalizePhoneE164(phone, { defaultCountry: "BR" });
    if (!phoneE164) {
      return reply.code(400).send({ error: "Telefone inválido." });
    }
    const channel = await db.channel.findFirst({
      where: { id: channelId, type: "simulator", status: "active" },
      select: { id: true, businessId: true },
    });
    if (!channel) {
      return reply.code(404).send({ error: "Canal de simulação não encontrado." });
    }
    const digits = phoneE164.slice(1);
    const result = await ingestInboundMessage(
      { db, enqueueInbound: options.enqueueInbound },
      {
        channel,
        from: { waId: digits, waUserId: `SIM.${digits}`, profileName: name || null },
        externalId: `sim.${randomUUID()}`,
        timestamp: new Date(),
        kind: "text",
        text,
        buttonPayload: null,
      },
    );
    if (result.status !== "created") {
      return reply.code(422).send({ error: `Mensagem não registrada: ${result.status}` });
    }
    return { conversationId: result.conversationId, messageId: result.messageId };
  });

  app.get("/dev/simulator/conversations/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const conversation = await db.conversation.findUnique({
      where: { id },
      include: {
        business: { select: { timezone: true } },
        customer: { select: { name: true, phoneE164: true } },
        messages: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            direction: true,
            author: true,
            kind: true,
            body: true,
            deliveryStatus: true,
            createdAt: true,
          },
        },
      },
    });
    if (!conversation) {
      return reply.code(404).send({ error: "Conversa não encontrada." });
    }
    const appointments = await db.appointment.findMany({
      where: { businessId: conversation.businessId, customerId: conversation.customerId },
      include: { service: { select: { name: true } }, professional: { select: { name: true } } },
      orderBy: { startsAt: "asc" },
    });
    return {
      id: conversation.id,
      timezone: conversation.business.timezone,
      mode: conversation.mode,
      handoffReason: conversation.handoffReason,
      customer: conversation.customer,
      messages: conversation.messages,
      appointments: appointments.map((appointment) => ({
        id: appointment.id,
        service: appointment.service.name,
        professional: appointment.professional.name,
        startsAt: appointment.startsAt,
        status: appointment.status,
      })),
    };
  });

  /** Apaga o cliente simulado e tudo dele, para recomeçar o teste do zero. */
  app.delete("/dev/simulator/conversations/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const conversation = await db.conversation.findUnique({
      where: { id },
      include: { channel: { select: { type: true } } },
    });
    if (conversation?.channel.type !== "simulator") {
      return reply.code(404).send({ error: "Conversa de simulação não encontrada." });
    }
    await db.$transaction([
      db.appointment.deleteMany({
        where: { businessId: conversation.businessId, customerId: conversation.customerId },
      }),
      db.customer.delete({ where: { id: conversation.customerId } }),
    ]);
    return reply.code(204).send();
  });
}
