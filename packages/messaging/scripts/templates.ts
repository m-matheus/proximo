import { loadRootEnv } from "@proximo/core";
import { PROXIMO_TEMPLATES } from "../src/templates";
import { templateCreationPayload, WhatsAppTemplateManager } from "../src/whatsapp-cloud/templates";

/**
 * Templates do Próximo na conta do WhatsApp de WHATSAPP_DEMO_*.
 *
 *   pnpm whatsapp:templates            mostra o status de cada template (só leitura)
 *   pnpm whatsapp:templates --print    mostra o que --create enviaria, sem chamar a Meta
 *   pnpm whatsapp:templates --create   envia para análise os templates que faltam
 */

loadRootEnv();

const args = new Set(process.argv.slice(2));

if (args.has("--print")) {
  for (const template of PROXIMO_TEMPLATES) {
    console.log(JSON.stringify(templateCreationPayload(template), null, 2));
  }
  process.exit(0);
}

const wabaId = process.env.WHATSAPP_DEMO_WABA_ID;
const accessToken = process.env.WHATSAPP_DEMO_ACCESS_TOKEN;
if (!wabaId || !accessToken) {
  console.error("Preencha WHATSAPP_DEMO_WABA_ID e WHATSAPP_DEMO_ACCESS_TOKEN no .env.");
  process.exit(1);
}

const manager = new WhatsAppTemplateManager({
  wabaId,
  accessToken,
  graphApiVersion: process.env.WHATSAPP_GRAPH_API_VERSION || "v26.0",
});
const create = args.has("--create");

for (const template of PROXIMO_TEMPLATES) {
  const label = `${template.name} (${template.languageCode})`;
  const existing = (await manager.find(template.name)).find(
    (item) => item.language === template.languageCode,
  );
  if (existing) {
    const reason = existing.rejectedReason ? `, motivo: ${existing.rejectedReason}` : "";
    console.log(`${label}: ${existing.status}, categoria ${existing.category}${reason}`);
    continue;
  }
  if (!create) {
    console.log(`${label}: não existe na conta. Rode com --create para enviar.`);
    continue;
  }
  const created = await manager.create(template);
  console.log(`${label}: enviado, ${created.status}, categoria ${created.category}`);
}
