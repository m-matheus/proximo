import { seedDemoBusiness } from "@proximo/db";
import { createTestDb, resetTestDatabase } from "@proximo/db/testing";
import { afterAll } from "vitest";
import { createSchedulingProvider } from "../src/factory";
import { CONTRACT_NOW, describeSchedulingProviderContract } from "../src/testing";

const db = createTestDb();

afterAll(async () => {
  await db.$disconnect();
});

describeSchedulingProviderContract("interno com Postgres", async () => {
  await resetTestDatabase(db);
  const demo = await seedDemoBusiness(db);
  const business = await db.business.findUniqueOrThrow({ where: { id: demo.businessId } });
  const customer = await db.customer.create({
    data: {
      businessId: business.id,
      waId: "555199998888",
      phoneE164: "+5551999998888",
      name: "Ana",
    },
  });
  return {
    provider: createSchedulingProvider(business, { db, now: () => CONTRACT_NOW }),
    services: { corte: demo.services.Corte ?? "", sobrancelha: demo.services.Sobrancelha ?? "" },
    professionals: demo.professionals,
    customer: { id: customer.id, name: "Ana", phoneE164: customer.phoneE164 },
  };
});
