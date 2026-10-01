import Anthropic from "@anthropic-ai/sdk";

export type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
export type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
export type BetaTool = Anthropic.Beta.Messages.BetaTool;
export type BetaContentBlock = Anthropic.Beta.Messages.BetaContentBlock;
export type BetaToolResultBlockParam = Anthropic.Beta.Messages.BetaToolResultBlockParam;
export type MessageCreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

/** O mínimo que o agente precisa do cliente da Anthropic. Facilita testar sem rede. */
export interface LlmClient {
  createMessage(params: MessageCreateParams): Promise<BetaMessage>;
}

export interface AnthropicLlmOptions {
  /** Sem chave, o SDK procura ANTHROPIC_API_KEY ou um perfil do "ant auth login". */
  apiKey?: string;
  maxRetries?: number;
  timeoutMs?: number;
}

/**
 * Erros que não passam com nova tentativa: credencial ausente ou inválida,
 * requisição malformada, modelo inexistente.
 */
export function isPermanentLlmError(error: unknown): boolean {
  if (
    error instanceof Anthropic.AuthenticationError ||
    error instanceof Anthropic.PermissionDeniedError ||
    error instanceof Anthropic.NotFoundError ||
    error instanceof Anthropic.BadRequestError
  ) {
    return true;
  }
  return error instanceof Error && /could not resolve authentication method/i.test(error.message);
}

export function createAnthropicLlm(options: AnthropicLlmOptions = {}): LlmClient {
  const client = new Anthropic({
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    maxRetries: options.maxRetries ?? 2,
    timeout: options.timeoutMs ?? 90_000,
  });
  return {
    createMessage: (params) => client.beta.messages.create(params),
  };
}
