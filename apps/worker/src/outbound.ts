import type { Db } from "@proximo/db";
import { ChannelError, type TemplateMessage } from "@proximo/messaging";
import type { OutboundJob } from "@proximo/queue";
import { z } from "zod";
import type { WorkerDeps } from "./inbound";

export type OutboundOutcome = "sent" | "skipped" | "failed";

const templatePayloadSchema = z.object({
  template: z.object({
    name: z.string().min(1),
    languageCode: z.string().min(1),
    bodyParameters: z.array(z.string()).optional(),
    quickReplyPayloads: z.array(z.string()).optional(),
  }),
});

function templateOf(payload: unknown): TemplateMessage | null {
  const parsed = templatePayloadSchema.safeParse(payload);
  return parsed.success ? parsed.data.template : null;
}

/** O lembrete acompanha o envio da mensagem que o carrega. */
async function settleNotification(
  db: Db,
  messageId: string,
  result: { sentAt: Date } | { error: string },
): Promise<void> {
  await db.notification.updateMany({
    where: { messageId },
    data:
      "sentAt" in result
        ? { status: "sent", sentAt: result.sentAt, error: null }
        : { status: "failed", error: result.error },
  });
}

/**
 * Envia uma mensagem já gravada, texto ou template. Erro temporário vira nova tentativa
 * do BullMQ; erro definitivo, como mensagem fora da janela de 24h, fica registrado na mensagem.
 */
export async function handleOutbound(
  job: OutboundJob,
  deps: Pick<WorkerDeps, "db" | "channels" | "logger" | "now">,
): Promise<OutboundOutcome> {
  const message = await deps.db.message.findFirst({
    where: { id: job.messageId, businessId: job.businessId },
    include: { conversation: { include: { customer: true, channel: true } } },
  });
  if (message?.direction !== "outbound" || message.deliveryStatus !== "pending" || !message.body) {
    return "skipped";
  }
  const fail = async (error: string): Promise<OutboundOutcome> => {
    await deps.db.message.update({
      where: { id: message.id },
      data: { deliveryStatus: "failed", error: error.slice(0, 500) },
    });
    await settleNotification(deps.db, message.id, { error: error.slice(0, 500) });
    return "failed";
  };

  const { customer, channel } = message.conversation;
  if (customer.anonymizedAt) {
    return fail("Cliente anonimizado.");
  }
  const template = message.kind === "template" ? templateOf(message.payload) : null;
  if (message.kind === "template" && !template) {
    return fail("Template sem os dados de envio.");
  }

  const to = { waId: customer.waId, waUserId: customer.waUserId };
  try {
    const sender = deps.channels.get(channel);
    const { externalId } = template
      ? await sender.sendTemplate(to, template)
      : await sender.sendText(to, message.body);
    await deps.db.message.update({
      where: { id: message.id },
      data: { externalId, deliveryStatus: "sent", error: null },
    });
    await settleNotification(deps.db, message.id, { sentAt: deps.now() });
    return "sent";
  } catch (error) {
    if (error instanceof ChannelError && !error.retryable) {
      deps.logger.warn(
        { businessId: job.businessId, messageId: message.id, code: error.code },
        "envio recusado pelo canal",
      );
      return fail(error.message);
    }
    throw error;
  }
}
