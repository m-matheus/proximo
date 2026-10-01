import {
  type CustomerRef,
  InvalidInputError,
  localDateTimeToDate,
  NotAllowedError,
  SlotUnavailableError,
  type WeeklyHours,
} from "@proximo/core";
import { beforeEach, describe, expect, it } from "vitest";
import type { SchedulingProvider } from "../provider";
import type { InMemoryCatalog } from "./in-memory-provider";

/**
 * Suíte de contrato: todo SchedulingProvider precisa passar nela.
 *
 * Usa a mesma barbearia de exemplo do seed (@proximo/db, seedDemoBusiness):
 * - terça a sexta 09:00-12:00 e 13:00-19:00, sábado 08:00-17:00;
 * - Carlos faz tudo; Marcos faz corte, barba e corte e barba, de quarta a sábado;
 * - relógio parado na terça, 29/09/2026, 08:00 de Brasília.
 */

export const CONTRACT_TIMEZONE = "America/Sao_Paulo";
export const CONTRACT_NOW = new Date("2026-09-29T11:00:00.000Z");

export interface ContractFixture {
  provider: SchedulingProvider;
  services: { corte: string; sobrancelha: string };
  professionals: { carlos: string; marcos: string };
  customer: CustomerRef;
}

function at(date: string, time: string): Date {
  const instant = localDateTimeToDate(date, time, CONTRACT_TIMEZONE);
  if (!instant) {
    throw new Error(`Data inválida no teste: ${date} ${time}`);
  }
  return instant;
}

function hhmm(date: Date): string {
  return date.toLocaleTimeString("pt-BR", {
    timeZone: CONTRACT_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function describeSchedulingProviderContract(
  name: string,
  setup: () => Promise<ContractFixture>,
): void {
  describe(`contrato do SchedulingProvider: ${name}`, () => {
    let f: ContractFixture;
    const thursday = { from: at("2026-10-01", "00:00"), to: at("2026-10-02", "00:00") };

    beforeEach(async () => {
      f = await setup();
    });

    it("lista serviços com quem faz cada um", async () => {
      const services = await f.provider.listServices();
      const corte = services.find((service) => service.id === f.services.corte);
      const sobrancelha = services.find((service) => service.id === f.services.sobrancelha);
      expect(corte?.offerings.map((o) => o.professionalId).sort()).toEqual(
        [f.professionals.carlos, f.professionals.marcos].sort(),
      );
      expect(sobrancelha?.offerings.map((o) => o.professionalId)).toEqual([f.professionals.carlos]);
      const professionals = await f.provider.listProfessionals({
        serviceId: f.services.sobrancelha,
      });
      expect(professionals.map((p) => p.id)).toEqual([f.professionals.carlos]);
    });

    it("informa o horário de funcionamento", async () => {
      const hours = await f.provider.getOpeningHours();
      expect(hours[4]).toEqual([
        { startMinute: 540, endMinute: 720 },
        { startMinute: 780, endMinute: 1140 },
      ]);
      expect(hours[1]).toEqual([]);
    });

    it("oferece horários dentro do expediente, no intervalo configurado", async () => {
      const slots = await f.provider.getAvailability({
        serviceId: f.services.corte,
        professionalId: f.professionals.carlos,
        ...thursday,
      });
      const times = slots.map((slot) => hhmm(slot.startsAt));
      expect(times[0]).toBe("09:00");
      expect(times.at(-1)).toBe("18:30");
      expect(times).toHaveLength(18);
      expect(times).not.toContain("12:00");
      expect(times).not.toContain("12:30");
    });

    it("respeita o horário próprio de cada profissional", async () => {
      const tuesday = { from: at("2026-10-06", "00:00"), to: at("2026-10-07", "00:00") };
      const marcos = await f.provider.getAvailability({
        serviceId: f.services.corte,
        professionalId: f.professionals.marcos,
        ...tuesday,
      });
      const carlos = await f.provider.getAvailability({
        serviceId: f.services.corte,
        professionalId: f.professionals.carlos,
        ...tuesday,
      });
      expect(marcos).toEqual([]);
      expect(carlos.length).toBeGreaterThan(0);
    });

    it("cria agendamento em horário oferecido e tira o horário da lista", async () => {
      const appointment = await f.provider.createAppointment({
        serviceId: f.services.corte,
        professionalId: f.professionals.carlos,
        startsAt: at("2026-10-01", "09:00"),
        customer: f.customer,
        source: "agent",
      });
      expect(appointment.status).toBe("scheduled");
      expect(appointment.serviceName).toBe("Corte");
      expect(appointment.professionalName).toBe("Carlos");
      expect(appointment.endsAt.getTime() - appointment.startsAt.getTime()).toBe(30 * 60_000);

      const slots = await f.provider.getAvailability({
        serviceId: f.services.corte,
        professionalId: f.professionals.carlos,
        ...thursday,
      });
      const times = slots.map((slot) => hhmm(slot.startsAt));
      expect(times).not.toContain("09:00");
      expect(times).toContain("09:30");
    });

    it("recusa horário que não foi oferecido", async () => {
      for (const startsAt of [
        at("2026-10-01", "09:10"),
        at("2026-10-01", "12:00"),
        at("2026-10-05", "10:00"),
      ]) {
        await expect(
          f.provider.createAppointment({
            serviceId: f.services.corte,
            professionalId: f.professionals.carlos,
            startsAt,
            customer: f.customer,
            source: "agent",
          }),
        ).rejects.toBeInstanceOf(SlotUnavailableError);
      }
    });

    it("recusa horário já ocupado", async () => {
      const input = {
        serviceId: f.services.corte,
        professionalId: f.professionals.carlos,
        startsAt: at("2026-10-01", "10:00"),
        customer: f.customer,
        source: "agent" as const,
      };
      await f.provider.createAppointment(input);
      await expect(f.provider.createAppointment(input)).rejects.toBeInstanceOf(
        SlotUnavailableError,
      );
    });

    it("recusa profissional que não faz o serviço", async () => {
      await expect(
        f.provider.createAppointment({
          serviceId: f.services.sobrancelha,
          professionalId: f.professionals.marcos,
          startsAt: at("2026-10-01", "10:00"),
          customer: f.customer,
          source: "agent",
        }),
      ).rejects.toBeInstanceOf(InvalidInputError);
    });

    it("remarca e libera o horário antigo", async () => {
      const created = await f.provider.createAppointment({
        serviceId: f.services.corte,
        professionalId: f.professionals.carlos,
        startsAt: at("2026-10-01", "11:00"),
        customer: f.customer,
        source: "agent",
      });
      const moved = await f.provider.rescheduleAppointment(created.id, {
        startsAt: at("2026-10-02", "09:00"),
      });
      expect(moved.id).toBe(created.id);
      expect(moved.startsAt.getTime()).toBe(at("2026-10-02", "09:00").getTime());
      expect(moved.status).toBe("scheduled");

      const slots = await f.provider.getAvailability({
        serviceId: f.services.corte,
        professionalId: f.professionals.carlos,
        ...thursday,
      });
      expect(slots.map((slot) => hhmm(slot.startsAt))).toContain("11:00");
    });

    it("cancela, libera o horário e não cancela duas vezes", async () => {
      const created = await f.provider.createAppointment({
        serviceId: f.services.corte,
        professionalId: f.professionals.carlos,
        startsAt: at("2026-10-01", "14:00"),
        customer: f.customer,
        source: "agent",
      });
      const cancelled = await f.provider.cancelAppointment(created.id, "cliente desistiu");
      expect(cancelled.status).toBe("cancelled");

      const slots = await f.provider.getAvailability({
        serviceId: f.services.corte,
        professionalId: f.professionals.carlos,
        ...thursday,
      });
      expect(slots.map((slot) => hhmm(slot.startsAt))).toContain("14:00");
      await expect(f.provider.cancelAppointment(created.id)).rejects.toBeInstanceOf(
        NotAllowedError,
      );
    });

    it("busca os próximos agendamentos do cliente por ID e por telefone", async () => {
      const first = await f.provider.createAppointment({
        serviceId: f.services.corte,
        professionalId: f.professionals.carlos,
        startsAt: at("2026-10-02", "15:00"),
        customer: f.customer,
        source: "agent",
      });
      const second = await f.provider.createAppointment({
        serviceId: f.services.corte,
        professionalId: f.professionals.marcos,
        startsAt: at("2026-10-01", "15:00"),
        customer: f.customer,
        source: "agent",
      });
      const cancelled = await f.provider.createAppointment({
        serviceId: f.services.corte,
        professionalId: f.professionals.carlos,
        startsAt: at("2026-10-03", "10:00"),
        customer: f.customer,
        source: "agent",
      });
      await f.provider.cancelAppointment(cancelled.id);

      const byId = await f.provider.findCustomerAppointments({ customer: { id: f.customer.id } });
      expect(byId.map((a) => a.id)).toEqual([second.id, first.id]);

      const byPhone = await f.provider.findCustomerAppointments({
        customer: { phoneE164: f.customer.phoneE164 },
      });
      expect(byPhone.map((a) => a.id)).toEqual([second.id, first.id]);
    });

    it("lista a agenda do período e busca por ID", async () => {
      const created = await f.provider.createAppointment({
        serviceId: f.services.corte,
        professionalId: f.professionals.marcos,
        startsAt: at("2026-10-01", "16:00"),
        customer: f.customer,
        source: "panel",
      });
      const agenda = await f.provider.listAppointments(thursday);
      expect(agenda.map((a) => a.id)).toContain(created.id);
      expect((await f.provider.getAppointment(created.id))?.id).toBe(created.id);
      expect(await f.provider.getAppointment("019999f0-0000-7000-8000-000000000000")).toBeNull();
    });
  });
}

// ---------------------------------------------------------------------------
// A mesma barbearia de exemplo, para o provider em memória.
// ---------------------------------------------------------------------------

const businessHours: WeeklyHours = {
  1: [],
  2: [
    { startMinute: 540, endMinute: 720 },
    { startMinute: 780, endMinute: 1140 },
  ],
  3: [
    { startMinute: 540, endMinute: 720 },
    { startMinute: 780, endMinute: 1140 },
  ],
  4: [
    { startMinute: 540, endMinute: 720 },
    { startMinute: 780, endMinute: 1140 },
  ],
  5: [
    { startMinute: 540, endMinute: 720 },
    { startMinute: 780, endMinute: 1140 },
  ],
  6: [{ startMinute: 480, endMinute: 1020 }],
  7: [],
};

export function demoCatalog(): InMemoryCatalog {
  const marcosHours: WeeklyHours = { ...structuredClone(businessHours), 2: [] };
  return {
    rules: {
      timezone: CONTRACT_TIMEZONE,
      minLeadMinutes: 60,
      maxAdvanceDays: 30,
      slotIntervalMinutes: 30,
    },
    openingHours: structuredClone(businessHours),
    professionals: [
      { id: "prof-carlos", name: "Carlos" },
      { id: "prof-marcos", name: "Marcos", weeklyHours: marcosHours },
    ],
    services: [
      {
        id: "svc-corte",
        name: "Corte",
        durationMinutes: 30,
        priceCents: 4500,
        professionalIds: ["prof-carlos", "prof-marcos"],
      },
      {
        id: "svc-barba",
        name: "Barba",
        durationMinutes: 30,
        priceCents: 3500,
        professionalIds: ["prof-carlos", "prof-marcos"],
      },
      {
        id: "svc-corte-barba",
        name: "Corte e barba",
        durationMinutes: 60,
        priceCents: 7500,
        professionalIds: ["prof-carlos", "prof-marcos"],
      },
      {
        id: "svc-acabamento",
        name: "Acabamento",
        durationMinutes: 15,
        priceCents: 1500,
        professionalIds: ["prof-carlos"],
      },
      {
        id: "svc-sobrancelha",
        name: "Sobrancelha",
        durationMinutes: 15,
        priceCents: 1500,
        professionalIds: ["prof-carlos"],
      },
    ],
    customers: [{ id: "cust-ana", name: "Ana", phoneE164: "+5551999998888" }],
  };
}
