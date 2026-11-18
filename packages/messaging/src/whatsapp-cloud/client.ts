import {
  ChannelError,
  type MessagingChannel,
  type Recipient,
  type SendResult,
  type TemplateMessage,
} from "../channel";
import { graphRequest } from "./graph";

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

export class WhatsAppCloudChannel implements MessagingChannel {
  readonly type = "whatsapp_cloud" as const;
  private readonly options: WhatsAppCloudOptions;

  constructor(options: WhatsAppCloudOptions) {
    this.options = options;
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

  private post(payload: Record<string, unknown>): Promise<{ messages?: Array<{ id?: string }> }> {
    return graphRequest(this.options, "POST", `${this.options.phoneNumberId}/messages`, payload);
  }
}
