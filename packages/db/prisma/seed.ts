import { loadRootEnv, parseEncryptionKey } from "@proximo/core";
import { createDb } from "../src/client";
import { seedDemoBusiness } from "../src/demo";

loadRootEnv();

const db = createDb(process.env.DATABASE_URL ?? "");

const phoneNumberId = process.env.WHATSAPP_DEMO_PHONE_NUMBER_ID;
const accessToken = process.env.WHATSAPP_DEMO_ACCESS_TOKEN;

const demo = await seedDemoBusiness(db, {
  whatsapp:
    phoneNumberId && accessToken
      ? {
          phoneNumberId,
          accessToken,
          wabaId: process.env.WHATSAPP_DEMO_WABA_ID || undefined,
          encryptionKey: parseEncryptionKey(process.env.ENCRYPTION_KEY),
        }
      : undefined,
});

console.log(
  demo.created
    ? `Barbearia Exemplo criada (${demo.businessId}).`
    : `Barbearia Exemplo já existia (${demo.businessId}).`,
);
console.log(
  demo.whatsappChannelId
    ? "Canal do WhatsApp configurado."
    : "Sem WHATSAPP_DEMO_PHONE_NUMBER_ID e WHATSAPP_DEMO_ACCESS_TOKEN: só o simulador foi configurado.",
);

await db.$disconnect();
