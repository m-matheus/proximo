/**
 * Templates do WhatsApp que o Próximo usa.
 *
 * Mensagem iniciada pelo negócio fora da janela de 24h só sai com template aprovado
 * pela Meta. O texto daqui cria o template na Meta e vira o histórico da conversa,
 * então precisa ser igual ao aprovado. Mudou o texto, crie um template com outro nome.
 */

export type TemplateCategory = "UTILITY" | "MARKETING" | "AUTHENTICATION";

export interface TemplateDefinition {
  name: string;
  /** Código de idioma, como pt_BR. */
  languageCode: string;
  category: TemplateCategory;
  /** Corpo com variáveis posicionais: {{1}}, {{2}}... */
  body: string;
  /** Um exemplo para cada variável, exigido pela Meta na criação. */
  bodyExample: string[];
  /** Textos dos botões de resposta rápida, na ordem. */
  quickReplies: string[];
}

const REMINDER_BUTTONS = ["Confirmar presença", "Remarcar", "Cancelar horário"];

/** Lembretes de horário. A chave é o tipo de notificação no banco. */
export const REMINDER_TEMPLATES = {
  reminder_24h: {
    name: "lembrete_24h",
    languageCode: "pt_BR",
    category: "UTILITY",
    body:
      "Olá! Passando para lembrar do seu horário amanhã em {{1}}: {{2}} com {{3}}, {{4}} às {{5}}. " +
      "Você confirma presença? Se precisar, dá para remarcar ou cancelar pelos botões abaixo.",
    bodyExample: ["Barbearia Exemplo", "Corte", "Carlos", "quinta, 01/10", "15:00"],
    quickReplies: REMINDER_BUTTONS,
  },
  reminder_2h: {
    name: "lembrete_2h",
    languageCode: "pt_BR",
    category: "UTILITY",
    body:
      "Olá! Seu horário em {{1}} é hoje às {{2}}: {{3}} com {{4}}. " +
      "Você confirma presença? Se precisar, dá para remarcar ou cancelar pelos botões abaixo.",
    bodyExample: ["Barbearia Exemplo", "15:00", "Corte", "Carlos"],
    quickReplies: REMINDER_BUTTONS,
  },
} as const satisfies Record<string, TemplateDefinition>;

/** Todos os templates que cada conta do WhatsApp precisa ter aprovados. */
export const PROXIMO_TEMPLATES: readonly TemplateDefinition[] = Object.values(REMINDER_TEMPLATES);

/**
 * A Meta recusa variável vazia, com quebra de linha, tabulação ou mais de quatro
 * espaços seguidos. Nomes cadastrados no painel podem trazer qualquer um desses.
 */
export function sanitizeTemplateParameter(value: string): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean || "-";
}

/** O texto que o cliente recebe, para guardar no histórico da conversa. */
export function renderTemplateBody(template: TemplateDefinition, parameters: string[]): string {
  return template.body.replace(/\{\{(\d+)\}\}/g, (match, position: string) => {
    const value = parameters[Number(position) - 1];
    return value === undefined ? match : value;
  });
}
