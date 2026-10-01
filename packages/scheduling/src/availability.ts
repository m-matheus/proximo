import type { BookingRules, IsoWeekday, MinuteRange, Slot, WeeklyHours } from "@proximo/core";
import { DateTime } from "luxon";

/**
 * Motor de disponibilidade. Função pura: recebe regras, horários, bloqueios e
 * agendamentos e devolve os horários livres. Todos os providers que calculam
 * agenda própria usam este motor, então o que é oferecido é o que a criação aceita.
 *
 * Regras:
 * - Horários começam no início de cada faixa de trabalho, a cada `slotIntervalMinutes`.
 * - O atendimento precisa terminar até o fim da faixa.
 * - A folga do serviço (buffer) conta depois do atendimento só contra outros agendamentos.
 * - Bloqueios sem profissional fecham o negócio inteiro.
 * - Respeita a antecedência mínima e o limite de dias à frente.
 */

export interface AvailabilityProfessional {
  id: string;
  durationMinutes: number;
  bufferMinutes: number;
  weeklyHours: WeeklyHours;
}

export interface TimeSpan {
  startsAt: Date;
  endsAt: Date;
}

export interface AvailabilityInput {
  now: Date;
  rules: BookingRules;
  range: { from: Date; to: Date };
  professionals: AvailabilityProfessional[];
  blocks: Array<TimeSpan & { professionalId: string | null }>;
  busy: Array<TimeSpan & { professionalId: string }>;
}

const MINUTE = 60_000;

export function emptyWeeklyHours(): WeeklyHours {
  return { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [] };
}

function overlaps(startA: number, endA: number, startB: number, endB: number): boolean {
  return startA < endB && startB < endA;
}

function localInstant(day: DateTime, minuteOfDay: number): DateTime | null {
  if (minuteOfDay >= 1440) {
    return day.plus({ days: 1 }).startOf("day");
  }
  const instant = day.set({
    hour: Math.floor(minuteOfDay / 60),
    minute: minuteOfDay % 60,
    second: 0,
    millisecond: 0,
  });
  return instant.isValid ? instant : null;
}

export function computeAvailableSlots(input: AvailabilityInput): Slot[] {
  const { now, rules, range } = input;
  const earliest = Math.max(range.from.getTime(), now.getTime() + rules.minLeadMinutes * MINUTE);
  const latest = Math.min(
    range.to.getTime(),
    now.getTime() + rules.maxAdvanceDays * 24 * 60 * MINUTE,
  );
  if (earliest >= latest) {
    return [];
  }

  const interval = Math.max(1, rules.slotIntervalMinutes);
  const firstDay = DateTime.fromMillis(earliest, { zone: rules.timezone }).startOf("day");
  const lastDay = DateTime.fromMillis(latest, { zone: rules.timezone }).startOf("day");

  const found: Array<{ order: number; slot: Slot }> = [];
  const seen = new Set<string>();

  for (const [order, professional] of input.professionals.entries()) {
    const blocks = input.blocks
      .filter((block) => block.professionalId === null || block.professionalId === professional.id)
      .map((block) => [block.startsAt.getTime(), block.endsAt.getTime()] as const);
    const busy = input.busy
      .filter((item) => item.professionalId === professional.id)
      .map((item) => [item.startsAt.getTime(), item.endsAt.getTime()] as const);

    for (let day = firstDay; day <= lastDay; day = day.plus({ days: 1 })) {
      const ranges: MinuteRange[] = professional.weeklyHours[day.weekday as IsoWeekday] ?? [];
      for (const workRange of ranges) {
        const windowEnd = localInstant(day, workRange.endMinute)?.toMillis();
        if (windowEnd === undefined) {
          continue;
        }
        for (
          let minute = workRange.startMinute;
          minute + professional.durationMinutes <= workRange.endMinute;
          minute += interval
        ) {
          const start = localInstant(day, minute)?.toMillis();
          if (start === undefined || start < earliest || start >= latest) {
            continue;
          }
          const end = start + professional.durationMinutes * MINUTE;
          const occupiedEnd = end + professional.bufferMinutes * MINUTE;
          if (end > windowEnd) {
            continue;
          }
          if (blocks.some(([blockStart, blockEnd]) => overlaps(start, end, blockStart, blockEnd))) {
            continue;
          }
          if (
            busy.some(([busyStart, busyEnd]) => overlaps(start, occupiedEnd, busyStart, busyEnd))
          ) {
            continue;
          }
          const key = `${professional.id}:${start}`;
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          found.push({
            order,
            slot: {
              professionalId: professional.id,
              startsAt: new Date(start),
              endsAt: new Date(end),
            },
          });
        }
      }
    }
  }

  return found
    .sort((a, b) => a.slot.startsAt.getTime() - b.slot.startsAt.getTime() || a.order - b.order)
    .map((item) => item.slot);
}

/** Agrupa linhas de horário semanal, com ou sem profissional, em WeeklyHours. */
export function toWeeklyHours(
  rows: ReadonlyArray<{ weekday: number; startMinute: number; endMinute: number }>,
): WeeklyHours {
  const weekly = emptyWeeklyHours();
  for (const row of rows) {
    if (row.weekday >= 1 && row.weekday <= 7) {
      weekly[row.weekday as IsoWeekday].push({
        startMinute: row.startMinute,
        endMinute: row.endMinute,
      });
    }
  }
  for (const ranges of Object.values(weekly)) {
    ranges.sort((a, b) => a.startMinute - b.startMinute);
  }
  return weekly;
}

export function hasAnyHours(weekly: WeeklyHours): boolean {
  return Object.values(weekly).some((ranges) => ranges.length > 0);
}
