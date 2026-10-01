/**
 * Telefones no formato E.164, com atenção ao nono dígito brasileiro.
 *
 * O WhatsApp entrega números antigos do Brasil sem o nono dígito no wa_id,
 * por exemplo 555199999999 em vez de 5551999999999. Para responder, use sempre
 * o wa_id exatamente como veio. Para buscar e exibir, use o E.164 normalizado.
 */

const NON_DIGITS = /\D/g;

export interface NormalizePhoneOptions {
  /**
   * Para telefone digitado por uma pessoa, sem código do país. Com "BR", números de
   * 10 dígitos, ou de 11 dígitos com 9 depois do DDD, ganham o 55 na frente.
   * IDs do WhatsApp sempre trazem o código do país: não use esta opção para eles.
   */
  defaultCountry?: "BR";
}

/**
 * Normaliza para E.164 com o nono dígito nos celulares brasileiros.
 * Devolve null quando não parece um telefone.
 */
export function normalizePhoneE164(
  input: string,
  options: NormalizePhoneOptions = {},
): string | null {
  const hasPlus = input.trim().startsWith("+");
  let digits = input.replace(NON_DIGITS, "");
  if (!hasPlus && options.defaultCountry === "BR" && looksLikeBrazilianNational(digits)) {
    digits = `55${digits}`;
  }
  if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) {
    const areaCode = digits.slice(2, 4);
    let subscriber = digits.slice(4);
    if (subscriber.length === 8 && /^[6-9]/.test(subscriber)) {
      subscriber = `9${subscriber}`;
    }
    return `+55${areaCode}${subscriber}`;
  }
  if (digits.length >= 8 && digits.length <= 15) {
    return `+${digits}`;
  }
  return null;
}

function looksLikeBrazilianNational(digits: string): boolean {
  if (!/^[1-9][1-9]/.test(digits)) {
    return false;
  }
  return digits.length === 10 || (digits.length === 11 && digits[2] === "9");
}

/** Formas que o mesmo número pode ter como wa_id, com e sem o nono dígito. */
export function whatsappIdVariants(phoneE164: string): string[] {
  const digits = phoneE164.replace(NON_DIGITS, "");
  const variants = [digits];
  if (digits.startsWith("55") && digits.length === 13 && digits[4] === "9") {
    variants.push(`${digits.slice(0, 4)}${digits.slice(5)}`);
  }
  return variants;
}

/** Exibe um E.164 brasileiro como (51) 99999-9999. Outros países ficam como estão. */
export function formatPhoneForDisplay(phoneE164: string): string {
  const digits = phoneE164.replace(NON_DIGITS, "");
  if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) {
    const areaCode = digits.slice(2, 4);
    const subscriber = digits.slice(4);
    const split = subscriber.length - 4;
    return `(${areaCode}) ${subscriber.slice(0, split)}-${subscriber.slice(split)}`;
  }
  return phoneE164;
}
