import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseWhatsAppWebhook, verifyWhatsAppSignature } from "../src/whatsapp-cloud/webhook";

function envelope(field: string, value: Record<string, unknown>) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "102290129340398",
        changes: [
          {
            field,
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550783881", phone_number_id: "106540352242922" },
              ...value,
            },
          },
        ],
      },
    ],
  };
}

describe("parseWhatsAppWebhook", () => {
  it("lê mensagem de texto com BSUID", () => {
    const events = parseWhatsAppWebhook(
      envelope("messages", {
        contacts: [
          {
            profile: { name: "Sheena Nelson" },
            wa_id: "16505551234",
            user_id: "US.13491208655302741918",
          },
        ],
        messages: [
          {
            from: "16505551234",
            from_user_id: "US.13491208655302741918",
            id: "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=",
            timestamp: "1749416383",
            type: "text",
            text: { body: "Does it come in another color?" },
          },
        ],
      }),
    );
    expect(events).toEqual([
      {
        type: "message",
        phoneNumberId: "106540352242922",
        from: {
          waId: "16505551234",
          waUserId: "US.13491208655302741918",
          profileName: "Sheena Nelson",
        },
        externalId: "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=",
        timestamp: new Date(1749416383 * 1000),
        kind: "text",
        text: "Does it come in another color?",
        buttonPayload: null,
        replyToExternalId: null,
      },
    ]);
  });

  it("aceita cliente com nome de usuário e sem telefone", () => {
    const [event] = parseWhatsAppWebhook(
      envelope("messages", {
        contacts: [{ profile: { username: "cliente" }, user_id: "BR.998877" }],
        messages: [
          {
            from_user_id: "BR.998877",
            id: "wamid.2",
            timestamp: "1749416383",
            type: "text",
            text: { body: "oi" },
          },
        ],
      }),
    );
    expect(event?.type === "message" && event.from).toEqual({
      waId: null,
      waUserId: "BR.998877",
      profileName: null,
    });
  });

  it("lê resposta de botão de template e áudio", () => {
    const events = parseWhatsAppWebhook(
      envelope("messages", {
        contacts: [{ profile: { name: "Ana" }, wa_id: "555199998888" }],
        messages: [
          {
            from: "555199998888",
            id: "wamid.btn",
            timestamp: "1749416383",
            type: "button",
            context: { id: "wamid.lembrete" },
            button: { text: "Confirmo", payload: "confirm:abc" },
          },
          {
            from: "555199998888",
            id: "wamid.audio",
            timestamp: "1749416383",
            type: "audio",
            audio: { id: "1", voice: true },
          },
          { from: "555199998888", id: "wamid.x", timestamp: "1749416383", type: "unsupported" },
        ],
      }),
    );
    expect(
      events.map(
        (event) => event.type === "message" && [event.kind, event.text, event.buttonPayload],
      ),
    ).toEqual([
      ["button", "Confirmo", "confirm:abc"],
      ["audio", null, null],
      ["other", null, null],
    ]);
    expect(events[0]?.type === "message" && events[0].replyToExternalId).toBe("wamid.lembrete");
  });

  it("lê atualização de status com erros", () => {
    const [event] = parseWhatsAppWebhook(
      envelope("messages", {
        statuses: [
          {
            id: "wamid.out",
            status: "failed",
            timestamp: "1750263773",
            recipient_id: "16505551234",
            errors: [{ code: 131047, title: "Re-engagement message" }],
          },
        ],
      }),
    );
    expect(event).toMatchObject({
      type: "status",
      externalId: "wamid.out",
      status: "failed",
      recipient: { waId: "16505551234", waUserId: null },
      errors: [{ code: 131047, title: "Re-engagement message" }],
    });
  });

  it("lê eco de mensagem enviada pelo app WhatsApp Business", () => {
    const [event] = parseWhatsAppWebhook(
      envelope("smb_message_echoes", {
        message_echoes: [
          {
            from: "15550783881",
            to: "16505551234",
            id: "wamid.echo",
            timestamp: "1739321024",
            type: "text",
            text: { body: "Pode vir às 15h" },
          },
        ],
      }),
    );
    expect(event).toMatchObject({
      type: "echo",
      to: { waId: "16505551234", waUserId: null },
      externalId: "wamid.echo",
      kind: "text",
      text: "Pode vir às 15h",
    });
  });

  it("ignora payloads estranhos sem quebrar", () => {
    expect(parseWhatsAppWebhook(null)).toEqual([]);
    expect(
      parseWhatsAppWebhook({ entry: [{ changes: [{ field: "messages", value: {} }] }] }),
    ).toEqual([]);
  });
});

describe("verifyWhatsAppSignature", () => {
  const body = Buffer.from(JSON.stringify({ hello: "world" }));
  const signature = `sha256=${createHmac("sha256", "segredo").update(body).digest("hex")}`;

  it("aceita assinatura correta", () => {
    expect(verifyWhatsAppSignature(body, signature, "segredo")).toBe(true);
  });

  it("recusa assinatura errada, ausente ou com outro segredo", () => {
    expect(verifyWhatsAppSignature(body, "sha256=00", "segredo")).toBe(false);
    expect(verifyWhatsAppSignature(body, undefined, "segredo")).toBe(false);
    expect(verifyWhatsAppSignature(body, signature, "outro")).toBe(false);
    expect(verifyWhatsAppSignature(Buffer.from("alterado"), signature, "segredo")).toBe(false);
  });
});
