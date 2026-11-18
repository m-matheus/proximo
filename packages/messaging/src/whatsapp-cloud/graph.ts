import { ChannelError } from "../channel";

/**
 * Chamada à Graph API da Meta, usada pelo envio de mensagens e pela gestão de templates.
 */

export interface GraphOptions {
  accessToken: string;
  /** Versão da Graph API, como v26.0. */
  graphApiVersion: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

/** Códigos de erro da Meta que passam com o tempo, como limites de taxa. */
const RETRYABLE_META_CODES = new Set([1, 2, 4, 80007, 130429, 131000, 131056]);

interface GraphErrorBody {
  error?: { message?: string; code?: number; error_data?: { details?: string } };
}

/** Faz a chamada e devolve o corpo. Erro da Meta vira ChannelError, com retryable quando vale tentar de novo. */
export async function graphRequest<T>(
  options: GraphOptions,
  method: "GET" | "POST",
  path: string,
  payload?: Record<string, unknown>,
): Promise<T> {
  const baseUrl = options.baseUrl ?? "https://graph.facebook.com";
  const fetchImpl = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/${options.graphApiVersion}/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${options.accessToken}`,
        ...(payload ? { "Content-Type": "application/json" } : {}),
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new ChannelError(`Falha de rede ao falar com a Meta: ${String(error)}`, {
      retryable: true,
    });
  }

  const body = (await response.json().catch(() => ({}))) as T & GraphErrorBody;
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
