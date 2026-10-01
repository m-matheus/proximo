import { ChannelError } from "@proximo/messaging";
import type { OutboundJob } from "@proximo/queue";
import type { WorkerDeps } from "./inbound";

export type OutboundOutcome = "sent" | "skipped" | "failed";

/**
 * Envia uma mensagem já gravada. Erro temporário vira nova tentativa do BullMQ;
 * erro definitivo, como mensagem fora da janela de 24h, fica registrado na mensagem.
 */
export async function handleOutbound(
  job: OutboundJob,
  deps: Pick<WorkerDeps, "db" | "channels" | "logger">,
): Promise<OutboundOutcome> {
  const message = await deps.db.message.findFirst({
    where: { id: job.messageId, businessId: job.businessId },
    include: { conversation: { include: { customer: true, channel: true } } },
  });
  if (message?.direction !== "outbound" || message.deliveryStatus !== "pending" || !message.body) {
    return "skipped";
  }
  const { customer, channel } = message.conversation;
  if (customer.anonymizedAt) {
    await deps.db.message.update({
      where: { id: message.id },
      data: { deliveryStatus: "failed", error: "Cliente anonimizado." },
    });
    return "failed";
  }

  try {
    const { externalId } = await deps.channels
      .get(channel)
      .sendText({ waId: customer.waId, waUserId: customer.waUserId }, message.body);
    await deps.db.message.update({
      where: { id: message.id },
      data: { externalId, deliveryStatus: "sent", error: null },
    });
    return "sent";
  } catch (error) {
    if (error instanceof ChannelError && !error.retryable) {
      await deps.db.message.update({
        where: { id: message.id },
        data: { deliveryStatus: "failed", error: error.message.slice(0, 500) },
      });
      deps.logger.warn(
        { businessId: job.businessId, messageId: message.id, code: error.code },
        "envio recusado pelo canal",
      );
      return "failed";
    }
    throw error;
  }
}
