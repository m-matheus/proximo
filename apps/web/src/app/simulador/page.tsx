"use client";

import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";

/**
 * Simulador de conversa. Faz o papel do cliente no WhatsApp: a mensagem entra pela
 * API, passa pela fila e pelo worker, e o agente responde como faria de verdade.
 */

type Channel = { channelId: string; businessName: string; segment: string };

type ChatMessage = {
  id: string;
  direction: "inbound" | "outbound";
  author: "customer" | "agent" | "staff" | "system";
  kind: string;
  body: string | null;
  deliveryStatus: string | null;
  createdAt: string;
  /** Botões de resposta rápida de um template, como os do lembrete. */
  buttons: Array<{ label: string; payload: string }>;
};

type Appointment = {
  id: string;
  service: string;
  professional: string;
  startsAt: string;
  status: string;
};

type Conversation = {
  id: string;
  timezone: string;
  mode: "agent" | "human";
  handoffReason: string | null;
  customer: { name: string | null; phoneE164: string | null };
  messages: ChatMessage[];
  appointments: Appointment[];
};

const ACTIVE_STATUSES = new Set(["scheduled", "confirmed"]);

const REMINDERS = [
  { kind: "reminder_24h", label: "Lembrete de 24h" },
  { kind: "reminder_2h", label: "Lembrete de 2h" },
] as const;

const STATUS_LABEL: Record<string, string> = {
  scheduled: "agendado",
  confirmed: "confirmado",
  completed: "concluído",
  cancelled: "cancelado",
  no_show: "não compareceu",
};

/** Negrito do WhatsApp: *texto*. */
function formatWhatsApp(text: string): ReactNode[] {
  return text
    .split(/(\*[^*\n]+\*)/g)
    .map((part, index) =>
      part.startsWith("*") && part.endsWith("*") && part.length > 2 ? (
        <strong key={index}>{part.slice(1, -1)}</strong>
      ) : (
        part
      ),
    );
}

function time(value: string, timezone: string): string {
  return new Date(value).toLocaleTimeString("pt-BR", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
  });
}

function dateTime(value: string, timezone: string): string {
  return new Date(value).toLocaleString("pt-BR", {
    timeZone: timezone,
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function SimulatorPage() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelId, setChannelId] = useState("");
  const [phone, setPhone] = useState("(51) 99999-8888");
  const [name, setName] = useState("Ana");
  const [text, setText] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/dev/simulator/channels")
      .then((response) => (response.ok ? response.json() : Promise.reject(response.status)))
      .then((list: Channel[]) => {
        setChannels(list);
        setChannelId(list[0]?.channelId ?? "");
        if (list.length === 0) {
          setError("Nenhum negócio com canal de simulação. Rode pnpm db:seed.");
        }
      })
      .catch(() =>
        setError(
          "Não consegui falar com a API. Confira se pnpm dev está rodando e se SIMULATOR_ENABLED=true.",
        ),
      );
  }, []);

  useEffect(() => {
    if (!conversationId) {
      return;
    }
    let active = true;
    const load = async () => {
      const response = await fetch(`/api/dev/simulator/conversations/${conversationId}`);
      if (response.ok && active) {
        setConversation((await response.json()) as Conversation);
      }
    };
    void load();
    const timer = setInterval(load, 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [conversationId]);

  const messageCount = conversation?.messages.length ?? 0;
  useEffect(() => {
    if (messageCount > 0) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messageCount]);

  const waitingReply = useMemo(() => {
    const last = conversation?.messages.at(-1);
    return last?.direction === "inbound" && conversation?.mode === "agent";
  }, [conversation]);

  /** Manda uma mensagem do cliente: texto digitado ou toque num botão. */
  async function post(message: string, buttonPayload?: string): Promise<boolean> {
    setSending(true);
    setError(null);
    try {
      const response = await fetch("/api/dev/simulator/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channelId,
          phone,
          name: name || undefined,
          text: message,
          buttonPayload,
        }),
      });
      const data = (await response.json()) as { conversationId?: string; error?: string };
      if (!response.ok || !data.conversationId) {
        throw new Error(data.error ?? "Falha ao enviar.");
      }
      setConversationId(data.conversationId);
      return true;
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Falha ao enviar.");
      return false;
    } finally {
      setSending(false);
    }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!text.trim() || !channelId) {
      return;
    }
    if (await post(text)) {
      setText("");
    }
  }

  /** Manda o lembrete agora, sem esperar a janela de 24h ou 2h. */
  async function remind(appointmentId: string, kind: (typeof REMINDERS)[number]["kind"]) {
    setError(null);
    const response = await fetch(`/api/dev/simulator/appointments/${appointmentId}/reminders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind }),
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? "Falha ao pedir o lembrete.");
    }
  }

  async function reset() {
    if (conversationId) {
      await fetch(`/api/dev/simulator/conversations/${conversationId}`, { method: "DELETE" });
    }
    setConversationId(null);
    setConversation(null);
  }

  const timezone = conversation?.timezone ?? "America/Sao_Paulo";
  const locked = Boolean(conversationId);

  return (
    <main className="mx-auto grid min-h-screen max-w-6xl gap-6 px-4 py-6 lg:grid-cols-[1fr_320px]">
      <section className="flex min-h-[80vh] flex-col overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-sm">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-200 bg-brand-900 px-4 py-3 text-white">
          <div>
            <p className="text-sm text-brand-100">Simulador de WhatsApp</p>
            <h1 className="font-semibold">
              {channels.find((channel) => channel.channelId === channelId)?.businessName ??
                "Próximo"}
            </h1>
          </div>
          <span
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              conversation?.mode === "human"
                ? "bg-amber-300 text-amber-950"
                : "bg-brand-200 text-brand-900"
            }`}
          >
            {conversation?.mode === "human" ? "Com a equipe" : "Com o agente"}
          </span>
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto bg-stone-100 p-4">
          {!conversation && (
            <p className="mx-auto mt-10 max-w-sm text-center text-sm text-stone-500">
              Escreva como se fosse um cliente. Tente: &quot;oi, queria cortar o cabelo amanhã à
              tarde&quot;.
            </p>
          )}
          {conversation?.messages.map((message) => {
            const mine = message.direction === "inbound";
            return (
              <div key={message.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                <div className="max-w-[75%] space-y-1">
                  <div
                    className={`whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm shadow-sm ${
                      mine
                        ? "rounded-br-sm bg-brand-600 text-white"
                        : "rounded-bl-sm bg-white text-stone-900"
                    }`}
                  >
                    {message.author === "staff" && (
                      <p className="mb-1 text-xs font-medium text-amber-700">Equipe</p>
                    )}
                    {message.kind === "template" && (
                      <p className="mb-1 text-xs font-medium text-brand-700">Lembrete</p>
                    )}
                    {message.kind === "button" && (
                      <p className="mb-1 text-xs text-brand-100">Tocou no botão</p>
                    )}
                    {message.body ? formatWhatsApp(message.body) : <em>[{message.kind}]</em>}
                    <p
                      className={`mt-1 text-right text-[11px] ${mine ? "text-brand-100" : "text-stone-400"}`}
                    >
                      {time(message.createdAt, timezone)}
                      {!mine && message.deliveryStatus === "failed" ? " · falhou" : ""}
                    </p>
                  </div>
                  {message.buttons.map((button) => (
                    <button
                      key={button.payload}
                      type="button"
                      disabled={sending}
                      onClick={() => void post(button.label, button.payload)}
                      className="block w-full rounded-xl bg-white px-3 py-2 text-center text-sm font-medium text-brand-700 shadow-sm hover:bg-stone-50 disabled:opacity-50"
                    >
                      {button.label}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
          {waitingReply && <p className="text-sm text-stone-500">digitando...</p>}
          <div ref={bottomRef} />
        </div>

        <form onSubmit={send} className="flex gap-2 border-t border-stone-200 p-3">
          <input
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Mensagem"
            className="flex-1 rounded-full border border-stone-300 px-4 py-2 text-sm outline-none focus:border-brand-500"
          />
          <button
            type="submit"
            disabled={sending || !text.trim() || !channelId}
            className="rounded-full bg-brand-600 px-5 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            Enviar
          </button>
        </form>
      </section>

      <aside className="space-y-4">
        <div className="space-y-3 rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
          <h2 className="font-medium">Cliente simulado</h2>
          <label className="block text-sm">
            <span className="text-stone-600">Negócio</span>
            <select
              value={channelId}
              disabled={locked}
              onChange={(event) => setChannelId(event.target.value)}
              className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 disabled:bg-stone-100"
            >
              {channels.map((channel) => (
                <option key={channel.channelId} value={channel.channelId}>
                  {channel.businessName}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-stone-600">Telefone</span>
            <input
              value={phone}
              disabled={locked}
              onChange={(event) => setPhone(event.target.value)}
              className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 disabled:bg-stone-100"
            />
          </label>
          <label className="block text-sm">
            <span className="text-stone-600">Nome no perfil do WhatsApp</span>
            <input
              value={name}
              disabled={locked}
              onChange={(event) => setName(event.target.value)}
              className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 disabled:bg-stone-100"
            />
          </label>
          <button
            type="button"
            onClick={reset}
            className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm hover:bg-stone-50"
          >
            Recomeçar do zero
          </button>
          <p className="text-xs text-stone-500">
            Recomeçar apaga este cliente e os agendamentos dele. Os botões de lembrete em cada
            agendamento mandam o lembrete na hora, sem esperar a janela de 24h ou 2h.
          </p>
        </div>

        <div className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
          <h2 className="font-medium">Agendamentos do cliente</h2>
          {conversation?.appointments.length ? (
            <ul className="mt-3 space-y-2 text-sm">
              {conversation.appointments.map((appointment) => (
                <li key={appointment.id} className="rounded-lg bg-stone-50 px-3 py-2">
                  <p className="font-medium">
                    {appointment.service} com {appointment.professional}
                  </p>
                  <p className="text-stone-600">
                    {dateTime(appointment.startsAt, timezone)} ·{" "}
                    {STATUS_LABEL[appointment.status] ?? appointment.status}
                  </p>
                  {ACTIVE_STATUSES.has(appointment.status) && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {REMINDERS.map((reminder) => (
                        <button
                          key={reminder.kind}
                          type="button"
                          onClick={() => void remind(appointment.id, reminder.kind)}
                          className="rounded-md border border-stone-300 bg-white px-2 py-1 text-xs hover:bg-stone-100"
                        >
                          {reminder.label}
                        </button>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-stone-500">Nenhum ainda.</p>
          )}
          {conversation?.handoffReason && (
            <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
              Com a equipe: {conversation.handoffReason}
            </p>
          )}
        </div>

        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
      </aside>
    </main>
  );
}
