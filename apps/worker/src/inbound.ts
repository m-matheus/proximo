import {
  type AgentConfig,
  type AgentTurnResult,
  type BetaMessageParam,
  type BusinessContext,
  buildCarryOver,
  buildCatalog,
  buildSystemPrompt,
  buildTools,
  type CarryOverMessage,
  computeAgentVersion,
  type LlmClient,
  parseAgentState,
  runAgentTurn,
  sessionRotationReason,
} from "@proximo/agent";
import { localDateString } from "@proximo/core";
import type { Business, Db, Message, Prisma } from "@proximo/db";
import {
  acquireLock,
  conversationLockKey,
  type InboundJob,
  incrementCounter,
  type OutboundJob,
  type Redis,
  releaseLock,
} from "@proximo/queue";
import type { SchedulingProvider } from "@proximo/scheduling";
import { createSchedulingProvider } from "@proximo/scheduling/factory";
import type { ChannelRegistry } from "./channels";
import { type ButtonOutcome, resolveReminderButtons } from "./reminder-buttons";

/**
 * Processa as mensagens de um cliente: decide se o agente responde, roda o turno,
 * grava tudo numa transação e agenda o envio da resposta.
 */

export interface Logger {
  info(object: object, message: string): void;
  warn(object: object, message: string): void;
  error(object: object, message: string): void;
}

export interface WorkerDeps {
  db: Db;
  redis: Redis;
  llm: LlmClient;
  agentConfig: AgentConfig;
  channels: ChannelRegistry;
  enqueueOutbound: (job: OutboundJob) => Promise<void>;
  encryptionKey?: Buffer;
  settings: {
    sessionIdleHours: number;
    humanModeHours: number;
    maxRunsPerCustomerPerDay: number;
    maxSessionMessages: number;
  };
  now: () => Date;
  logger: Logger;
  /** Agenda do negócio. Sem isto, usa a configurada no negócio; os testes injetam outra. */
  providerFor?: (business: Business) => SchedulingProvider;
}

export function schedulingProviderFor(
  deps: Pick<WorkerDeps, "db" | "now" | "encryptionKey" | "providerFor">,
  business: Business,
): SchedulingProvider {
  return (
    deps.providerFor?.(business) ??
    createSchedulingProvider(business, {
      db: deps.db,
      now: deps.now,
      ...(deps.encryptionKey ? { encryptionKey: deps.encryptionKey } : {}),
    })
  );
}

/** Outro job está atendendo a mesma conversa. O processador reagenda este. */
export class ConversationBusyError extends Error {
  constructor() {
    super("Conversa ocupada por outro job.");
    this.name = "ConversationBusyError";
  }
}

export type InboundOutcome =
  | "missing"
  | "superseded"
  | "inactive"
  | "nothing"
  | "human"
  | "unsupported_media"
  | "rate_limited"
  | "schedule_unavailable"
  | "reminder_button"
  | "agent";

const LOCK_TTL_MS = 5 * 60 * 1000;
const UNREADABLE_KINDS = new Set([
  "audio",
  "image",
  "video",
  "document",
  "sticker",
  "location",
  "other",
]);

export const CANNED_REPLIES = {
  unsupportedMedia: "Oi! Por enquanto eu só consigo ler mensagens de texto. Pode me escrever?",
  rateLimited: "Vou pedir pra alguém da equipe continuar o atendimento contigo, tá?",
  scheduleUnavailable:
    "Opa, não estou conseguindo acessar a agenda agora. Vou pedir pra alguém da equipe te responder, tá?",
  technicalFailure:
    "Desculpa, estou com um probleminha técnico. Vou pedir pra alguém da equipe te responder, tá?",
} as const;

/** Transforma cada mensagem num texto que o agente entende, sem guardar mídia. */
export function describeInbound(message: Pick<Message, "kind" | "body">): string {
  const body = message.body?.trim() ?? "";
  switch (message.kind) {
    case "text":
    case "button":
    case "interactive":
      return body;
    case "audio":
      return "[o cliente mandou um áudio, que você não consegue ouvir]";
    case "image":
      return body
        ? `[imagem com a legenda: ${body}]`
        : "[o cliente mandou uma imagem, que você não consegue ver]";
    case "video":
      return body
        ? `[vídeo com a legenda: ${body}]`
        : "[o cliente mandou um vídeo, que você não consegue ver]";
    case "document":
      return "[o cliente mandou um documento, que você não consegue abrir]";
    case "sticker":
      return "[figurinha]";
    case "location":
      return "[o cliente mandou uma localização]";
    default:
      return "[mensagem de um tipo que você não consegue ler]";
  }
}

export async function handleInbound(job: InboundJob, deps: WorkerDeps): Promise<InboundOutcome> {
  const trigger = await deps.db.message.findFirst({
    where: { id: job.messageId, businessId: job.businessId },
    select: { createdAt: true },
  });
  if (!trigger) {
    return "missing";
  }
  // Espera por mensagens picadas: se o cliente mandou outra depois desta, o job da última responde tudo.
  const newer = await deps.db.message.findFirst({
    where: {
      conversationId: job.conversationId,
      direction: "inbound",
      createdAt: { gt: trigger.createdAt },
    },
    select: { id: true },
  });
  if (newer) {
    return "superseded";
  }

  const lockKey = conversationLockKey(job.conversationId);
  const token = await acquireLock(deps.redis, lockKey, LOCK_TTL_MS);
  if (!token) {
    throw new ConversationBusyError();
  }
  try {
    return await processConversation(job, deps);
  } finally {
    await releaseLock(deps.redis, lockKey, token);
  }
}

async function loadConversation(db: Db, job: InboundJob) {
  return db.conversation.findFirst({
    where: { id: job.conversationId, businessId: job.businessId },
    include: { business: true, customer: true, channel: true },
  });
}

type LoadedConversation = NonNullable<Awaited<ReturnType<typeof loadConversation>>>;

async function pendingMessages(db: Db, conversationId: string) {
  return db.message.findMany({
    where: { conversationId, direction: "inbound", handledAt: null },
    orderBy: { createdAt: "asc" },
  });
}

/** Resposta sem passar pelo agente, como mídia que ele não lê ou falha técnica. */
async function replyDirectly(
  deps: WorkerDeps,
  conversation: LoadedConversation,
  pendingIds: string[],
  text: string,
  handoffReason: string | null,
): Promise<void> {
  const now = deps.now();
  const outboundId = await deps.db.$transaction(async (tx) => {
    const outbound = await tx.message.create({
      data: {
        businessId: conversation.businessId,
        conversationId: conversation.id,
        direction: "outbound",
        author: "agent",
        kind: "text",
        body: text,
        deliveryStatus: "pending",
      },
    });
    await tx.message.updateMany({ where: { id: { in: pendingIds } }, data: { handledAt: now } });
    await tx.conversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: now,
        ...(handoffReason ? handoffData(handoffReason, now, deps.settings.humanModeHours) : {}),
      },
    });
    if (handoffReason) {
      await tx.auditLog.create({
        data: {
          businessId: conversation.businessId,
          actorType: "system",
          action: "conversation.handoff",
          entityType: "conversation",
          entityId: conversation.id,
          metadata: { reason: handoffReason },
        },
      });
    }
    return outbound.id;
  });
  await deps.enqueueOutbound({ businessId: conversation.businessId, messageId: outboundId });
}

function handoffData(reason: string, now: Date, hours: number): Prisma.ConversationUpdateInput {
  return {
    mode: "human",
    handoffReason: reason,
    humanUntil: new Date(now.getTime() + hours * 60 * 60 * 1000),
  };
}

async function processConversation(job: InboundJob, deps: WorkerDeps): Promise<InboundOutcome> {
  const { db } = deps;
  const now = deps.now();
  const conversation = await loadConversation(db, job);
  if (conversation?.business.status !== "active" || conversation.customer.anonymizedAt) {
    return "inactive";
  }

  const received = await pendingMessages(db, conversation.id);
  if (received.length === 0) {
    return "nothing";
  }

  // Botões do lembrete: confirmar e cancelar se resolvem aqui, sem o Claude, mesmo com a
  // conversa na equipe. Remarcar segue para o agente, descrito com o horário.
  const buttons = received.some((message) => message.kind === "button")
    ? await resolveReminderButtons(
        {
          db,
          provider: schedulingProviderFor(deps, conversation.business),
          business: conversation.business,
          customerId: conversation.customerId,
          now,
        },
        received,
      )
    : new Map<string, ButtonOutcome>();
  const descriptions = new Map<string, string>();
  for (const [messageId, outcome] of buttons) {
    if (outcome.type === "reply") {
      await replyDirectly(deps, conversation, [messageId], outcome.text, outcome.handoff);
      const externalId = received.find((message) => message.id === messageId)?.externalId;
      if (externalId && conversation.channel.type === "whatsapp_cloud") {
        deps.channels
          .get(conversation.channel)
          .markAsRead(externalId)
          .catch((error: unknown) => {
            deps.logger.warn({ error: String(error) }, "não foi possível marcar como lida");
          });
      }
    } else {
      descriptions.set(messageId, outcome.description);
    }
  }
  const pending = received.filter((message) => buttons.get(message.id)?.type !== "reply");
  if (pending.length === 0) {
    return "reminder_button";
  }
  const pendingIds = pending.map((message) => message.id);

  // Conversa com a equipe: o agente fica quieto até o prazo acabar.
  if (conversation.mode === "human") {
    if (!conversation.humanUntil || conversation.humanUntil > now) {
      await db.message.updateMany({ where: { id: { in: pendingIds } }, data: { handledAt: now } });
      return "human";
    }
    // Prazo acabou: volta para o agente, numa sessão nova que enxerga o que a equipe falou.
    await db.$transaction([
      db.conversation.update({
        where: { id: conversation.id },
        data: { mode: "agent", humanUntil: null, handoffReason: null, assignedUserId: null },
      }),
      db.agentSession.updateMany({
        where: { conversationId: conversation.id, status: "active" },
        data: { status: "closed", closeReason: "handback", closedAt: now },
      }),
    ]);
  }

  if (pending.every((message) => UNREADABLE_KINDS.has(message.kind) && !message.body?.trim())) {
    await replyDirectly(deps, conversation, pendingIds, CANNED_REPLIES.unsupportedMedia, null);
    return "unsupported_media";
  }

  const timezone = conversation.business.timezone;
  const runs = await incrementCounter(
    deps.redis,
    `proximo:agent-runs:${conversation.customerId}:${localDateString(now, timezone)}`,
    36 * 60 * 60,
  );
  if (runs > deps.settings.maxRunsPerCustomerPerDay) {
    if (runs === deps.settings.maxRunsPerCustomerPerDay + 1) {
      await replyDirectly(
        deps,
        conversation,
        pendingIds,
        CANNED_REPLIES.rateLimited,
        "Limite diário de atendimento automático.",
      );
    } else {
      await db.message.updateMany({ where: { id: { in: pendingIds } }, data: { handledAt: now } });
    }
    return "rate_limited";
  }

  const provider = schedulingProviderFor(deps, conversation.business);

  let catalogData: Awaited<ReturnType<typeof loadCatalog>>;
  try {
    catalogData = await loadCatalog(provider);
  } catch (error) {
    deps.logger.error(
      { businessId: conversation.businessId, error: String(error) },
      "agenda indisponível para o agente",
    );
    await replyDirectly(
      deps,
      conversation,
      pendingIds,
      CANNED_REPLIES.scheduleUnavailable,
      "A agenda não respondeu.",
    );
    return "schedule_unavailable";
  }

  const business: BusinessContext = {
    name: conversation.business.name,
    segment: conversation.business.segment,
    timezone,
    address: conversation.business.address,
    agentName: conversation.business.agentName,
    agentInstructions: conversation.business.agentInstructions,
    minLeadMinutes: conversation.business.minLeadMinutes,
    maxAdvanceDays: conversation.business.maxAdvanceDays,
    openingHours: catalogData.openingHours,
  };
  const catalog = buildCatalog(catalogData.services, catalogData.professionals);
  const systemPrompt = buildSystemPrompt(business, catalog);
  const tools = buildTools(catalog);
  const agentVersion = computeAgentVersion(deps.agentConfig.model, systemPrompt, tools);

  const session = await db.agentSession.findFirst({
    where: { conversationId: conversation.id, status: "active" },
    orderBy: { startedAt: "desc" },
  });
  const storedTranscript = (session?.transcript ?? []) as unknown as BetaMessageParam[];
  const rotation = sessionRotationReason(
    session
      ? {
          agentVersion: session.agentVersion,
          lastActivityAt: session.lastActivityAt,
          messageCount: storedTranscript.length,
        }
      : null,
    agentVersion,
    now,
    { idleHours: deps.settings.sessionIdleHours, maxMessages: deps.settings.maxSessionMessages },
  );

  let carryOver: string | null = null;
  if (rotation) {
    const [upcoming, recent] = await Promise.all([
      provider
        .findCustomerAppointments({
          customer: { id: conversation.customerId, phoneE164: conversation.customer.phoneE164 },
        })
        .catch(() => []),
      db.message.findMany({
        where: { conversationId: conversation.id, id: { notIn: pendingIds }, body: { not: null } },
        orderBy: { createdAt: "desc" },
        take: 8,
        select: { author: true, body: true },
      }),
    ]);
    const history: CarryOverMessage[] = recent
      .reverse()
      .filter((message) => message.author !== "system" && message.body)
      .map((message) => ({
        author: message.author as CarryOverMessage["author"],
        text: message.body ?? "",
      }));
    if (upcoming.length > 0 || history.length > 0) {
      carryOver = buildCarryOver({ upcoming, recent: history, timezone });
    }
  }

  const channel = deps.channels.get(conversation.channel);
  const lastExternalId = pending.at(-1)?.externalId;
  if (lastExternalId && conversation.channel.type === "whatsapp_cloud") {
    channel.markAsRead(lastExternalId, { typing: true }).catch((error: unknown) => {
      deps.logger.warn({ error: String(error) }, "não foi possível marcar como lida");
    });
  }

  const profileName =
    (pending.at(-1)?.payload as { profileName?: string } | null)?.profileName ?? null;
  const started = Date.now();
  const result: AgentTurnResult = await runAgentTurn({
    llm: deps.llm,
    config: deps.agentConfig,
    provider,
    catalog,
    timezone,
    systemPrompt,
    tools,
    transcript: rotation ? [] : storedTranscript,
    state: parseAgentState(conversation.agentState),
    customer: {
      id: conversation.customerId,
      name: conversation.customer.name,
      phoneE164: conversation.customer.phoneE164,
      profileName,
    },
    customerMessages: pending
      .map((message) => descriptions.get(message.id) ?? describeInbound(message))
      .filter(Boolean),
    carryOver,
    now,
    saveState: async (state) => {
      await db.conversation.update({ where: { id: conversation.id }, data: { agentState: state } });
    },
  });
  const latencyMs = Date.now() - started;

  if (result.inputTransformations.length > 0) {
    deps.logger.warn(
      { conversationId: conversation.id, transformations: result.inputTransformations },
      "a API alterou o histórico enviado; verifique se o histórico continua só-acréscimo",
    );
  }

  const outboundId = await db.$transaction(async (tx) => {
    let sessionId: string;
    if (rotation) {
      if (session) {
        await tx.agentSession.update({
          where: { id: session.id },
          data: { status: "closed", closeReason: rotation, closedAt: now },
        });
      }
      const created = await tx.agentSession.create({
        data: {
          businessId: conversation.businessId,
          conversationId: conversation.id,
          model: deps.agentConfig.model,
          agentVersion,
          systemPrompt,
          transcript: result.appended as unknown as Prisma.InputJsonValue,
          startedAt: now,
          lastActivityAt: now,
        },
      });
      sessionId = created.id;
    } else if (session) {
      await tx.agentSession.update({
        where: { id: session.id },
        data: {
          transcript: [...storedTranscript, ...result.appended] as unknown as Prisma.InputJsonValue,
          lastActivityAt: now,
        },
      });
      sessionId = session.id;
    } else {
      throw new Error("Sessão ausente sem rotação: estado impossível.");
    }

    const outbound = await tx.message.create({
      data: {
        businessId: conversation.businessId,
        conversationId: conversation.id,
        direction: "outbound",
        author: "agent",
        kind: "text",
        body: result.reply,
        deliveryStatus: "pending",
      },
    });
    await tx.message.updateMany({ where: { id: { in: pendingIds } }, data: { handledAt: now } });
    await tx.conversation.update({
      where: { id: conversation.id },
      data: {
        agentState: result.state,
        lastMessageAt: now,
        ...(result.handoff
          ? handoffData(result.handoff.reason, now, deps.settings.humanModeHours)
          : {}),
      },
    });
    await tx.agentRun.create({
      data: {
        businessId: conversation.businessId,
        sessionId,
        model: deps.agentConfig.model,
        requests: result.usage.requests,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cacheReadTokens: result.usage.cacheReadTokens,
        cacheWriteTokens: result.usage.cacheWriteTokens,
        toolCalls: result.toolCalls as unknown as Prisma.InputJsonValue,
        stopReason: result.stopReason,
        latencyMs,
        error: result.outcome === "replied" ? null : result.outcome,
      },
    });
    if (result.handoff) {
      await tx.auditLog.create({
        data: {
          businessId: conversation.businessId,
          actorType: "agent",
          action: "conversation.handoff",
          entityType: "conversation",
          entityId: conversation.id,
          metadata: { reason: result.handoff.reason },
        },
      });
    }
    return outbound.id;
  });

  await deps.enqueueOutbound({ businessId: conversation.businessId, messageId: outboundId });
  deps.logger.info(
    {
      businessId: conversation.businessId,
      conversationId: conversation.id,
      outcome: result.outcome,
      rotation,
      requests: result.usage.requests,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadTokens: result.usage.cacheReadTokens,
      tools: result.toolCalls.map((call) => `${call.name}${call.isError ? "!" : ""}`),
      handoff: Boolean(result.handoff),
      latencyMs,
    },
    "turno do agente concluído",
  );
  return "agent";
}

async function loadCatalog(provider: SchedulingProvider) {
  const [services, professionals, openingHours] = await Promise.all([
    provider.listServices(),
    provider.listProfessionals(),
    provider.getOpeningHours(),
  ]);
  return { services, professionals, openingHours };
}

/**
 * Última tentativa falhou (por exemplo, a API da Anthropic fora do ar):
 * avisa o cliente e passa a conversa para a equipe.
 */
export async function giveUpInbound(job: InboundJob, deps: WorkerDeps): Promise<void> {
  const conversation = await loadConversation(deps.db, job);
  if (!conversation) {
    return;
  }
  const pending = await pendingMessages(deps.db, conversation.id);
  if (pending.length === 0) {
    return;
  }
  await replyDirectly(
    deps,
    conversation,
    pending.map((message) => message.id),
    CANNED_REPLIES.technicalFailure,
    "Falha técnica no agente.",
  );
}
