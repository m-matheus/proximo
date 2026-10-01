import { randomUUID } from "node:crypto";
import type { MessagingChannel, Recipient, SendResult, TemplateMessage } from "../channel";

/**
 * Canal de desenvolvimento. Não envia nada: as mensagens ficam no banco e o
 * simulador do painel mostra a conversa. Também serve para testes.
 */
export class SimulatorChannel implements MessagingChannel {
  readonly type = "simulator" as const;
  readonly sent: Array<{
    to: Recipient;
    text?: string;
    template?: TemplateMessage;
    externalId: string;
  }> = [];

  async sendText(to: Recipient, text: string): Promise<SendResult> {
    const externalId = `sim.${randomUUID()}`;
    this.sent.push({ to, text, externalId });
    return { externalId };
  }

  async sendTemplate(to: Recipient, template: TemplateMessage): Promise<SendResult> {
    const externalId = `sim.${randomUUID()}`;
    this.sent.push({ to, template, externalId });
    return { externalId };
  }

  async markAsRead(): Promise<void> {}
}
