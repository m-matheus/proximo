import { DateTime } from "luxon";
import type { IsoWeekday } from "./types";

export const WEEKDAY_NAMES_PT: Record<IsoWeekday, string> = {
  1: "segunda",
  2: "terça",
  3: "quarta",
  4: "quinta",
  5: "sexta",
  6: "sábado",
  7: "domingo",
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function toZoned(date: Date, timezone: string): DateTime<true> {
  const zoned = DateTime.fromJSDate(date, { zone: timezone });
  if (!zoned.isValid) {
    throw new Error(`Data ou fuso inválido: ${timezone}`);
  }
  return zoned;
}

/**
 * Converte data e hora locais do negócio para um instante UTC.
 * Devolve null para formato inválido ou horário que não existe no fuso.
 */
export function localDateTimeToDate(date: string, time: string, timezone: string): Date | null {
  if (!DATE_PATTERN.test(date) || !TIME_PATTERN.test(time)) {
    return null;
  }
  const local = DateTime.fromISO(`${date}T${time}`, { zone: timezone });
  if (!local.isValid) {
    return null;
  }
  // Em transições de horário de verão o Luxon desloca a hora inexistente.
  if (local.toISODate() !== date || local.toFormat("HH:mm") !== time) {
    return null;
  }
  return local.toJSDate();
}

/** "2026-10-01" no fuso do negócio. */
export function localDateString(date: Date, timezone: string): string {
  return toZoned(date, timezone).toFormat("yyyy-MM-dd");
}

/** "09:00" no fuso do negócio. */
export function formatTime(date: Date, timezone: string): string {
  return toZoned(date, timezone).toFormat("HH:mm");
}

/** "qua 01/10" no fuso do negócio. */
export function formatShortDate(date: Date, timezone: string): string {
  const zoned = toZoned(date, timezone);
  const weekday = WEEKDAY_NAMES_PT[zoned.weekday as IsoWeekday].slice(0, 3);
  return `${weekday} ${zoned.toFormat("dd/MM")}`;
}

/** "quarta, 01/10" no fuso do negócio. */
export function formatDateLong(date: Date, timezone: string): string {
  const zoned = toZoned(date, timezone);
  const weekday = WEEKDAY_NAMES_PT[zoned.weekday as IsoWeekday];
  return `${weekday}, ${zoned.toFormat("dd/MM")}`;
}

/** "quarta, 01/10 às 09:00" no fuso do negócio. */
export function formatDateTimeLong(date: Date, timezone: string): string {
  return `${formatDateLong(date, timezone)} às ${formatTime(date, timezone)}`;
}

export function minutesToTime(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

export function timeToMinutes(time: string): number | null {
  const match = TIME_PATTERN.exec(time);
  if (!match) {
    return null;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}
