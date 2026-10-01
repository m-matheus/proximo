import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Cifra de segredos guardados no banco, como tokens do WhatsApp e credenciais
 * de providers. AES-256-GCM com chave de 32 bytes vinda de ENCRYPTION_KEY.
 * Formato: v1:<iv>:<tag>:<conteúdo>, tudo em base64.
 */

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";

export function parseEncryptionKey(base64Key: string | undefined): Buffer {
  if (!base64Key) {
    throw new Error("ENCRYPTION_KEY não definida. Gere uma com: pnpm keygen");
  }
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== 32) {
    throw new Error("ENCRYPTION_KEY precisa ter 32 bytes em base64. Gere uma com: pnpm keygen");
  }
  return key;
}

export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const content = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), content.toString("base64")].join(
    ":",
  );
}

export function decryptSecret(payload: string, key: Buffer): string {
  const [version, iv, tag, content] = payload.split(":");
  if (version !== VERSION || !iv || !tag || !content) {
    throw new Error("Segredo cifrado em formato desconhecido.");
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(content, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export function encryptJson(value: unknown, key: Buffer): string {
  return encryptSecret(JSON.stringify(value), key);
}

export function decryptJson<T = unknown>(payload: string, key: Buffer): T {
  return JSON.parse(decryptSecret(payload, key)) as T;
}
