import { describe, expect, it, vi } from "vitest";
import { ChannelError } from "../src/channel";
import { WhatsAppCloudChannel } from "../src/whatsapp-cloud/client";

function fakeFetch(status: number, body: unknown) {
  return vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  );
}

function channel(fetchImpl: typeof fetch) {
  return new WhatsAppCloudChannel({
    phoneNumberId: "106540352242922",
    accessToken: "token",
    graphApiVersion: "v26.0",
    fetch: fetchImpl,
  });
}

describe("WhatsAppCloudChannel", () => {
  it("envia texto para o wa_id como veio da Meta", async () => {
    const fetchMock = fakeFetch(200, { messages: [{ id: "wamid.out" }] });
    const result = await channel(fetchMock as unknown as typeof fetch).sendText(
      { waId: "555199998888" },
      "Oi!",
    );

    expect(result.externalId).toBe("wamid.out");
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://graph.facebook.com/v26.0/106540352242922/messages");
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBe("Bearer token");
    expect(JSON.parse(String(init?.body))).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "555199998888",
      type: "text",
      text: { body: "Oi!", preview_url: false },
    });
  });

  it("usa o BSUID quando o cliente não tem telefone visível", async () => {
    const fetchMock = fakeFetch(200, { messages: [{ id: "wamid.out" }] });
    await channel(fetchMock as unknown as typeof fetch).sendText({ waUserId: "BR.998877" }, "Oi!");
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.recipient).toBe("BR.998877");
    expect(body.to).toBeUndefined();
  });

  it("monta template com variáveis e botões de resposta rápida", async () => {
    const fetchMock = fakeFetch(200, { messages: [{ id: "wamid.tpl" }] });
    await channel(fetchMock as unknown as typeof fetch).sendTemplate(
      { waId: "555199998888" },
      {
        name: "lembrete_agendamento",
        languageCode: "pt_BR",
        bodyParameters: ["Ana", "amanhã às 15:00"],
        quickReplyPayloads: ["confirm:1", "reschedule:1"],
      },
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.template).toEqual({
      name: "lembrete_agendamento",
      language: { code: "pt_BR" },
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: "Ana" },
            { type: "text", text: "amanhã às 15:00" },
          ],
        },
        {
          type: "button",
          sub_type: "quick_reply",
          index: "0",
          parameters: [{ type: "payload", payload: "confirm:1" }],
        },
        {
          type: "button",
          sub_type: "quick_reply",
          index: "1",
          parameters: [{ type: "payload", payload: "reschedule:1" }],
        },
      ],
    });
  });

  it("marca como lida mostrando digitando", async () => {
    const fetchMock = fakeFetch(200, { success: true });
    await channel(fetchMock as unknown as typeof fetch).markAsRead("wamid.in", { typing: true });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      messaging_product: "whatsapp",
      status: "read",
      message_id: "wamid.in",
      typing_indicator: { type: "text" },
    });
  });

  it("classifica erros da Meta entre temporários e definitivos", async () => {
    const rateLimited = channel(
      fakeFetch(400, {
        error: { message: "Rate limit hit", code: 130429 },
      }) as unknown as typeof fetch,
    );
    const outsideWindow = channel(
      fakeFetch(400, {
        error: { message: "Re-engagement message", code: 131047 },
      }) as unknown as typeof fetch,
    );

    const first = await rateLimited.sendText({ waId: "1" }, "x").catch((error: unknown) => error);
    const second = await outsideWindow
      .sendText({ waId: "1" }, "x")
      .catch((error: unknown) => error);

    expect(first).toBeInstanceOf(ChannelError);
    expect((first as ChannelError).retryable).toBe(true);
    expect((second as ChannelError).retryable).toBe(false);
    expect((second as ChannelError).code).toBe(131047);
  });
});
