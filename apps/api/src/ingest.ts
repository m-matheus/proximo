import { normalizePhoneE164 } from "@proximo/core";
import { type Db, isUniqueViolation, type Prisma } from "@proximo/db";
import type { EchoEvent, MessageKind, StatusEvent } from "@proximo/messaging";
import type { InboundJob } from "@proximo/queue";

/**
 * Entrada de mensagens. Grava o mínimo, de forma idempotente, e agenda o agente.
 * O webhook do WhatsApp e o simulador passam por aqui.
 */

export interface ChannelRef {
  id: string;
  businessId: string;
}

export interface InboundMessageInput {
  channel: ChannelRef;
  from: { waId: string | null; waUserId: string | null; profileName: string | null };
  externalId: string;
  timestamp: Date;
  kind: MessageKind;
  text: string | null;
  buttonPayload: string | null;
}

export interface IngestDeps {
  db: Db;
  enqueueInbound: (job: InboundJob) => Promise<void>;
  now?: () => Date;
}

export type IngestResult =
  | { status: "created"; conversationId: string; messageId: string }
  | { status: "duplicate" }
  | { status: "ignored"; reason: string };

type Identity = { waId: string | null; waUserId: string | null };

/** Acha ou cria o cliente pela identidade do WhatsApp. O BSUID é a chave durável. */
async function upsertCustomer(
  tx: Prisma.TransactionClient,
  businessId: string,
  identity: Identity,
  now: Date,
): Promise<{ id: string }> {
  const or: Prisma.CustomerWhereInput[] = [];
  if (identity.waUserId) {
    or.push({ waUserId: identity.waUserId });
  }
  if (identity.waId) {
    or.push({ waId: identity.waId });
  }
  const existing = await tx.customer.findFirst({
    where: { businessId, anonymizedAt: null, OR: or },
    orderBy: { createdAt: "asc" },
  });
  if (existing) {
    await tx.customer.update({
      where: { id: existing.id },
      data: {
        lastInteractionAt: now,
        // Completa a identidade quando a Meta passa a mandar o que faltava.
        ...(identity.waUserId && !existing.waUserId ? { waUserId: identity.waUserId } : {}),
        ...(identity.waId && !existing.waId
          ? { waId: identity.waId, phoneE164: normalizePhoneE164(identity.waId) }
          : {}),
      },
    });
    return existing;
  }
  return tx.customer.create({
    data: {
      businessId,
      waUserId: identity.waUserId,
      waId: identity.waId,
      phoneE164: identity.waId ? normalizePhoneE164(identity.waId) : null,
      lastInteractionAt: now,
    },
  });
}

async function upsertConversation(
  tx: Prisma.TransactionClient,
  channel: ChannelRef,
  customerId: string,
): Promise<{ id: string }> {
  return tx.conversation.upsert({
    where: {
      businessId_customerId_channelId: {
        businessId: channel.businessId,
        customerId,
        channelId: channel.id,
      },
    },
    update: {},
    create: { businessId: channel.businessId, customerId, channelId: channel.id },
  });
}

export async function ingestInboundMessage(
  deps: IngestDeps,
  input: InboundMessageInput,
): Promise<IngestResult> {
  if (input.kind === "reaction") {
    return { status: "ignored", reason: "reação" };
  }
  if (!input.from.waId && !input.from.waUserId) {
    return { status: "ignored", reason: "remetente sem identidade" };
  }
  const now = deps.now?.() ?? new Date();

  const write = () =>
    deps.db.$transaction(async (tx) => {
      const customer = await upsertCustomer(tx, input.channel.businessId, input.from, now);
      const conversation = await upsertConversation(tx, input.channel, customer.id);
      const message = await tx.message.create({
        data: {
          businessId: input.channel.businessId,
          conversationId: conversation.id,
          direction: "inbound",
          author: "customer",
          kind: input.kind,
          body: input.text,
          payload: {
            ...(input.buttonPayload ? { buttonPayload: input.buttonPayload } : {}),
            ...(input.from.profileName ? { profileName: input.from.profileName } : {}),
          },
          externalId: input.externalId,
        },
      });
      await tx.conversation.update({
        where: { id: conversation.id },
        data: { lastInboundAt: now, lastMessageAt: now },
      });
      return { conversationId: conversation.id, messageId: message.id };
    });

  let created: { conversationId: string; messageId: string };
  try {
    created = await write();
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
    const duplicate = await deps.db.message.findUnique({ where: { externalId: input.externalId } });
    if (duplicate) {
      return { status: "duplicate" };
    }
    // Dois webhooks criaram o mesmo cliente ao mesmo tempo: a segunda tentativa acha o existente.
    created = await write();
  }

  await deps.enqueueInbound({
    businessId: input.channel.businessId,
    conversationId: created.conversationId,
    messageId: created.messageId,
  });
  return { status: "created", ...created };
}

const STATUS_ORDER = { pending: 0, sent: 1, delivered: 2, read: 3, failed: 4 } as const;

/** Atualiza a entrega de uma mensagem enviada. Nunca volta um status para trás. */
export async function recordStatus(db: Db, channel: ChannelRef, event: StatusEvent): Promise<void> {
  const message = await db.message.findFirst({
    where: { businessId: channel.businessId, externalId: event.externalId },
    select: { id: true, deliveryStatus: true },
  });
  if (!message) {
    return;
  }
  const current = STATUS_ORDER[message.deliveryStatus ?? "pending"];
  if (event.status !== "failed" && STATUS_ORDER[event.status] <= current) {
    return;
  }
  const error =
    event.status === "failed"
      ? event.errors.map((item) => [item.code, item.title].filter(Boolean).join(" ")).join("; ") ||
        "Falha na entrega."
      : null;
  await db.message.update({
    where: { id: message.id },
    data: { deliveryStatus: event.status, ...(error ? { error } : {}) },
  });
  if (error) {
    // Um lembrete aceito pela Meta ainda pode não ser entregue, como em número inexistente.
    await db.notification.updateMany({
      where: { businessId: channel.businessId, messageId: message.id },
      data: { status: "failed", error },
    });
  }
}

/**
 * Mensagem que a equipe mandou pelo app WhatsApp Business (números com coexistência).
 * Grava no histórico e tira o agente da conversa por um tempo.
 */
export async function recordEcho(
  deps: { db: Db; humanModeHours: number; now?: () => Date },
  channel: ChannelRef,
  event: EchoEvent,
): Promise<void> {
  if (!event.to.waId && !event.to.waUserId) {
    return;
  }
  const now = deps.now?.() ?? new Date();
  try {
    await deps.db.$transaction(async (tx) => {
      const customer = await upsertCustomer(tx, channel.businessId, event.to, now);
      const conversation = await upsertConversation(tx, channel, customer.id);
      await tx.message.create({
        data: {
          businessId: channel.businessId,
          conversationId: conversation.id,
          direction: "outbound",
          author: "staff",
          kind: event.kind,
          body: event.text,
          externalId: event.externalId,
          deliveryStatus: "sent",
        },
      });
      await tx.conversation.update({
        where: { id: conversation.id },
        data: {
          mode: "human",
          handoffReason: "A equipe respondeu pelo WhatsApp.",
          humanUntil: new Date(now.getTime() + deps.humanModeHours * 60 * 60 * 1000),
          lastMessageAt: now,
        },
      });
    });
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
  }
}
