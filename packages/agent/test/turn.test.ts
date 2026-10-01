import { localDateTimeToDate } from "@proximo/core";
import { CONTRACT_NOW, demoCatalog, InMemorySchedulingProvider } from "@proximo/scheduling/testing";
import { describe, expect, it } from "vitest";
import { buildCatalog } from "../src/catalog";
import { type AgentConfig, DEFAULT_AGENT_CONFIG } from "../src/config";
import type { BetaMessageParam } from "../src/llm";
import { type BusinessContext, buildSystemPrompt } from "../src/prompt";
import { type AgentState, initialAgentState } from "../src/state";
import { refusalReply, ScriptedLlm, textReply, toolCall } from "../src/testing";
import { buildTools, executeTool, type ToolContext } from "../src/tools";
import { type AgentTurnResult, FALLBACK_REPLIES, runAgentTurn } from "../src/turn";

const TZ = "America/Sao_Paulo";

function at(date: string, time: string): Date {
  const instant = localDateTimeToDate(date, time, TZ);
  if (!instant) {
    throw new Error("data inválida");
  }
  return instant;
}

async function setup(
  options: { config?: Partial<AgentConfig>; customerName?: string | null } = {},
) {
  const provider = new InMemorySchedulingProvider(demoCatalog(), () => CONTRACT_NOW);
  const catalog = buildCatalog(await provider.listServices(), await provider.listProfessionals());
  const business: BusinessContext = {
    name: "Barbearia Exemplo",
    segment: "barbershop",
    timezone: TZ,
    address: null,
    agentName: null,
    agentInstructions: null,
    minLeadMinutes: 60,
    maxAdvanceDays: 30,
    openingHours: await provider.getOpeningHours(),
  };
  const llm = new ScriptedLlm();
  const saved: AgentState[] = [];
  const config: AgentConfig = { ...DEFAULT_AGENT_CONFIG, ...options.config };
  let transcript: BetaMessageParam[] = [];
  let state = initialAgentState();
  const customer = {
    id: "cust-ana",
    name: options.customerName === undefined ? null : options.customerName,
    phoneE164: "+5551999998888",
    profileName: "Aninha",
  };

  async function turn(...messages: string[]): Promise<AgentTurnResult> {
    const result = await runAgentTurn({
      llm,
      config,
      provider,
      catalog,
      timezone: TZ,
      systemPrompt: buildSystemPrompt(business, catalog),
      tools: buildTools(catalog),
      transcript,
      state,
      customer,
      customerMessages: messages,
      carryOver: null,
      now: CONTRACT_NOW,
      saveState: async (value) => {
        saved.push(structuredClone(value));
      },
    });
    transcript = [...transcript, ...result.appended];
    state = result.state;
    return result;
  }

  return {
    provider,
    catalog,
    llm,
    saved,
    turn,
    getTranscript: () => transcript,
    getState: () => state,
  };
}

function lastToolResults(
  messages: BetaMessageParam[],
): Array<{ content: string; is_error?: boolean }> {
  const last = messages.at(-1);
  if (!last || !Array.isArray(last.content)) {
    return [];
  }
  return last.content.filter((block) => block.type === "tool_result") as never;
}

describe("runAgentTurn", () => {
  it("consulta, propõe e só grava depois de uma nova mensagem do cliente", async () => {
    const t = await setup();
    t.llm.push(
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
      // O modelo tenta confirmar no mesmo turno: o código não deixa.
      toolCall("confirm_proposal", {}),
      textReply("Posso confirmar o corte com o Carlos na quinta, 01/10, às 15:00?"),
    );

    const first = await t.turn("Oi! Queria cortar quinta à tarde com o Carlos. Meu nome é Ana");

    expect(first.outcome).toBe("replied");
    expect(first.reply).toContain("Posso confirmar");
    expect(t.provider.appointments).toHaveLength(0);
    expect(first.state.pending?.type).toBe("create");
    expect(first.toolCalls.map((call) => [call.name, call.isError])).toEqual([
      ["check_availability", false],
      ["propose_appointment", false],
      ["confirm_proposal", true],
    ]);

    const availability = lastToolResults(t.llm.requests[1]?.messages ?? [])[0];
    expect(availability?.content).toContain("qui 2026-10-01: 13:00 (p1)");
    expect(availability?.content).toContain("15:00 (p1)");
    const refusedConfirm = lastToolResults(t.llm.requests[3]?.messages ?? [])[0];
    expect(refusedConfirm?.is_error).toBe(true);
    expect(refusedConfirm?.content).toContain("ainda não respondeu");

    const transcriptAfterFirst = structuredClone(t.getTranscript());
    t.llm.push(
      toolCall("confirm_proposal", {}),
      textReply("Prontinho, Ana! Te espero quinta às 15h."),
    );

    const second = await t.turn("pode sim");

    expect(second.outcome).toBe("replied");
    expect(t.provider.appointments).toHaveLength(1);
    const [appointment] = t.provider.appointments;
    expect(appointment?.startsAt.getTime()).toBe(at("2026-10-01", "15:00").getTime());
    expect(appointment?.professionalName).toBe("Carlos");
    expect(appointment?.customerName).toBe("Ana");
    expect(second.state.pending).toBeNull();
    expect(t.saved.at(-1)?.pending?.executed?.appointmentId).toBe(appointment?.id);

    // O histórico só cresce: o segundo turno reenvia o primeiro sem mudar nada.
    const secondTurnRequest = t.llm.requests[4];
    expect(secondTurnRequest?.messages.slice(0, transcriptAfterFirst.length)).toEqual(
      transcriptAfterFirst,
    );
    expect(secondTurnRequest?.system).toEqual(t.llm.requests[0]?.system);
    expect(secondTurnRequest?.tools).toEqual(t.llm.requests[0]?.tools);
  });

  it("não aceita horário que a agenda não oferece", async () => {
    const t = await setup({ customerName: "Ana" });
    t.llm.push(
      toolCall("propose_appointment", {
        service: "s1",
        professional: "p1",
        date: "2026-10-01",
        time: "12:10",
        customer_name: null,
        notes: null,
      }),
      textReply("Esse horário não rola. Quer ver outros?"),
    );
    const result = await t.turn("marca quinta 12:10");
    expect(result.toolCalls[0]?.isError).toBe(true);
    expect(result.state.pending).toBeNull();
  });

  it("pede o nome antes de propor", async () => {
    const t = await setup({ customerName: null });
    t.llm.push(
      toolCall("propose_appointment", {
        service: "s1",
        professional: null,
        date: "2026-10-01",
        time: "15:00",
        customer_name: null,
        notes: null,
      }),
      textReply("Qual é o seu nome?"),
    );
    await t.turn("quero quinta 15h");
    const result = lastToolResults(t.llm.requests[1]?.messages ?? [])[0];
    expect(result?.content).toContain("Pergunte o nome");
    expect(t.getState().pending).toBeNull();
  });

  it("escolhe um profissional livre quando o cliente não tem preferência", async () => {
    const t = await setup({ customerName: "Ana" });
    t.llm.push(
      toolCall("propose_appointment", {
        service: "s1",
        professional: null,
        date: "2026-10-01",
        time: "15:00",
        customer_name: null,
        notes: null,
      }),
      textReply("Confirma?"),
    );
    const result = await t.turn("qualquer um, quinta 15h");
    expect(result.state.pending?.type === "create" && result.state.pending.professionalId).toBe(
      "prof-carlos",
    );
  });

  it("passa para a equipe quando o cliente pede", async () => {
    const t = await setup();
    t.llm.push(
      toolCall("handoff_to_human", { reason: "cliente quer falar com o dono" }),
      textReply("Vou chamar alguém da equipe pra falar contigo!"),
    );
    const result = await t.turn("quero falar com o dono");
    expect(result.handoff).toEqual({ reason: "cliente quer falar com o dono" });
  });

  it("descarta o turno quando o modelo recusa", async () => {
    const t = await setup();
    t.llm.push(refusalReply());
    const result = await t.turn("mensagem estranha");
    expect(result.outcome).toBe("refused");
    expect(result.appended).toEqual([]);
    expect(result.reply).toBe(FALLBACK_REPLIES.refused);
    expect(result.handoff).not.toBeNull();
  });

  it("para e chama a equipe quando passa do limite de chamadas", async () => {
    const t = await setup({ config: { maxRequestsPerTurn: 2 } });
    const check = {
      service: "s1",
      professional: null,
      date_from: "2026-10-01",
      days: 1,
      period: "any",
    };
    t.llm.push(toolCall("check_availability", check), toolCall("check_availability", check));
    const result = await t.turn("oi");
    expect(result.outcome).toBe("gave_up");
    expect(result.handoff).not.toBeNull();
    // O histórico termina com os resultados das ferramentas, então continua válido.
    expect(result.appended.at(-1)?.role).toBe("user");
  });

  it("aceita nome de ferramenta com maiúsculas", async () => {
    const t = await setup();
    t.llm.push(
      toolCall("Check_Availability", {
        service: "s1",
        professional: null,
        date_from: "2026-10-01",
        days: 1,
        period: "morning",
      }),
      textReply("Tenho 09:00."),
    );
    const result = await t.turn("tem horário quinta de manhã?");
    expect(result.toolCalls[0]?.isError).toBe(false);
  });

  it("remarca pelo código do agendamento, com confirmação", async () => {
    const t = await setup({ customerName: "Ana" });
    const existing = await t.provider.createAppointment({
      serviceId: "svc-corte",
      professionalId: "prof-carlos",
      startsAt: at("2026-10-01", "10:00"),
      customer: { id: "cust-ana", name: "Ana", phoneE164: "+5551999998888" },
      source: "agent",
    });
    t.llm.push(
      toolCall("find_my_appointments", {}),
      toolCall("propose_reschedule", {
        appointment: "a1",
        professional: null,
        date: "2026-10-01",
        time: "10:30",
      }),
      textReply("Passo pra 10:30, confirma?"),
    );
    await t.turn("dá pra passar meu corte pra meia hora depois?");
    expect(t.getState().pending?.type).toBe("reschedule");

    t.llm.push(toolCall("confirm_proposal", {}), textReply("Feito!"));
    await t.turn("sim");
    const moved = await t.provider.getAppointment(existing.id);
    expect(moved?.startsAt.getTime()).toBe(at("2026-10-01", "10:30").getTime());
  });

  it("cancela com confirmação", async () => {
    const t = await setup({ customerName: "Ana" });
    const existing = await t.provider.createAppointment({
      serviceId: "svc-corte",
      professionalId: "prof-carlos",
      startsAt: at("2026-10-01", "10:00"),
      customer: { id: "cust-ana", name: "Ana", phoneE164: "+5551999998888" },
      source: "agent",
    });
    t.llm.push(
      toolCall("find_my_appointments", {}),
      toolCall("propose_cancellation", { appointment: "a1", reason: "viagem" }),
      textReply("Cancelo o corte de quinta, confirma?"),
    );
    await t.turn("preciso cancelar");
    t.llm.push(toolCall("confirm_proposal", {}), textReply("Cancelado."));
    await t.turn("isso");
    expect((await t.provider.getAppointment(existing.id))?.status).toBe("cancelled");
  });
});

describe("confirm_proposal", () => {
  it("não duplica se uma tentativa anterior já gravou antes de cair", async () => {
    const provider = new InMemorySchedulingProvider(demoCatalog(), () => CONTRACT_NOW);
    const catalog = buildCatalog(await provider.listServices(), await provider.listProfessionals());
    const startsAt = at("2026-10-01", "15:00");
    await provider.createAppointment({
      serviceId: "svc-corte",
      professionalId: "prof-carlos",
      startsAt,
      customer: { id: "cust-ana", name: "Ana", phoneE164: "+5551999998888" },
      source: "agent",
    });
    const state: AgentState = {
      ...initialAgentState(),
      turn: 2,
      pending: {
        type: "create",
        turn: 1,
        createdAt: CONTRACT_NOW.toISOString(),
        summary: "Corte com Carlos",
        executed: null,
        serviceId: "svc-corte",
        professionalId: "prof-carlos",
        startsAt: startsAt.toISOString(),
        customerName: "Ana",
        notes: null,
      },
    };
    const ctx: ToolContext = {
      provider,
      catalog,
      timezone: TZ,
      customer: { id: "cust-ana", name: "Ana", phoneE164: "+5551999998888" },
      state,
      now: CONTRACT_NOW,
      saveState: async () => {},
      handoff: null,
    };

    const first = await executeTool("confirm_proposal", {}, ctx);
    const second = await executeTool("confirm_proposal", {}, ctx);

    expect(first.isError).toBe(false);
    expect(second.content).toBe(first.content);
    expect(provider.appointments).toHaveLength(1);
  });
});

describe("parâmetros enviados ao Claude", () => {
  it("Sonnet 5.5: esforço, raciocínio adaptativo, histórico protegido, fallback e cache", async () => {
    const t = await setup();
    t.llm.push(textReply("Oi!"));
    await t.turn("oi");
    const request = t.llm.requests[0];
    expect(request?.model).toBe("claude-sonnet-5-5");
    expect(request?.output_config).toEqual({ effort: "low" });
    expect(request?.thinking).toEqual({
      type: "adaptive",
      block_binding: { prefix_mismatch_behavior: "drop_block" },
    });
    expect(request?.fallbacks).toBe("default");
    expect(request?.betas).toEqual([
      "thinking-binding-controls-2026-08-01",
      "server-side-fallback-2026-07-01",
    ]);
    expect(request?.cache_control).toEqual({ type: "ephemeral" });
    expect(Array.isArray(request?.system) && request.system[0]?.cache_control).toEqual({
      type: "ephemeral",
    });
    expect(request?.messages.map((message) => message.role)).toEqual(["user", "system"]);
    expect(request?.tools?.every((tool) => "strict" in tool && tool.strict === true)).toBe(true);
  });

  it("Haiku 4.5: sem parâmetros que o modelo não aceita", async () => {
    const t = await setup({ config: { model: "claude-haiku-4-5" } });
    t.llm.push(textReply("Oi!"));
    await t.turn("oi");
    const request = t.llm.requests[0];
    expect(request?.output_config).toBeUndefined();
    expect(request?.thinking).toBeUndefined();
    expect(request?.fallbacks).toBeUndefined();
    expect(request?.betas).toBeUndefined();
    expect(request?.messages.map((message) => message.role)).toEqual(["user"]);
    const content = request?.messages[0]?.content;
    expect(Array.isArray(content) && content[0]?.type === "text" && content[0].text).toContain(
      "Contexto do sistema",
    );
  });
});
