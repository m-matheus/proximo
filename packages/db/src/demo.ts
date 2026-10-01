import { encryptJson, getSegmentProfile } from "@proximo/core";
import type { Db } from "./client";

/**
 * Barbearia de exemplo usada pelo seed e pelos testes.
 *
 * - Terça a sexta: 09:00-12:00 e 13:00-19:00. Sábado: 08:00-17:00.
 * - Carlos faz todos os serviços e segue o horário da casa.
 * - Marcos faz corte, barba e corte e barba, e só trabalha de quarta a sábado.
 */

export interface DemoWhatsAppChannel {
  phoneNumberId: string;
  accessToken: string;
  wabaId?: string;
  displayPhone?: string;
  encryptionKey: Buffer;
}

export interface DemoBusinessOptions {
  slug?: string;
  name?: string;
  whatsapp?: DemoWhatsAppChannel;
}

export interface DemoBusiness {
  businessId: string;
  created: boolean;
  simulatorChannelId: string;
  whatsappChannelId: string | null;
  professionals: { carlos: string; marcos: string };
  services: Record<string, string>;
}

const BUSINESS_HOURS = [
  ...[2, 3, 4, 5].flatMap((weekday) => [
    { weekday, startMinute: 9 * 60, endMinute: 12 * 60 },
    { weekday, startMinute: 13 * 60, endMinute: 19 * 60 },
  ]),
  { weekday: 6, startMinute: 8 * 60, endMinute: 17 * 60 },
];

const MARCOS_HOURS = BUSINESS_HOURS.filter((hours) => hours.weekday >= 3);
const MARCOS_SERVICES = new Set(["Corte", "Barba", "Corte e barba"]);

export async function seedDemoBusiness(
  db: Db,
  options: DemoBusinessOptions = {},
): Promise<DemoBusiness> {
  const slug = options.slug ?? "barbearia-exemplo";
  const include = {
    professionals: true,
    services: true,
    channels: { where: { type: "simulator" as const } },
  };
  const existing = await db.business.findUnique({ where: { slug }, include });
  let business = existing;
  if (!business) {
    const id = await createCatalog(db, slug, options.name ?? "Barbearia Exemplo");
    business = await db.business.findUniqueOrThrow({ where: { id }, include });
  }

  const simulator =
    business.channels[0] ??
    (await db.channel.create({
      data: {
        businessId: business.id,
        type: "simulator",
        externalId: `sim-${slug}`,
        displayPhone: "Simulador",
      },
    }));

  let whatsappChannelId: string | null = null;
  if (options.whatsapp) {
    const { phoneNumberId, accessToken, wabaId, displayPhone, encryptionKey } = options.whatsapp;
    const credentials = encryptJson({ accessToken }, encryptionKey);
    const channel = await db.channel.upsert({
      where: { type_externalId: { type: "whatsapp_cloud", externalId: phoneNumberId } },
      update: { credentials, wabaId: wabaId ?? null, displayPhone: displayPhone ?? null },
      create: {
        businessId: business.id,
        type: "whatsapp_cloud",
        externalId: phoneNumberId,
        credentials,
        wabaId: wabaId ?? null,
        displayPhone: displayPhone ?? null,
      },
    });
    whatsappChannelId = channel.id;
  }

  const byName = (name: string) => business.professionals.find((p) => p.name === name)?.id ?? "";

  return {
    businessId: business.id,
    created: !existing,
    simulatorChannelId: simulator.id,
    whatsappChannelId,
    professionals: { carlos: byName("Carlos"), marcos: byName("Marcos") },
    services: Object.fromEntries(business.services.map((service) => [service.name, service.id])),
  };
}

async function createCatalog(db: Db, slug: string, name: string): Promise<string> {
  return db.$transaction(async (tx) => {
    const business = await tx.business.create({
      data: {
        name,
        slug,
        segment: "barbershop",
        timezone: "America/Sao_Paulo",
        address: "Rua Exemplo, 123, Centro, Porto Alegre, RS",
        minLeadMinutes: 60,
        maxAdvanceDays: 30,
        slotIntervalMinutes: 30,
      },
    });

    const carlos = await tx.professional.create({
      data: { businessId: business.id, name: "Carlos", color: "#2563eb", sortOrder: 0 },
    });
    const marcos = await tx.professional.create({
      data: { businessId: business.id, name: "Marcos", color: "#16a34a", sortOrder: 1 },
    });

    const suggestions = getSegmentProfile("barbershop").suggestedServices;
    for (const [index, suggestion] of suggestions.entries()) {
      const service = await tx.service.create({
        data: {
          businessId: business.id,
          name: suggestion.name,
          durationMinutes: suggestion.durationMinutes,
          priceCents: suggestion.priceCents,
          sortOrder: index,
        },
      });
      await tx.professionalService.create({
        data: { businessId: business.id, professionalId: carlos.id, serviceId: service.id },
      });
      if (MARCOS_SERVICES.has(suggestion.name)) {
        await tx.professionalService.create({
          data: { businessId: business.id, professionalId: marcos.id, serviceId: service.id },
        });
      }
    }

    await tx.workingHours.createMany({
      data: BUSINESS_HOURS.map((hours) => ({ ...hours, businessId: business.id })),
    });
    await tx.workingHours.createMany({
      data: MARCOS_HOURS.map((hours) => ({
        ...hours,
        businessId: business.id,
        professionalId: marcos.id,
      })),
    });

    return business.id;
  });
}
