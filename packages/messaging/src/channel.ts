/**
 * Camada de mensageria. O agente e o worker só conhecem esta interface,
 * então trocar de provedor de WhatsApp, ou somar outro canal, não mexe neles.
 */

export type ChannelType = "whatsapp_cloud" | "simulator";

/** Tipos de mensagem normalizados. Batem com o enum MessageKind do banco. */
export type MessageKind =
  | "text"
  | "template"
  | "button"
  | "interactive"
  | "audio"
  | "image"
  | "video"
  | "document"
  | "sticker"
  | "location"
  | "reaction"
  | "other";

export interface Recipient {
  /** wa_id exatamente como a Meta enviou. Preferido quando existe. */
  waId?: string | null;
  /** ID do usuário por portfólio de negócio (BSUID), para quem esconde o telefone. */
  waUserId?: string | null;
}

export interface SendResult {
  /** ID da mensagem no provedor, como o wamid da Meta. */
  externalId: string;
}

export interface TemplateMessage {
  name: string;
  /** Código de idioma do template, como pt_BR. */
  languageCode: string;
  /** Valores das variáveis do corpo, na ordem: {{1}}, {{2}}... */
  bodyParameters?: string[];
  /** Payloads dos botões de resposta rápida, na ordem dos botões do template. */
  quickReplyPayloads?: string[];
}

export interface MessagingChannel {
  readonly type: ChannelType;
  sendText(to: Recipient, text: string): Promise<SendResult>;
  /** Mensagem iniciada pelo negócio fora da janela de 24h exige template aprovado. */
  sendTemplate(to: Recipient, template: TemplateMessage): Promise<SendResult>;
  /** Marca como lida e, se pedido, mostra "digitando..." enquanto o agente pensa. */
  markAsRead(externalMessageId: string, options?: { typing?: boolean }): Promise<void>;
}

export class ChannelError extends Error {
  /** Vale tentar de novo mais tarde, como em limite de taxa ou falha do servidor. */
  readonly retryable: boolean;
  readonly status: number | null;
  readonly code: number | null;

  constructor(
    message: string,
    details: { retryable: boolean; status?: number | null; code?: number | null },
  ) {
    super(message);
    this.name = "ChannelError";
    this.retryable = details.retryable;
    this.status = details.status ?? null;
    this.code = details.code ?? null;
  }
}
