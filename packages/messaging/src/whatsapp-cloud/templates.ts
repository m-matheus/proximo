import type { TemplateDefinition } from "../templates";
import { type GraphOptions, graphRequest } from "./graph";

/**
 * Templates de uma conta do WhatsApp (WABA) na Meta: consultar e criar.
 * Serve ao script de templates hoje e ao Embedded Signup depois, quando cada
 * negócio conectar a própria conta.
 */

export interface RemoteTemplate {
  id: string;
  name: string;
  language: string;
  /** APPROVED, PENDING, REJECTED, PAUSED, DISABLED... */
  status: string;
  category: string;
  rejectedReason: string | null;
}

interface RawTemplate {
  id?: string;
  name?: string;
  language?: string;
  status?: string;
  category?: string;
  rejected_reason?: string;
}

/** Corpo do POST /{waba-id}/message_templates para um template do Próximo. */
export function templateCreationPayload(template: TemplateDefinition): Record<string, unknown> {
  const components: unknown[] = [
    {
      type: "BODY",
      text: template.body,
      ...(template.bodyExample.length ? { example: { body_text: [template.bodyExample] } } : {}),
    },
  ];
  if (template.quickReplies.length) {
    components.push({
      type: "BUTTONS",
      buttons: template.quickReplies.map((text) => ({ type: "QUICK_REPLY", text })),
    });
  }
  return {
    name: template.name,
    language: template.languageCode,
    category: template.category,
    parameter_format: "positional",
    components,
  };
}

export class WhatsAppTemplateManager {
  private readonly options: GraphOptions & { wabaId: string };

  constructor(options: GraphOptions & { wabaId: string }) {
    this.options = options;
  }

  /** Templates da conta com esse nome, em todos os idiomas. */
  async find(name: string): Promise<RemoteTemplate[]> {
    const query = new URLSearchParams({
      name,
      fields: "id,name,language,status,category,rejected_reason",
      limit: "100",
    });
    const body = await graphRequest<{ data?: RawTemplate[] }>(
      this.options,
      "GET",
      `${this.options.wabaId}/message_templates?${query.toString()}`,
    );
    // O filtro por nome da Meta é por prefixo: lembrete_2h também traria lembrete_2h_v2.
    return (body.data ?? [])
      .filter((item) => item.name === name)
      .map((item) => ({
        id: item.id ?? "",
        name: item.name ?? "",
        language: item.language ?? "",
        status: item.status ?? "",
        category: item.category ?? "",
        rejectedReason:
          item.rejected_reason && item.rejected_reason !== "NONE" ? item.rejected_reason : null,
      }));
  }

  /** Envia o template para análise da Meta. Devolve o status inicial, em geral PENDING. */
  async create(
    template: TemplateDefinition,
  ): Promise<{ id: string; status: string; category: string }> {
    const body = await graphRequest<{ id?: string; status?: string; category?: string }>(
      this.options,
      "POST",
      `${this.options.wabaId}/message_templates`,
      templateCreationPayload(template),
    );
    return { id: body.id ?? "", status: body.status ?? "", category: body.category ?? "" };
  }
}
