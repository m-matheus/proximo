/**
 * Tipos de domínio compartilhados por agenda, agente, API e painel.
 * Não dependem de banco nem de provider: servem para os dois cenários de agenda.
 */

export const APPOINTMENT_STATUSES = [
  "scheduled",
  "confirmed",
  "completed",
  "cancelled",
  "no_show",
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

/** Status que ocupam horário na agenda. */
export const ACTIVE_APPOINTMENT_STATUSES = [
  "scheduled",
  "confirmed",
] as const satisfies readonly AppointmentStatus[];

export type AppointmentSource = "agent" | "panel" | "external";

/** Dia da semana ISO, como no Luxon: 1 = segunda ... 7 = domingo. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export const ISO_WEEKDAYS: readonly IsoWeekday[] = [1, 2, 3, 4, 5, 6, 7];

/** Faixa de minutos desde a meia-noite local. O fim é exclusivo. */
export interface MinuteRange {
  startMinute: number;
  endMinute: number;
}

export type WeeklyHours = Record<IsoWeekday, MinuteRange[]>;

export interface ServiceOffering {
  professionalId: string;
  durationMinutes: number;
  priceCents: number;
}

export interface Service {
  id: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  bufferMinutes: number;
  priceCents: number;
  /** Profissionais que fazem o serviço, com duração e preço efetivos de cada um. */
  offerings: ServiceOffering[];
}

export interface Professional {
  id: string;
  name: string;
}

export interface Slot {
  professionalId: string;
  startsAt: Date;
  endsAt: Date;
}

export interface Appointment {
  id: string;
  serviceId: string;
  serviceName: string;
  professionalId: string;
  professionalName: string;
  customerId: string | null;
  customerName: string | null;
  startsAt: Date;
  endsAt: Date;
  status: AppointmentStatus;
  priceCents: number;
  source: AppointmentSource;
}

/** Cliente como o Próximo o conhece. Providers externos usam nome e telefone. */
export interface CustomerRef {
  id: string;
  name: string;
  phoneE164: string | null;
}

export interface NewAppointment {
  serviceId: string;
  professionalId: string;
  startsAt: Date;
  customer: CustomerRef;
  source: Exclude<AppointmentSource, "external">;
  notes?: string;
}

export interface AvailabilityQuery {
  serviceId: string;
  /** Sem profissional, qualquer um que faça o serviço serve. */
  professionalId?: string;
  from: Date;
  to: Date;
  /** Ignora este agendamento, para remarcar sem conflitar com ele mesmo. */
  excludeAppointmentId?: string;
}

export interface CustomerAppointmentsQuery {
  customer: { id?: string; phoneE164?: string | null };
  includePast?: boolean;
}

export interface AppointmentsRangeQuery {
  from: Date;
  to: Date;
  professionalId?: string;
}

/** Regras de agendamento de um negócio. */
export interface BookingRules {
  timezone: string;
  minLeadMinutes: number;
  maxAdvanceDays: number;
  slotIntervalMinutes: number;
}
