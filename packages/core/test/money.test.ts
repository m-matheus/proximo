import { describe, expect, it } from "vitest";
import { formatBRL } from "../src/money";

describe("formatBRL", () => {
  it("formata centavos em reais", () => {
    expect(formatBRL(4500).replace(/\s/g, " ")).toBe("R$ 45,00");
    expect(formatBRL(123456).replace(/\s/g, " ")).toBe("R$ 1.234,56");
  });
});
