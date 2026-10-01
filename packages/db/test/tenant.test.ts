import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { seedDemoBusiness } from "../src/demo";
import { isAppointmentOverlapError } from "../src/errors";
import { scopeToBusiness, TenantScopeError } from "../src/tenant";
import { createTestDb, resetTestDatabase } from "../src/testing";

const db = createTestDb();

afterAll(async () => {
  await db.$disconnect();
});

beforeEach(async () => {
  await resetTestDatabase(db);
});

describe("escopo de tenant", () => {
  it("só enxerga dados do próprio negócio", async () => {
    const a = await seedDemoBusiness(db, { slug: "negocio-a" });
    const b = await seedDemoBusiness(db, { slug: "negocio-b" });

    const scopedA = scopeToBusiness(db, a.businessId);
    const professionals = await scopedA.professional.findMany();
    expect(professionals).toHaveLength(2);
    expect(professionals.every((p) => p.businessId === a.businessId)).toBe(true);

    const fromOther = await scopedA.professional.findUnique({
      where: { id: b.professionals.carlos },
    });
    expect(fromOther).toBeNull();

    const updated = await scopedA.service.updateMany({ data: { active: false } });
    const stillActiveInB = await db.service.count({
      where: { businessId: b.businessId, active: true },
    });
    expect(updated.count).toBeGreaterThan(0);
    expect(stillActiveInB).toBeGreaterThan(0);
  });

  it("preenche o businessId nas criações e recusa outro negócio", async () => {
    const a = await seedDemoBusiness(db, { slug: "negocio-a" });
    const b = await seedDemoBusiness(db, { slug: "negocio-b" });
    const scopedA = scopeToBusiness(db, a.businessId);

    const customer = await scopedA.customer.create({
      data: { businessId: a.businessId, waId: "5551999998888", name: "Ana" },
    });
    expect(customer.businessId).toBe(a.businessId);

    await expect(
      scopedA.customer.create({ data: { businessId: b.businessId, waId: "5551911112222" } }),
    ).rejects.toBeInstanceOf(TenantScopeError);
  });
});

describe("restrições do banco", () => {
  it("impede agendamento que aponta para profissional de outro negócio", async () => {
    const a = await seedDemoBusiness(db, { slug: "negocio-a" });
    const b = await seedDemoBusiness(db, { slug: "negocio-b" });
    const customer = await db.customer.create({
      data: { businessId: a.businessId, waId: "5551999998888" },
    });

    await expect(
      db.appointment.create({
        data: {
          businessId: a.businessId,
          customerId: customer.id,
          professionalId: b.professionals.carlos,
          serviceId: a.services.Corte ?? "",
          startsAt: new Date("2026-10-01T12:00:00Z"),
          endsAt: new Date("2026-10-01T12:30:00Z"),
          source: "agent",
          priceCents: 4500,
        },
      }),
    ).rejects.toThrow();
  });

  it("impede dois agendamentos ativos sobrepostos para o mesmo profissional", async () => {
    const a = await seedDemoBusiness(db);
    const customer = await db.customer.create({
      data: { businessId: a.businessId, waId: "5551999998888" },
    });
    const base = {
      businessId: a.businessId,
      customerId: customer.id,
      professionalId: a.professionals.carlos,
      serviceId: a.services.Corte ?? "",
      source: "agent" as const,
      priceCents: 4500,
    };

    const first = await db.appointment.create({
      data: {
        ...base,
        startsAt: new Date("2026-10-01T12:00:00Z"),
        endsAt: new Date("2026-10-01T12:30:00Z"),
      },
    });

    const overlapping = db.appointment.create({
      data: {
        ...base,
        startsAt: new Date("2026-10-01T12:15:00Z"),
        endsAt: new Date("2026-10-01T12:45:00Z"),
      },
    });
    const error = await overlapping.then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).not.toBeNull();
    expect(isAppointmentOverlapError(error)).toBe(true);

    // Encostado no fim do anterior pode.
    await db.appointment.create({
      data: {
        ...base,
        startsAt: new Date("2026-10-01T12:30:00Z"),
        endsAt: new Date("2026-10-01T13:00:00Z"),
      },
    });

    // Cancelado libera o horário.
    await db.appointment.update({ where: { id: first.id }, data: { status: "cancelled" } });
    await db.appointment.create({
      data: {
        ...base,
        startsAt: new Date("2026-10-01T12:00:00Z"),
        endsAt: new Date("2026-10-01T12:30:00Z"),
      },
    });
  });
});
