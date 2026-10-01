import {
  ChannelError,
  type MessagingChannel,
  type Recipient,
  type SendResult,
  type TemplateMessage,
} from "../channel";

/**
 * Cliente da WhatsApp Cloud API (Graph API da Meta) para um número.
 * Documentação: https://developers.facebook.com/documentation/business-messaging/whatsapp
 */

export interface WhatsAppCloudOptions {
  /** phone_number_id do número na Meta. */
  phoneNumberId: string;
  accessToken: string;
  /** Versão da Graph API, como v26.0. */
  graphApiVersion: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

/** Códigos de erro da Meta que passam com o tempo, como limites de taxa. */
const RETRYABLE_META_CODES = new Set([1, 2, 4, 80007, 130429, 131000, 131056]);

function recipientFields(to: Recipient): Record<string, string> {
  if (to.waId) {
    return { to: to.waId };
  }
  if (to.waUserId) {
    // Clientes com nome de usuário podem esconder o telefone; aí só temos o BSUID.
    return { recipient: to.waUserId };
  }
  throw new ChannelError("Destinatário sem wa_id nem user_id.", { retryable: false });
}

interface GraphErrorBody {
  error?: { message?: string; code?: number; error_data?: { details?: string } };
  messages?: Array<{ id?: string }>;
}

export class WhatsAppCloudChannel implements MessagingChannel {
  readonly type = "whatsapp_cloud" as const;
  private readonly options: Required<Omit<WhatsAppCloudOptions, "fetch">> & {
    fetch: typeof fetch;
  };

  constructor(options: WhatsAppCloudOptions) {
    this.options = {
      baseUrl: "https://graph.facebook.com",
      ...options,
      fetch: options.fetch ?? fetch,
    };
  }

  async sendText(to: Recipient, text: string): Promise<SendResult> {
    return this.send({
      ...recipientFields(to),
      type: "text",
      text: { body: text, preview_url: false },
    });
  }

  async sendTemplate(to: Recipient, template: TemplateMessage): Promise<SendResult> {
    const components: unknown[] = [];
    if (template.bodyParameters?.length) {
      components.push({
        type: "body",
        parameters: template.bodyParameters.map((text) => ({ type: "text", text })),
      });
    }
    for (const [index, payload] of (template.quickReplyPayloads ?? []).entries()) {
      components.push({
        type: "button",
        sub_type: "quick_reply",
        index: String(index),
        parameters: [{ type: "payload", payload }],
      });
    }
    return this.send({
      ...recipientFields(to),
      type: "template",
      template: {
        name: template.name,
        language: { code: template.languageCode },
        ...(components.length ? { components } : {}),
      },
    });
  }

  async markAsRead(externalMessageId: string, options: { typing?: boolean } = {}): Promise<void> {
    await this.post({
      messaging_product: "whatsapp",
      status: "read",
      message_id: externalMessageId,
      ...(options.typing ? { typing_indicator: { type: "text" } } : {}),
    });
  }

  private async send(message: Record<string, unknown>): Promise<SendResult> {
    const body = await this.post({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      ...message,
    });
    const externalId = body.messages?.[0]?.id;
    if (!externalId) {
      throw new ChannelError("A Meta aceitou a mensagem mas não devolveu o ID.", {
        retryable: false,
      });
    }
    return { externalId };
  }

  private async post(payload: Record<string, unknown>): Promise<GraphErrorBody> {
    const { baseUrl, graphApiVersion, phoneNumberId, accessToken } = this.options;
    let response: Response;
    try {
      response = await this.options.fetch(
        `${baseUrl}/${graphApiVersion}/${phoneNumberId}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch (error) {
      throw new ChannelError(`Falha de rede ao falar com a Meta: ${String(error)}`, {
        retryable: true,
      });
    }

    const body = (await response.json().catch(() => ({}))) as GraphErrorBody;
    if (!response.ok) {
      const code = body.error?.code ?? null;
      const detail = body.error?.error_data?.details;
      const message = [body.error?.message ?? `HTTP ${response.status}`, detail]
        .filter(Boolean)
        .join(": ");
      throw new ChannelError(`Meta recusou a requisição: ${message}`, {
        status: response.status,
        code,
        retryable:
          response.status === 429 ||
          response.status >= 500 ||
          (code !== null && RETRYABLE_META_CODES.has(code)),
      });
    }
    return body;
  }
}
