const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

/** 4500 vira "R$ 45,00", com o espaço não separável do Intl. */
export function formatBRL(cents: number): string {
  return brl.format(cents / 100);
}
