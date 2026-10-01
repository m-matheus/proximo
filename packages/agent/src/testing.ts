import type { BetaContentBlock, BetaMessage, LlmClient, MessageCreateParams } from "./llm";

/**
 * Claude roteirizado para testes: cada chamada devolve a próxima resposta do roteiro
 * e guarda a requisição para inspeção. Não usa rede.
 */

export type ScriptStep = BetaMessage | ((params: MessageCreateParams) => BetaMessage);

export class ScriptedLlm implements LlmClient {
  readonly requests: MessageCreateParams[] = [];
  private readonly steps: ScriptStep[];

  constructor(steps: ScriptStep[] = []) {
    this.steps = [...steps];
  }

  push(...steps: ScriptStep[]): this {
    this.steps.push(...steps);
    return this;
  }

  get remaining(): number {
    return this.steps.length;
  }

  async createMessage(params: MessageCreateParams): Promise<BetaMessage> {
    this.requests.push(structuredClone(params));
    const step = this.steps.shift();
    if (!step) {
      throw new Error("ScriptedLlm: o roteiro acabou.");
    }
    return typeof step === "function" ? step(params) : structuredClone(step);
  }
}

let counter = 0;

function message(
  content: Array<Record<string, unknown>>,
  stopReason: BetaMessage["stop_reason"],
): BetaMessage {
  counter += 1;
  return {
    id: `msg_test_${counter}`,
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content: content as unknown as BetaContentBlock[],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  } as unknown as BetaMessage;
}

/** Resposta que chama uma ferramenta, com um bloco de raciocínio como o real. */
export function toolCall(name: string, input: Record<string, unknown>): BetaMessage {
  counter += 1;
  return message(
    [
      { type: "thinking", thinking: "", signature: `sig_${counter}` },
      { type: "tool_use", id: `toolu_${counter}`, name, input },
    ],
    "tool_use",
  );
}

export function textReply(text: string): BetaMessage {
  return message([{ type: "text", text, citations: null }], "end_turn");
}

export function refusalReply(): BetaMessage {
  return message([], "refusal");
}
