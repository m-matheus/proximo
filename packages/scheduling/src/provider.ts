import type {
  Appointment,
  AppointmentsRangeQuery,
  AvailabilityQuery,
  CustomerAppointmentsQuery,
  NewAppointment,
  Professional,
  Service,
  Slot,
  WeeklyHours,
} from "@proximo/core";

export type SchedulingProviderKind = "internal" | "appbarber";

export interface ProviderCapabilities {
  /** Serviços, profissionais, horários e bloqueios são editados no painel do Próximo. */
  manageCatalog: boolean;
  /** O sistema de agenda já manda lembretes ao cliente. Evita lembrete duplicado. */
  sendsOwnReminders: boolean;
}

/**
 * Contrato da agenda de um negócio. O agente, o painel e os lembretes só falam
 * com a agenda por aqui, então trocar de sistema não mexe neles.
 *
 * Cada instância pertence a um único negócio: nenhum método recebe ID de negócio.
 * Erros de regra usam as classes de @proximo/core, com mensagem em português.
 */
export interface SchedulingProvider {
  readonly kind: SchedulingProviderKind;
  readonly capabilities: ProviderCapabilities;

  listServices(): Promise<Service[]>;
  listProfessionals(filter?: { serviceId?: string }): Promise<Professional[]>;
  /** Horário de funcionamento do negócio. */
  getOpeningHours(): Promise<WeeklyHours>;
  /** Horários livres. Nunca devolve horário que a criação recusaria. */
  getAvailability(query: AvailabilityQuery): Promise<Slot[]>;
  /** Revalida o horário. Lança SlotUnavailableError se ele não estiver livre. */
  createAppointment(input: NewAppointment): Promise<Appointment>;
  rescheduleAppointment(
    appointmentId: string,
    change: { startsAt: Date; professionalId?: string },
  ): Promise<Appointment>;
  cancelAppointment(appointmentId: string, reason?: string): Promise<Appointment>;
  /** Registra que o cliente confirmou presença. O horário continua ocupado. */
  confirmAppointment(appointmentId: string): Promise<Appointment>;
  getAppointment(appointmentId: string): Promise<Appointment | null>;
  /** Agendamentos de um cliente, pelo ID interno ou pelo telefone. Por padrão, só os futuros. */
  findCustomerAppointments(query: CustomerAppointmentsQuery): Promise<Appointment[]>;
  /** Agenda de um período, para o painel e para os lembretes. */
  listAppointments(query: AppointmentsRangeQuery): Promise<Appointment[]>;
}
