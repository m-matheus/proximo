import type Anthropic from "@anthropic-ai/sdk";

type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type BetaTool = Anthropic.Beta.Messages.BetaTool;
type AnthropicBeta = Anthropic.Beta.AnthropicBeta;

export type Effort = "low" | "medium" | "high";

export interface AgentConfig {
  /** ID exato do modelo, sem sufixo de data. */
  model: string;
  /** Esforço de raciocínio. Conversa de agendamento vai bem em low. */
  effort: Effort;
  maxTokens: number;
  /** "default" liga o fallback do servidor em recusas de segurança. */
  fallbacks: "default" | "off";
  /** O que a API faz se o histórico reenviado não bater com o original. */
  prefixMismatch: "drop_block" | "error";
  /** Limite de chamadas à API num turno, contando as idas e voltas de ferramentas. */
  maxRequestsPerTurn: number;
}

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  model: "claude-sonnet-5-5",
  effort: "low",
  maxTokens: 8000,
  fallbacks: "default",
  prefixMismatch: "drop_block",
  maxRequestsPerTurn: 8,
};

/** O que cada modelo aceita. Modelos fora da lista recebem o mínimo. */
export interface ModelProfile {
  effort: boolean;
  adaptiveThinking: boolean;
  /** Aceita thinking.block_binding, a checagem de histórico só-acréscimo. */
  blockBinding: boolean;
  serverFallback: boolean;
  /** Aceita mensagens role "system" no meio da conversa. */
  midConversationSystem: boolean;
}

const CURRENT_GENERATION: ModelProfile = {
  effort: true,
  adaptiveThinking: true,
  blockBinding: true,
  serverFallback: true,
  midConversationSystem: true,
};

const MINIMAL: ModelProfile = {
  effort: false,
  adaptiveThinking: false,
  blockBinding: false,
  serverFallback: false,
  midConversationSystem: false,
};

const PROFILES: Record<string, ModelProfile> = {
  "claude-sonnet-5-5": CURRENT_GENERATION,
  "claude-opus-5-5": CURRENT_GENERATION,
  // Haiku 4.5: mais barato, sem effort nem mensagens de sistema no meio da conversa.
  "claude-haiku-4-5": MINIMAL,
};

export function modelProfile(model: string): ModelProfile {
  return PROFILES[model] ?? MINIMAL;
}

/**
 * Monta a requisição. O prompt de sistema e as ferramentas vêm congelados da
 * sessão: mudar qualquer byte deles invalida o cache e o raciocínio anterior.
 */
export function buildRequest(
  config: AgentConfig,
  system: string,
  tools: BetaTool[],
  messages: BetaMessageParam[],
): CreateParams {
  const profile = modelProfile(config.model);
  const betas: AnthropicBeta[] = [];
  const params: CreateParams = {
    model: config.model,
    max_tokens: config.maxTokens,
    // A marca no último bloco do sistema guarda ferramentas e sistema em cache.
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    tools,
    messages,
    // Cache automático para a parte da conversa que cresce.
    cache_control: { type: "ephemeral" },
  };
  if (profile.effort) {
    params.output_config = { effort: config.effort };
  }
  if (profile.adaptiveThinking) {
    if (profile.blockBinding) {
      params.thinking = {
        type: "adaptive",
        block_binding: { prefix_mismatch_behavior: config.prefixMismatch },
      };
      betas.push("thinking-binding-controls-2026-08-01");
    } else {
      params.thinking = { type: "adaptive" };
    }
  }
  if (profile.serverFallback && config.fallbacks === "default") {
    params.fallbacks = "default";
    betas.push("server-side-fallback-2026-07-01");
  }
  if (betas.length > 0) {
    params.betas = betas;
  }
  return params;
}
