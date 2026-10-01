import { randomUUID } from "node:crypto";
import { type BetaMessageParam, DEFAULT_AGENT_CONFIG } from "@proximo/agent";
import { ScriptedLlm, textReply, toolCall } from "@proximo/agent/testing";
import { loadRootEnv, localDateTimeToDate } from "@proximo/core";
import { type MessageKind, seedDemoBusiness } from "@proximo/db";
import { createTestDb, resetTestDatabase } from "@proximo/db/testing";
import { SimulatorChannel } from "@proximo/messaging";
import {
  acquireLock,
  conversationLockKey,
  createRedis,
  type OutboundJob,
  releaseLock,
} from "@proximo/queue";
import { CONTRACT_NOW } from "@proximo/scheduling/testing";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ChannelRegistry } from "../src/channels";
import {
  CANNED_REPLIES,
  ConversationBusyError,
  handleInbound,
  type WorkerDeps,
} from "../src/inbound";
import { handleOutbound } from "../src/outbound";

loadRootEnv();
const db = createTestDb();
const redis = createRedis(process.env.REDIS_URL ?? "redis://localhost:6379");
const TZ = "America/Sao_Paulo";

afterAll(async () => {
  await db.$disconnect();
  await redis.quit();
});

let llm: ScriptedLlm;
let simulator: SimulatorChannel;
let outboundJobs: OutboundJob[];
let deps: WorkerDeps;
let businessId: string;
let conversationId: string;
let customerId: string;
let clock: number;

const silent = { info() {}, warn() {}, error() {} };

async function inbound(text: string | null, kind: MessageKind = "text") {
  clock += 1_000;
  return db.message.create({
    data: {
      businessId,
      conversationId,
      direction: "inbound",
      author: "customer",
      kind,
      body: text,
      externalId: `sim.${randomUUID()}`,
      payload: { profileName: "Ana" },
      createdAt: new Date(clock),
    },
  });
}

async function run(messageId: string) {
  return handleInbound({ businessId, conversationId, messageId }, deps);
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
  const conversation = await db.conversation.create({
    data: { businessId, customerId, channelId: demo.simulatorChannelId },
  });
  conversationId = conversation.id;
  clock = Date.now();

  llm = new ScriptedLlm();
  simulator = new SimulatorChannel();
  outboundJobs = [];
  deps = {
    db,
    redis,
    llm,
    agentConfig: DEFAULT_AGENT_CONFIG,
    channels: new ChannelRegistry({ graphApiVersion: "v26.0", simulator }),
    enqueueOutbound: async (job) => {
      outboundJobs.push(job);
    },
    settings: {
      sessionIdleHours: 6,
      humanModeHours: 12,
      maxRunsPerCustomerPerDay: 40,
      maxSessionMessages: 80,
    },
    now: () => CONTRACT_NOW,
    logger: silent,
  };
});

describe("fluxo mínimo: mensagem, agente, agenda e resposta", () => {
  it("agenda com confirmação e responde pelo canal", async () => {
    llm.push(
      toolCall("check_availability", {
        service: "s1",
        professional: "p1",
        date_from: "2026-10-01",
        days: 1,
        period: "afternoon",
      }),
      toolCall("propose_appointment", {
        service: "s1",
        professional: "p1",
        date: "2026-10-01",
        time: "15:00",
        customer_name: "Ana",
        notes: null,
      }),
      textReply("Tenho quinta, 01/10, às 15:00 com o Carlos. Posso confirmar?"),
    );
    const first = await inbound("oi, sou a Ana e quero cortar quinta à tarde com o Carlos");
    expect(await run(first.id)).toBe("agent");

    // A resposta foi gravada, marcada para envio e as mensagens do cliente foram tratadas.
    const reply = await db.message.findFirstOrThrow({ where: { direction: "outbound" } });
    expect(reply).toMatchObject({
      author: "agent",
      body: "Tenho quinta, 01/10, às 15:00 com o Carlos. Posso confirmar?",
      deliveryStatus: "pending",
    });
    expect(outboundJobs).toEqual([{ businessId, messageId: reply.id }]);
    expect(
      (await db.message.findUniqueOrThrow({ where: { id: first.id } })).handledAt,
    ).not.toBeNull();
    expect(await db.appointment.count()).toBe(0);

    // O envio usa o canal da conversa.
    expect(await handleOutbound({ businessId, messageId: reply.id }, deps)).toBe("sent");
    expect(simulator.sent[0]?.text).toBe(reply.body);
    expect((await db.message.findUniqueOrThrow({ where: { id: reply.id } })).externalId).toMatch(
      /^sim\./,
    );

    const sessionAfterFirst = await db.agentSession.findFirstOrThrow();
    const transcriptAfterFirst = sessionAfterFirst.transcript as unknown as BetaMessageParam[];

    llm.push(toolCall("confirm_proposal", {}), textReply("Fechado, Ana! Te espero quinta às 15h."));
    const second = await inbound("pode confirmar");
    expect(await run(second.id)).toBe("agent");

    const appointment = await db.appointment.findFirstOrThrow({
      include: { professional: true, customer: true },
    });
    expect(appointment.startsAt.getTime()).toBe(
      localDateTimeToDate("2026-10-01", "15:00", TZ)?.getTime(),
    );
    expect(appointment.professional.name).toBe("Carlos");
    expect(appointment.customer.name).toBe("Ana");
    expect(appointment.source).toBe("agent");

    // Mesma sessão, histórico só com acréscimos, e custo registrado por turno.
    const sessions = await db.agentSession.findMany();
    expect(sessions).toHaveLength(1);
    const secondRequest = llm.requests[3];
    expect(secondRequest?.messages.slice(0, transcriptAfterFirst.length)).toEqual(
      transcriptAfterFirst,
    );
    expect(await db.agentRun.count()).toBe(2);
    const conversation = await db.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(conversation.mode).toBe("agent");
  });

  it("junta mensagens picadas numa resposta só", async () => {
    const first = await inbound("oi");
    const second = await inbound("queria cortar amanhã");
    llm.push(textReply("Oi! Tenho horários sim."));

    expect(await run(first.id)).toBe("superseded");
    expect(await run(second.id)).toBe("agent");

    expect(llm.requests).toHaveLength(1);
    const userTurn = llm.requests[0]?.messages[0];
    expect(JSON.stringify(userTurn?.content)).toContain("oi\\nqueria cortar amanhã");
  });

  it("não responde enquanto a equipe cuida da conversa", async () => {
    await db.conversation.update({
      where: { id: conversationId },
      data: { mode: "human", humanUntil: new Date(CONTRACT_NOW.getTime() + 60 * 60 * 1000) },
    });
    const message = await inbound("oi?");
    expect(await run(message.id)).toBe("human");
    expect(llm.requests).toHaveLength(0);
    expect(
      (await db.message.findUniqueOrThrow({ where: { id: message.id } })).handledAt,
    ).not.toBeNull();
  });

  it("volta ao agente quando o prazo da equipe acaba", async () => {
    await db.conversation.update({
      where: { id: conversationId },
      data: { mode: "human", humanUntil: new Date(CONTRACT_NOW.getTime() - 1_000) },
    });
    const message = await inbound("alguém aí?");
    llm.push(textReply("Oi! Posso ajudar?"));
    expect(await run(message.id)).toBe("agent");
    expect((await db.conversation.findUniqueOrThrow({ where: { id: conversationId } })).mode).toBe(
      "agent",
    );
  });

  it("pede texto quando o cliente só manda áudio, sem chamar o Claude", async () => {
    const message = await inbound(null, "audio");
    expect(await run(message.id)).toBe("unsupported_media");
    expect(llm.requests).toHaveLength(0);
    const reply = await db.message.findFirstOrThrow({ where: { direction: "outbound" } });
    expect(reply.body).toBe(CANNED_REPLIES.unsupportedMedia);
  });

  it("passa para a equipe quando o agente pede ajuda", async () => {
    const message = await inbound("quero falar com o dono");
    llm.push(
      toolCall("handoff_to_human", { reason: "cliente pediu o dono" }),
      textReply("Já chamo alguém da equipe!"),
    );
    expect(await run(message.id)).toBe("agent");
    const conversation = await db.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(conversation.mode).toBe("human");
    expect(conversation.handoffReason).toBe("cliente pediu o dono");
    expect(await db.auditLog.count({ where: { action: "conversation.handoff" } })).toBe(1);
  });

  it("espera quando outro job está atendendo a mesma conversa", async () => {
    const message = await inbound("oi");
    const token = await acquireLock(redis, conversationLockKey(conversationId), 5_000);
    await expect(run(message.id)).rejects.toBeInstanceOf(ConversationBusyError);
    await releaseLock(redis, conversationLockKey(conversationId), token ?? "");
  });

  it("abre sessão nova com resumo quando a configuração do negócio muda", async () => {
    llm.push(textReply("Oi!"));
    await run((await inbound("oi")).id);
    await db.business.update({
      where: { id: businessId },
      data: { agentInstructions: "Aceitamos Pix." },
    });

    llm.push(textReply("Aceitamos Pix sim."));
    await run((await inbound("aceita pix?")).id);

    const sessions = await db.agentSession.findMany({ orderBy: { startedAt: "asc" } });
    expect(sessions.map((session) => [session.status, session.closeReason])).toEqual([
      ["closed", "config_changed"],
      ["active", null],
    ]);
    const context = llm.requests[1]?.messages[1];
    expect(context?.role).toBe("system");
    expect(JSON.stringify(context?.content)).toContain("continua uma conversa anterior");
  });
});
