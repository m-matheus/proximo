import { describe, expect, it } from "vitest";
import { formatPhoneForDisplay, normalizePhoneE164, whatsappIdVariants } from "../src/phone";

describe("normalizePhoneE164", () => {
  it("adiciona o nono dígito em celular brasileiro antigo", () => {
    expect(normalizePhoneE164("555199998888")).toBe("+5551999998888");
  });

  it("mantém celular que já tem o nono dígito", () => {
    expect(normalizePhoneE164("5551999998888")).toBe("+5551999998888");
  });

  it("não mexe em telefone fixo", () => {
    expect(normalizePhoneE164("555132221111")).toBe("+555132221111");
  });

  it("aceita número digitado sem código do país", () => {
    expect(normalizePhoneE164("(51) 99999-8888", { defaultCountry: "BR" })).toBe("+5551999998888");
    expect(normalizePhoneE164("(51) 3222-1111", { defaultCountry: "BR" })).toBe("+555132221111");
  });

  it("aceita números de outros países", () => {
    expect(normalizePhoneE164("16505551234")).toBe("+16505551234");
    expect(normalizePhoneE164("+1 650 555 1234", { defaultCountry: "BR" })).toBe("+16505551234");
  });

  it("recusa o que não parece telefone", () => {
    expect(normalizePhoneE164("abc")).toBeNull();
    expect(normalizePhoneE164("123")).toBeNull();
  });
});

describe("whatsappIdVariants", () => {
  it("gera as formas com e sem o nono dígito", () => {
    expect(whatsappIdVariants("+5551999998888")).toEqual(["5551999998888", "555199998888"]);
  });

  it("não inventa variação para fixo", () => {
    expect(whatsappIdVariants("+555132221111")).toEqual(["555132221111"]);
  });
});

describe("formatPhoneForDisplay", () => {
  it("formata celular brasileiro", () => {
    expect(formatPhoneForDisplay("+5551999998888")).toBe("(51) 99999-8888");
  });

  it("formata fixo brasileiro", () => {
    expect(formatPhoneForDisplay("+555132221111")).toBe("(51) 3222-1111");
  });
});
