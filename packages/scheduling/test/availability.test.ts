import { localDateTimeToDate, type WeeklyHours } from "@proximo/core";
import { describe, expect, it } from "vitest";
import {
  type AvailabilityInput,
  computeAvailableSlots,
  emptyWeeklyHours,
  toWeeklyHours,
} from "../src/availability";

const TZ = "America/Sao_Paulo";

function at(date: string, time: string): Date {
  const instant = localDateTimeToDate(date, time, TZ);
  if (!instant) {
    throw new Error("data inválida");
  }
  return instant;
}

function times(slots: Array<{ startsAt: Date }>): string[] {
  return slots.map((slot) =>
    slot.startsAt.toLocaleTimeString("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }),
  );
}

// Quinta, 01/10/2026: 09:00-12:00 e 13:00-19:00.
const weekdays: WeeklyHours = {
  ...emptyWeeklyHours(),
  4: [
    { startMinute: 540, endMinute: 720 },
    { startMinute: 780, endMinute: 1140 },
  ],
};

function input(overrides: Partial<AvailabilityInput> = {}): AvailabilityInput {
  return {
    now: at("2026-09-29", "08:00"),
    rules: { timezone: TZ, minLeadMinutes: 60, maxAdvanceDays: 30, slotIntervalMinutes: 30 },
    range: { from: at("2026-10-01", "00:00"), to: at("2026-10-02", "00:00") },
    professionals: [{ id: "p1", durationMinutes: 30, bufferMinutes: 0, weeklyHours: weekdays }],
    blocks: [],
    busy: [],
    ...overrides,
  };
}

describe("computeAvailableSlots", () => {
  it("gera horários dentro de cada faixa, no intervalo configurado", () => {
    const result = times(computeAvailableSlots(input()));
    expect(result.slice(0, 3)).toEqual(["09:00", "09:30", "10:00"]);
    expect(result).toContain("11:30");
    expect(result).not.toContain("12:00");
    expect(result.at(-1)).toBe("18:30");
  });

  it("exige que o atendimento termine antes do fim da faixa", () => {
    const result = times(
      computeAvailableSlots(
        input({
          professionals: [
            { id: "p1", durationMinutes: 60, bufferMinutes: 0, weeklyHours: weekdays },
          ],
        }),
      ),
    );
    expect(result).toContain("11:00");
    expect(result).not.toContain("11:30");
    expect(result.at(-1)).toBe("18:00");
  });

  it("respeita a antecedência mínima", () => {
    const result = times(computeAvailableSlots(input({ now: at("2026-10-01", "09:10") })));
    expect(result[0]).toBe("10:30");
  });

  it("respeita o limite de dias à frente", () => {
    const rules = { timezone: TZ, minLeadMinutes: 60, maxAdvanceDays: 1, slotIntervalMinutes: 30 };
    expect(computeAvailableSlots(input({ rules }))).toEqual([]);
  });

  it("remove horários bloqueados, do profissional ou do negócio todo", () => {
    const result = times(
      computeAvailableSlots(
        input({
          blocks: [
            {
              professionalId: "p1",
              startsAt: at("2026-10-01", "09:00"),
              endsAt: at("2026-10-01", "10:00"),
            },
            {
              professionalId: null,
              startsAt: at("2026-10-01", "15:00"),
              endsAt: at("2026-10-01", "16:00"),
            },
            {
              professionalId: "outro",
              startsAt: at("2026-10-01", "17:00"),
              endsAt: at("2026-10-01", "18:00"),
            },
          ],
        }),
      ),
    );
    expect(result[0]).toBe("10:00");
    expect(result).not.toContain("15:00");
    expect(result).not.toContain("15:30");
    expect(result).toContain("17:00");
  });

  it("considera a folga do serviço contra agendamentos existentes", () => {
    const busy = [
      {
        professionalId: "p1",
        startsAt: at("2026-10-01", "10:00"),
        endsAt: at("2026-10-01", "10:30"),
      },
    ];
    const withoutBuffer = times(computeAvailableSlots(input({ busy })));
    expect(withoutBuffer).toContain("09:30");
    expect(withoutBuffer).not.toContain("10:00");

    const withBuffer = times(
      computeAvailableSlots(
        input({
          busy,
          professionals: [
            { id: "p1", durationMinutes: 30, bufferMinutes: 10, weeklyHours: weekdays },
          ],
        }),
      ),
    );
    expect(withBuffer).not.toContain("09:30");
    expect(withBuffer).toContain("10:30");
  });

  it("ordena por horário e, no empate, pela ordem dos profissionais", () => {
    const slots = computeAvailableSlots(
      input({
        professionals: [
          { id: "p1", durationMinutes: 30, bufferMinutes: 0, weeklyHours: weekdays },
          { id: "p2", durationMinutes: 30, bufferMinutes: 0, weeklyHours: weekdays },
        ],
      }),
    );
    expect(slots.slice(0, 2).map((slot) => slot.professionalId)).toEqual(["p1", "p2"]);
  });

  it("não gera nada em dia sem expediente", () => {
    const saturday = { from: at("2026-10-03", "00:00"), to: at("2026-10-04", "00:00") };
    expect(computeAvailableSlots(input({ range: saturday }))).toEqual([]);
  });
});

describe("toWeeklyHours", () => {
  it("agrupa e ordena as faixas por dia", () => {
    const weekly = toWeeklyHours([
      { weekday: 2, startMinute: 780, endMinute: 1140 },
      { weekday: 2, startMinute: 540, endMinute: 720 },
    ]);
    expect(weekly[2]).toEqual([
      { startMinute: 540, endMinute: 720 },
      { startMinute: 780, endMinute: 1140 },
    ]);
    expect(weekly[3]).toEqual([]);
  });
});
