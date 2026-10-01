import { describe, expect, it } from "vitest";
import {
  formatDateTimeLong,
  formatShortDate,
  formatTime,
  localDateString,
  localDateTimeToDate,
  minutesToTime,
  timeToMinutes,
} from "../src/time";

const SP = "America/Sao_Paulo";

describe("localDateTimeToDate", () => {
  it("converte hora local de São Paulo para UTC", () => {
    const date = localDateTimeToDate("2026-10-01", "09:00", SP);
    expect(date?.toISOString()).toBe("2026-10-01T12:00:00.000Z");
  });

  it("recusa formatos inválidos", () => {
    expect(localDateTimeToDate("01/10/2026", "09:00", SP)).toBeNull();
    expect(localDateTimeToDate("2026-10-01", "9h", SP)).toBeNull();
    expect(localDateTimeToDate("2026-02-30", "09:00", SP)).toBeNull();
  });

  it("recusa hora que não existe por horário de verão", () => {
    // Nova York pulou de 02:00 para 03:00 em 08/03/2026.
    expect(localDateTimeToDate("2026-03-08", "02:30", "America/New_York")).toBeNull();
  });
});

describe("formatação em pt-BR", () => {
  // 01/10/2026 é uma quinta-feira.
  const instant = new Date("2026-10-01T12:00:00.000Z");

  it("formata data, hora e dia da semana no fuso do negócio", () => {
    expect(localDateString(instant, SP)).toBe("2026-10-01");
    expect(formatTime(instant, SP)).toBe("09:00");
    expect(formatShortDate(instant, SP)).toBe("qui 01/10");
    expect(formatDateTimeLong(instant, SP)).toBe("quinta, 01/10 às 09:00");
  });

  it("converte minutos e horas", () => {
    expect(minutesToTime(570)).toBe("09:30");
    expect(timeToMinutes("09:30")).toBe(570);
    expect(timeToMinutes("25:00")).toBeNull();
  });
});
