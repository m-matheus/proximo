import Link from "next/link";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-8 px-6 py-16">
      <div className="space-y-3">
        <span className="inline-flex items-center rounded-full bg-brand-100 px-3 py-1 text-sm font-medium text-brand-900">
          Em construção
        </span>
        <h1 className="text-4xl font-semibold tracking-tight">Próximo</h1>
        <p className="text-lg text-stone-600">
          O assistente que atende seus clientes no WhatsApp e marca horários na sua agenda.
        </p>
      </div>
      <div className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
        <h2 className="font-medium">Ambiente de desenvolvimento</h2>
        <p className="mt-2 text-sm text-stone-600">
          O painel com agenda, cadastros e conversas chega numa próxima etapa. Por enquanto, teste o
          agente pelo simulador, que usa o mesmo caminho das mensagens do WhatsApp.
        </p>
        <Link
          href="/simulador"
          className="mt-4 inline-flex rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
        >
          Abrir o simulador
        </Link>
      </div>
    </main>
  );
}
