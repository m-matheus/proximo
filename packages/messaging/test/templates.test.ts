import { describe, expect, it, vi } from "vitest";
import {
  PROXIMO_TEMPLATES,
  REMINDER_TEMPLATES,
  renderTemplateBody,
  sanitizeTemplateParameter,
} from "../src/templates";
import { templateCreationPayload, WhatsAppTemplateManager } from "../src/whatsapp-cloud/templates";

function variablesOf(body: string): number[] {
  return [...body.matchAll(/\{\{(\d+)\}\}/g)].map((match) => Number(match[1]));
}

describe("templates do Próximo", () => {
  it("cada template tem um exemplo por variável, em ordem, e até três botões", () => {
    for (const template of PROXIMO_TEMPLATES) {
      const variables = variablesOf(template.body);
      expect(variables).toEqual(variables.map((_, index) => index + 1));
      expect(template.bodyExample).toHaveLength(variables.length);
      expect(template.quickReplies.length).toBeLessThanOrEqual(3);
      // A Meta recusa corpo que começa ou termina com variável.
      expect(template.body.trim()).not.toMatch(/^\{\{|\}\}$/);
      for (const text of template.quickReplies) {
        expect(text.length).toBeLessThanOrEqual(25);
      }
    }
  });

  it("monta o texto que o cliente recebe", () => {
    expect(
      renderTemplateBody(REMINDER_TEMPLATES.reminder_2h, [
        "Barbearia Exemplo",
        "15:00",
        "Corte",
        "Carlos",
      ]),
    ).toBe(
      "Olá! Seu horário em Barbearia Exemplo é hoje às 15:00: Corte com Carlos. Você confirma presença? Se precisar, dá para remarcar ou cancelar pelos botões abaixo.",
    );
  });

  it("limpa variáveis que a Meta recusaria", () => {
    expect(sanitizeTemplateParameter("  Corte\n e\tbarba     ")).toBe("Corte e barba");
    expect(sanitizeTemplateParameter("   ")).toBe("-");
  });

  it("cria o template na conta com exemplos e botões de resposta rápida", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ id: "123", status: "PENDING", category: "UTILITY" }), {
          status: 200,
        }),
    );
    const manager = new WhatsAppTemplateManager({
      wabaId: "999",
      accessToken: "token",
      graphApiVersion: "v26.0",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const result = await manager.create(REMINDER_TEMPLATES.reminder_24h);

    expect(result).toEqual({ id: "123", status: "PENDING", category: "UTILITY" });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://graph.facebook.com/v26.0/999/message_templates");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual(
      templateCreationPayload(REMINDER_TEMPLATES.reminder_24h),
    );
    expect(templateCreationPayload(REMINDER_TEMPLATES.reminder_24h)).toMatchObject({
      name: "lembrete_24h",
      language: "pt_BR",
      category: "UTILITY",
      components: [
        { type: "BODY", example: { body_text: [REMINDER_TEMPLATES.reminder_24h.bodyExample] } },
        {
          type: "BUTTONS",
          buttons: [
            { type: "QUICK_REPLY", text: "Confirmar presença" },
            { type: "QUICK_REPLY", text: "Remarcar" },
            { type: "QUICK_REPLY", text: "Cancelar horário" },
          ],
        },
      ],
    });
  });

  it("consulta só o template com o nome exato", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "1",
                name: "lembrete_2h",
                language: "pt_BR",
                status: "REJECTED",
                category: "UTILITY",
                rejected_reason: "INVALID_FORMAT",
              },
              { id: "2", name: "lembrete_2h_v2", language: "pt_BR", status: "APPROVED" },
            ],
          }),
          { status: 200 },
        ),
    );
    const manager = new WhatsAppTemplateManager({
      wabaId: "999",
      accessToken: "token",
      graphApiVersion: "v26.0",
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(await manager.find("lembrete_2h")).toEqual([
      {
        id: "1",
        name: "lembrete_2h",
        language: "pt_BR",
        status: "REJECTED",
        category: "UTILITY",
        rejectedReason: "INVALID_FORMAT",
      },
    ]);
  });
});
