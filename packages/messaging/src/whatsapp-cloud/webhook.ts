import { createHmac, timingSafeEqual } from "node:crypto";
import type { MessageKind } from "../channel";

/**
 * Leitura dos webhooks da WhatsApp Cloud API.
 *
 * Um único app da Meta atende todos os negócios. Cada evento traz o
 * phone_number_id, que identifica o canal e, por ele, o negócio.
 *
 * Desde abril de 2026 os webhooks trazem o BSUID (user_id). Quem adota nome de
 * usuário pode não mandar wa_id nem from, então os dois são opcionais aqui.
 */

export interface WhatsAppIdentity {
  waId: string | null;
  waUserId: string | null;
}

export interface InboundMessageEvent {
  type: "message";
  phoneNumberId: string;
  from: WhatsAppIdentity & { profileName: string | null };
  externalId: string;
  timestamp: Date;
  kind: MessageKind;
  /** Texto, título do botão ou legenda da mídia. Conteúdo de mídia não é guardado. */
  text: string | null;
  /** Payload do botão de resposta rápida ou ID da opção escolhida. */
  buttonPayload: string | null;
  /** Mensagem do negócio a que o cliente respondeu, se houver. */
  replyToExternalId: string | null;
}

export interface StatusEvent {
  type: "status";
  phoneNumberId: string;
  externalId: string;
  status: "sent" | "delivered" | "read" | "failed";
  timestamp: Date;
  recipient: WhatsAppIdentity;
  errors: Array<{ code: number | null; title: string | null }>;
}

/** Mensagem enviada pela equipe no app WhatsApp Business, em números com coexistência. */
export interface EchoEvent {
  type: "echo";
  phoneNumberId: string;
  to: WhatsAppIdentity;
  externalId: string;
  timestamp: Date;
  kind: MessageKind;
  text: string | null;
}

export type WhatsAppEvent = InboundMessageEvent | StatusEvent | EchoEvent;

/** Confere o cabeçalho X-Hub-Signature-256 com o app secret. */
export function verifyWhatsAppSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (!appSecret || !signatureHeader?.startsWith("sha256=")) {
    return false;
  }
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const received = Buffer.from(signatureHeader.slice("sha256=".length), "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

// ---------------------------------------------------------------------------
// Leitura defensiva: a Meta acrescenta campos com frequência.
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;

function obj(value: unknown): Obj {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {};
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function timestampOf(value: unknown): Date {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date();
}

const KNOWN_KINDS: ReadonlySet<string> = new Set([
  "text",
  "button",
  "interactive",
  "audio",
  "image",
  "video",
  "document",
  "sticker",
  "location",
  "reaction",
]);

function kindOf(type: unknown): MessageKind {
  const value = str(type);
  return value && KNOWN_KINDS.has(value) ? (value as MessageKind) : "other";
}

function textOf(message: Obj): string | null {
  const interactive = obj(message.interactive);
  return (
    str(obj(message.text).body) ??
    str(obj(message.button).text) ??
    str(obj(interactive.button_reply).title) ??
    str(obj(interactive.list_reply).title) ??
    str(obj(message.image).caption) ??
    str(obj(message.video).caption) ??
    str(obj(message.document).caption)
  );
}

function buttonPayloadOf(message: Obj): string | null {
  const interactive = obj(message.interactive);
  return (
    str(obj(message.button).payload) ??
    str(obj(interactive.button_reply).id) ??
    str(obj(interactive.list_reply).id)
  );
}

export function parseWhatsAppWebhook(payload: unknown): WhatsAppEvent[] {
  const events: WhatsAppEvent[] = [];
  for (const entry of arr(obj(payload).entry)) {
    for (const change of arr(obj(entry).changes)) {
      const field = str(obj(change).field);
      const value = obj(obj(change).value);
      const phoneNumberId = str(obj(value.metadata).phone_number_id);
      if (!phoneNumberId) {
        continue;
      }

      if (field === "messages") {
        const contacts = arr(value.contacts).map(obj);
        for (const raw of arr(value.messages)) {
          const message = obj(raw);
          const externalId = str(message.id);
          if (!externalId) {
            continue;
          }
          const waId = str(message.from);
          const waUserId = str(message.from_user_id);
          const contact =
            contacts.find(
              (item) =>
                (waId && str(item.wa_id) === waId) || (waUserId && str(item.user_id) === waUserId),
            ) ?? contacts[0];
          events.push({
            type: "message",
            phoneNumberId,
            from: {
              waId: waId ?? str(contact?.wa_id),
              waUserId: waUserId ?? str(contact?.user_id),
              profileName: str(obj(contact?.profile).name),
            },
            externalId,
            timestamp: timestampOf(message.timestamp),
            kind: kindOf(message.type),
            text: textOf(message),
            buttonPayload: buttonPayloadOf(message),
            replyToExternalId: str(obj(message.context).id),
          });
        }

        for (const raw of arr(value.statuses)) {
          const status = obj(raw);
          const externalId = str(status.id);
          const state = str(status.status);
          if (!externalId || !state || !["sent", "delivered", "read", "failed"].includes(state)) {
            continue;
          }
          events.push({
            type: "status",
            phoneNumberId,
            externalId,
            status: state as StatusEvent["status"],
            timestamp: timestampOf(status.timestamp),
            recipient: {
              waId: str(status.recipient_id),
              waUserId: str(status.recipient_user_id),
            },
            errors: arr(status.errors).map((item) => ({
              code: typeof obj(item).code === "number" ? (obj(item).code as number) : null,
              title: str(obj(item).title),
            })),
          });
        }
      }

      if (field === "smb_message_echoes") {
        for (const raw of arr(value.message_echoes)) {
          const echo = obj(raw);
          const externalId = str(echo.id);
          if (!externalId) {
            continue;
          }
          events.push({
            type: "echo",
            phoneNumberId,
            to: { waId: str(echo.to), waUserId: str(echo.to_user_id) },
            externalId,
            timestamp: timestampOf(echo.timestamp),
            kind: kindOf(echo.type),
            text: textOf(echo),
          });
        }
      }
    }
  }
  return events;
}
