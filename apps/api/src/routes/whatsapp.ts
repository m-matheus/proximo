import type { Db } from "@proximo/db";
import { parseWhatsAppWebhook, verifyWhatsAppSignature } from "@proximo/messaging";
import type { InboundJob } from "@proximo/queue";
import type { FastifyInstance } from "fastify";
import { ingestInboundMessage, recordEcho, recordStatus } from "../ingest";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export interface WhatsAppRouteOptions {
  db: Db;
  appSecret: string;
  verifyToken: string;
  humanModeHours: number;
  enqueueInbound: (job: InboundJob) => Promise<void>;
}

/**
 * Webhook da WhatsApp Cloud API. Um único endpoint atende todos os negócios:
 * o phone_number_id de cada evento aponta o canal e, por ele, o negócio.
 */
export async function whatsappRoutes(
  app: FastifyInstance,
  options: WhatsAppRouteOptions,
): Promise<void> {
  // A assinatura da Meta é calculada sobre o corpo cru, então guardamos os bytes.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (request, body, done) => {
    const raw = body as Buffer;
    request.rawBody = raw;
    try {
      done(null, raw.length > 0 ? JSON.parse(raw.toString("utf8")) : {});
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  // Verificação feita pela Meta ao cadastrar o webhook.
  app.get("/webhooks/whatsapp", async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    if (
      options.verifyToken &&
      query["hub.mode"] === "subscribe" &&
      query["hub.verify_token"] === options.verifyToken
    ) {
      return reply.type("text/plain").send(query["hub.challenge"] ?? "");
    }
    return reply.code(403).send();
  });

  app.post("/webhooks/whatsapp", async (request, reply) => {
    const signature = request.headers["x-hub-signature-256"];
    if (
      !request.rawBody ||
      !verifyWhatsAppSignature(
        request.rawBody,
        typeof signature === "string" ? signature : undefined,
        options.appSecret,
      )
    ) {
      request.log.warn("webhook do WhatsApp com assinatura inválida");
      return reply.code(401).send();
    }

    const events = parseWhatsAppWebhook(request.body);
    const channels = new Map<string, { id: string; businessId: string } | null>();

    for (const event of events) {
      if (!channels.has(event.phoneNumberId)) {
        const channel = await options.db.channel.findUnique({
          where: { type_externalId: { type: "whatsapp_cloud", externalId: event.phoneNumberId } },
          select: { id: true, businessId: true, status: true },
        });
        channels.set(event.phoneNumberId, channel?.status === "active" ? channel : null);
      }
      const channel = channels.get(event.phoneNumberId);
      if (!channel) {
        request.log.warn(
          { phoneNumberId: event.phoneNumberId },
          "evento de número sem canal ativo",
        );
        continue;
      }

      if (event.type === "message") {
        const result = await ingestInboundMessage(
          { db: options.db, enqueueInbound: options.enqueueInbound },
          {
            channel,
            from: event.from,
            externalId: event.externalId,
            timestamp: event.timestamp,
            kind: event.kind,
            text: event.text,
            buttonPayload: event.buttonPayload,
          },
        );
        request.log.info(
          { businessId: channel.businessId, status: result.status },
          "mensagem recebida",
        );
      } else if (event.type === "status") {
        await recordStatus(options.db, channel, event);
      } else {
        await recordEcho(
          { db: options.db, humanModeHours: options.humanModeHours },
          channel,
          event,
        );
        request.log.info({ businessId: channel.businessId }, "resposta da equipe pelo app");
      }
    }

    // Responder rápido: o trabalho pesado fica com o worker.
    return reply.code(200).send({ ok: true });
  });
}
