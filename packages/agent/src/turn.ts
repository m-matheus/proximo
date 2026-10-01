import type { SchedulingProvider } from "@proximo/scheduling";
import type { Catalog } from "./catalog";
import { type AgentConfig, buildRequest, modelProfile } from "./config";
import type {
  BetaContentBlock,
  BetaMessageParam,
  BetaTool,
  BetaToolResultBlockParam,
  LlmClient,
} from "./llm";
import { buildTurnContext } from "./prompt";
import type { AgentState } from "./state";
import { executeTool, type ToolContext, type ToolCustomer } from "./tools";

/**
 * Um turno do agente: a resposta a uma ou mais mensagens seguidas do cliente.
 *
 * O turno acrescenta ao histórico da sessão a fala do cliente, o contexto do
 * sistema e tudo o que o modelo devolveu, sem alterar nada que já estava lá.
 */

export interface AgentTurnInput {
  llm: LlmClient;
  config: AgentConfig;
  provider: SchedulingProvider;
  catalog: Catalog;
  timezone: string;
  /** Congelados na sessão. */
  systemPrompt: string;
  tools: BetaTool[];
  /** Histórico da sessão até aqui. Não é alterado. */
  transcript: BetaMessageParam[];
  state: AgentState;
  customer: ToolCustomer & { profileName: string | null };
  /** Textos do cliente neste turno, na ordem em que chegaram. */
  customerMessages: string[];
  /** Resumo do atendimento anterior, só no primeiro turno de uma sessão nova. */
  carryOver: string | null;
  now: Date;
  saveState: (state: AgentState) => Promise<void>;
}

export interface TurnUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ToolCallRecord {
  name: string;
  isError: boolean;
  ms: number;
  internalError?: string;
}

export type TurnOutcome = "replied" | "refused" | "gave_up";

export interface AgentTurnResult {
  outcome: TurnOutcome;
  /** Texto para mandar ao cliente. Sempre tem conteúdo. */
  reply: string;
  /** Mensagens a acrescentar ao histórico. Vazio quando o turno é descartado. */
  appended: BetaMessageParam[];
  state: AgentState;
  handoff: { reason: string } | null;
  usage: TurnUsage;
  toolCalls: ToolCallRecord[];
  stopReason: string | null;
  /** Mudanças que a API fez no histórico, como raciocínio descartado. Para monitorar. */
  inputTransformations: unknown[];
}

export const FALLBACK_REPLIES = {
  refused:
    "Desculpa, não consigo te ajudar com isso por aqui. Vou chamar alguém da equipe pra falar contigo, tá?",
  gaveUp: "Desculpa, me enrolei aqui. Vou pedir pra alguém da equipe te responder, tá bom?",
  empty: "Desculpa, não entendi direito. Pode me explicar de novo?",
} as const;

function textOf(content: BetaContentBlock[]): string {
  return content
    .filter((block): block is Extract<BetaContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

export async function runAgentTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
  const profile = modelProfile(input.config.model);
  const state: AgentState = structuredClone(input.state);
  state.turn += 1;

  const context = buildTurnContext({
    now: input.now,
    timezone: input.timezone,
    customerName: input.customer.name,
    profileName: input.customer.profileName,
    pendingSummary: state.pending && !state.pending.executed ? state.pending.summary : null,
    carryOver: input.carryOver,
  });
  const customerText = input.customerMessages.join("\n").trim() || "(mensagem vazia)";

  // Modelos com mensagens de sistema no meio da conversa recebem o contexto com
  // autoridade de operador. Nos outros, ele vai num bloco antes da fala do cliente.
  const opening: BetaMessageParam[] = profile.midConversationSystem
    ? [
        { role: "user", content: [{ type: "text", text: customerText }] },
        { role: "system", content: context },
      ]
    : [
        {
          role: "user",
          content: [
            { type: "text", text: context },
            { type: "text", text: `Mensagem do cliente:\n${customerText}` },
          ],
        },
      ];

  const appended: BetaMessageParam[] = [...opening];
  const usage: TurnUsage = {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  const toolCalls: ToolCallRecord[] = [];
  const inputTransformations: unknown[] = [];
  const toolContext: ToolContext = {
    provider: input.provider,
    catalog: input.catalog,
    timezone: input.timezone,
    customer: {
      id: input.customer.id,
      name: input.customer.name,
      phoneE164: input.customer.phoneE164,
    },
    state,
    now: input.now,
    saveState: input.saveState,
    handoff: null,
  };

  let stopReason: string | null = null;

  const finish = (
    outcome: TurnOutcome,
    reply: string,
    keepTranscript: boolean,
  ): AgentTurnResult => {
    if (state.pending?.executed) {
      state.pending = null;
    }
    const handoff =
      toolContext.handoff ??
      (outcome === "refused"
        ? { reason: "O modelo recusou responder." }
        : outcome === "gave_up"
          ? { reason: "O agente não conseguiu concluir o atendimento." }
          : null);
    return {
      outcome,
      reply,
      appended: keepTranscript ? appended : [],
      state,
      handoff,
      usage,
      toolCalls,
      stopReason,
      inputTransformations,
    };
  };

  for (let request = 0; request < input.config.maxRequestsPerTurn; request += 1) {
    const params = buildRequest(input.config, input.systemPrompt, input.tools, [
      ...input.transcript,
      ...appended,
    ]);
    const response = await input.llm.createMessage(params);
    usage.requests += 1;
    usage.inputTokens += response.usage.input_tokens;
    usage.outputTokens += response.usage.output_tokens;
    usage.cacheReadTokens += response.usage.cache_read_input_tokens ?? 0;
    usage.cacheWriteTokens += response.usage.cache_creation_input_tokens ?? 0;
    if (response.input_transformations?.length) {
      inputTransformations.push(...response.input_transformations);
    }
    stopReason = response.stop_reason;

    if (response.stop_reason === "refusal") {
      // Descarta o turno inteiro: tirar mensagens do fim não invalida o histórico anterior.
      // O estado volta junto, a menos que algo já tenha sido gravado na agenda.
      if (!state.pending?.executed) {
        Object.assign(state, structuredClone(input.state), { turn: state.turn });
      }
      return finish("refused", FALLBACK_REPLIES.refused, false);
    }

    appended.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter(
      (block): block is Extract<BetaContentBlock, { type: "tool_use" }> =>
        block.type === "tool_use",
    );
    if (response.stop_reason === "tool_use" && toolUses.length > 0) {
      const results: BetaToolResultBlockParam[] = [];
      // Em série: as ferramentas mexem no mesmo estado.
      for (const toolUse of toolUses) {
        const started = Date.now();
        const outcome = await executeTool(toolUse.name, toolUse.input, toolContext);
        toolCalls.push({
          name: toolUse.name,
          isError: outcome.isError,
          ms: Date.now() - started,
          ...(outcome.internalError ? { internalError: outcome.internalError } : {}),
        });
        results.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: outcome.content,
          ...(outcome.isError ? { is_error: true } : {}),
        });
      }
      appended.push({ role: "user", content: results });
      continue;
    }

    const reply = textOf(response.content);
    return finish("replied", reply || FALLBACK_REPLIES.empty, true);
  }

  return finish("gave_up", FALLBACK_REPLIES.gaveUp, true);
}
