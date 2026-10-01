import { CONTRACT_NOW, demoCatalog, InMemorySchedulingProvider } from "@proximo/scheduling/testing";
import { describe, expect, it } from "vitest";
import { buildCatalog } from "../src/catalog";
import { type BusinessContext, buildSystemPrompt, buildTurnContext } from "../src/prompt";
import { buildCarryOver, computeAgentVersion, sessionRotationReason } from "../src/session";
import { buildTools } from "../src/tools";

const TZ = "America/Sao_Paulo";

async function fixture() {
  const provider = new InMemorySchedulingProvider(demoCatalog(), () => CONTRACT_NOW);
  const catalog = buildCatalog(await provider.listServices(), await provider.listProfessionals());
  const business: BusinessContext = {
    name: "Barbearia Exemplo",
    segment: "barbershop",
    timezone: TZ,
    address: "Rua Exemplo, 123",
    agentName: null,
    agentInstructions: "Aceitamos Pix e cartão.",
    minLeadMinutes: 60,
    maxAdvanceDays: 30,
    openingHours: await provider.getOpeningHours(),
  };
  return { catalog, business };
}

describe("buildSystemPrompt", () => {
  it("é determinístico e traz catálogo, horário e orientações do negócio", async () => {
    const { catalog, business } = await fixture();
    const prompt = buildSystemPrompt(business, catalog);
    expect(buildSystemPrompt(business, catalog)).toBe(prompt);
    expect(prompt).toContain("assistente virtual da Barbearia Exemplo, uma barbearia");
    expect(prompt).toContain("- s1: Corte, 30 min, R$ 45,00. Quem faz: todos.");
    expect(prompt).toContain("- s5: Sobrancelha, 15 min, R$ 15,00. Quem faz: p1.");
    expect(prompt).toContain("- p2: Marcos");
    expect(prompt).toContain("- segunda: fechado");
    expect(prompt).toContain("- terça: 09:00 às 12:00 e 13:00 às 19:00");
    expect(prompt).toContain("Aceitamos Pix e cartão.");
    expect(prompt).toContain("Antecedência mínima para marcar: 1 hora.");
    expect(prompt).not.toMatch(/2026/);
  });

  it("concorda o gênero do tipo de negócio", async () => {
    const { catalog, business } = await fixture();
    const prompt = buildSystemPrompt(
      { ...business, name: "Salão Bela", segment: "salon" },
      catalog,
    );
    expect(prompt).toContain("assistente virtual do Salão Bela, um salão");
  });
});

describe("buildTurnContext", () => {
  it("traz agora, calendário com dia da semana e nome do cliente", () => {
    const context = buildTurnContext({
      now: CONTRACT_NOW,
      timezone: TZ,
      customerName: null,
      profileName: "Aninha",
      pendingSummary: null,
      carryOver: null,
    });
    expect(context).toContain("Agora: terça, 29/09/2026, 08:00");
    expect(context).toContain("ter 2026-09-29 (hoje), qua 2026-09-30 (amanhã), qui 2026-10-01");
    expect(context).toContain('No perfil do WhatsApp aparece "Aninha"');
  });
});

describe("sessões", () => {
  it("a versão do agente muda quando prompt, ferramentas ou modelo mudam", async () => {
    const { catalog, business } = await fixture();
    const prompt = buildSystemPrompt(business, catalog);
    const tools = buildTools(catalog);
    const version = computeAgentVersion("claude-sonnet-5-5", prompt, tools);
    expect(computeAgentVersion("claude-sonnet-5-5", prompt, tools)).toBe(version);
    expect(computeAgentVersion("claude-haiku-4-5", prompt, tools)).not.toBe(version);
    expect(computeAgentVersion("claude-sonnet-5-5", `${prompt}!`, tools)).not.toBe(version);
  });

  it("decide quando abrir uma sessão nova", () => {
    const now = new Date("2026-10-01T15:00:00Z");
    const options = { idleHours: 6, maxMessages: 80 };
    const session = {
      agentVersion: "v1",
      lastActivityAt: new Date("2026-10-01T14:00:00Z"),
      messageCount: 10,
    };
    expect(sessionRotationReason(null, "v1", now, options)).toBe("no_session");
    expect(sessionRotationReason(session, "v1", now, options)).toBeNull();
    expect(sessionRotationReason(session, "v2", now, options)).toBe("config_changed");
    expect(
      sessionRotationReason(
        { ...session, lastActivityAt: new Date("2026-10-01T08:00:00Z") },
        "v1",
        now,
        options,
      ),
    ).toBe("idle");
    expect(sessionRotationReason({ ...session, messageCount: 80 }, "v1", now, options)).toBe(
      "too_long",
    );
  });

  it("resume o atendimento anterior", () => {
    const text = buildCarryOver({
      timezone: TZ,
      upcoming: [
        {
          id: "a",
          serviceId: "s",
          serviceName: "Corte",
          professionalId: "p",
          professionalName: "Carlos",
          customerId: "c",
          customerName: "Ana",
          startsAt: new Date("2026-10-02T18:00:00Z"),
          endsAt: new Date("2026-10-02T18:30:00Z"),
          status: "scheduled",
          priceCents: 4500,
          source: "agent",
        },
      ],
      recent: [
        { author: "customer", text: "oi" },
        { author: "agent", text: "Oi! Quer marcar?" },
        { author: "staff", text: "Te espero sexta" },
      ],
    });
    expect(text).toContain("Corte com Carlos, sexta, 02/10 às 15:00");
    expect(text).toContain("equipe: Te espero sexta");
  });
});
