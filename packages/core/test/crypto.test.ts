import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decryptJson,
  decryptSecret,
  encryptJson,
  encryptSecret,
  parseEncryptionKey,
} from "../src/crypto";

describe("segredos cifrados", () => {
  const key = randomBytes(32);

  it("cifra e decifra texto", () => {
    const payload = encryptSecret("token-secreto", key);
    expect(payload.startsWith("v1:")).toBe(true);
    expect(payload).not.toContain("token-secreto");
    expect(decryptSecret(payload, key)).toBe("token-secreto");
  });

  it("cifra e decifra JSON", () => {
    const payload = encryptJson({ accessToken: "abc" }, key);
    expect(decryptJson(payload, key)).toEqual({ accessToken: "abc" });
  });

  it("falha com chave errada", () => {
    const payload = encryptSecret("token", key);
    expect(() => decryptSecret(payload, randomBytes(32))).toThrow();
  });

  it("valida o tamanho da chave", () => {
    expect(() => parseEncryptionKey(undefined)).toThrow(/pnpm keygen/);
    expect(() => parseEncryptionKey(Buffer.alloc(16).toString("base64"))).toThrow(/32 bytes/);
    expect(parseEncryptionKey(key.toString("base64")).equals(key)).toBe(true);
  });
});
