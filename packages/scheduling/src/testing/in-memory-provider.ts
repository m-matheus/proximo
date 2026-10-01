import {
  ACTIVE_APPOINTMENT_STATUSES,
  type Appointment,
  type AppointmentsRangeQuery,
  type AvailabilityQuery,
  type BookingRules,
  type CustomerAppointmentsQuery,
  InvalidInputError,
  type NewAppointment,
  NotAllowedError,
  NotFoundError,
  type Professional,
  type Service,
  type ServiceOffering,
  type Slot,
  SlotUnavailableError,
  type WeeklyHours,
} from "@proximo/core";
import { computeAvailableSlots, emptyWeeklyHours, type TimeSpan } from "../availability";
import type { ProviderCapabilities, SchedulingProvider } from "../provider";

/**
 * Provider em memória com as mesmas regras do interno. Serve para testar o agente
 * sem banco e como referência da suíte de contrato.
 */

export interface InMemoryCatalog {
  rules: BookingRules;
  openingHours: WeeklyHours;
  professionals: Array<{ id: string; name: string; weeklyHours?: WeeklyHours }>;
  services: Array<{
    id: string;
    name: string;
    durationMinutes: number;
    priceCents: number;
    bufferMinutes?: number;
    description?: string | null;
    /** Sem lista, todos os profissionais fazem o serviço. */
    professionalIds?: string[];
  }>;
  blocks?: Array<TimeSpan & { professionalId: string | null }>;
  customers?: Array<{ id: string; name: string | null; phoneE164: string | null }>;
}

const MINUTE = 60_000;
const ACTIVE: readonly string[] = ACTIVE_APPOINTMENT_STATUSES;

export class InMemorySchedulingProvider implements SchedulingProvider {
  readonly kind = "internal" as const;
  readonly capabilities: ProviderCapabilities = { manageCatalog: true, sendsOwnReminders: false };

  readonly appointments: Appointment[] = [];
  private readonly catalog: InMemoryCatalog;
  private readonly customers: Map<
    string,
    { id: string; name: string | null; phoneE164: string | null }
  >;
  private readonly now: () => Date;
  private sequence = 0;

  constructor(catalog: InMemoryCatalog, now: () => Date = () => new Date()) {
    this.catalog = catalog;
    this.now = now;
    this.customers = new Map(
      (catalog.customers ?? []).map((customer) => [customer.id, { ...customer }]),
    );
  }

  addCustomer(customer: { id: string; name: string | null; phoneE164: string | null }): void {
    this.customers.set(customer.id, { ...customer });
  }

  async listServices(): Promise<Service[]> {
    return this.catalog.services.map((service) => this.toService(service));
  }

  async listProfessionals(filter: { serviceId?: string } = {}): Promise<Professional[]> {
    const all = this.catalog.professionals.map(({ id, name }) => ({ id, name }));
    if (!filter.serviceId) {
      return all;
    }
    const offered = new Set(this.service(filter.serviceId).offerings.map((o) => o.professionalId));
    return all.filter((professional) => offered.has(professional.id));
  }

  async getOpeningHours(): Promise<WeeklyHours> {
    return structuredClone(this.catalog.openingHours);
  }

  async getAvailability(query: AvailabilityQuery): Promise<Slot[]> {
    return this.availability(this.service(query.serviceId), query, query.excludeAppointmentId);
  }

  async createAppointment(input: NewAppointment): Promise<Appointment> {
    const service = this.service(input.serviceId);
    const offering = this.offeringOf(service, input.professionalId);
    const customer = this.customers.get(input.customer.id);
    if (!customer) {
      throw new NotFoundError("Cliente não encontrado.");
    }
    this.assertAvailable(service, input.professionalId, input.startsAt);
    if (input.customer.name.trim()) {
      customer.name = input.customer.name.trim();
    }
    this.sequence += 1;
    const appointment: Appointment = {
      id: `appt-${this.sequence}`,
      serviceId: service.id,
      serviceName: service.name,
      professionalId: input.professionalId,
      professionalName: this.professionalName(input.professionalId),
      customerId: customer.id,
      customerName: customer.name,
      startsAt: input.startsAt,
      endsAt: new Date(input.startsAt.getTime() + offering.durationMinutes * MINUTE),
      status: "scheduled",
      priceCents: offering.priceCents,
      source: input.source,
    };
    this.appointments.push(appointment);
    return { ...appointment };
  }

  async rescheduleAppointment(
    appointmentId: string,
    change: { startsAt: Date; professionalId?: string },
  ): Promise<Appointment> {
    const current = this.changeable(appointmentId);
    const professionalId = change.professionalId ?? current.professionalId;
    const service = this.service(current.serviceId);
    const offering = this.offeringOf(service, professionalId);
    this.assertAvailable(service, professionalId, change.startsAt, appointmentId);
    if (professionalId !== current.professionalId) {
      current.priceCents = offering.priceCents;
    }
    current.professionalId = professionalId;
    current.professionalName = this.professionalName(professionalId);
    current.startsAt = change.startsAt;
    current.endsAt = new Date(change.startsAt.getTime() + offering.durationMinutes * MINUTE);
    current.status = "scheduled";
    return { ...current };
  }

  async cancelAppointment(appointmentId: string): Promise<Appointment> {
    const current = this.changeable(appointmentId);
    current.status = "cancelled";
    return { ...current };
  }

  async getAppointment(appointmentId: string): Promise<Appointment | null> {
    const found = this.appointments.find((item) => item.id === appointmentId);
    return found ? { ...found } : null;
  }

  async findCustomerAppointments(query: CustomerAppointmentsQuery): Promise<Appointment[]> {
    const ids = new Set<string>();
    if (query.customer.id) {
      ids.add(query.customer.id);
    }
    if (query.customer.phoneE164) {
      for (const customer of this.customers.values()) {
        if (customer.phoneE164 === query.customer.phoneE164) {
          ids.add(customer.id);
        }
      }
    }
    const now = this.now().getTime();
    return this.appointments
      .filter((item) => item.customerId !== null && ids.has(item.customerId))
      .filter(
        (item) =>
          query.includePast || (item.startsAt.getTime() >= now && ACTIVE.includes(item.status)),
      )
      .sort((a, b) =>
        query.includePast
          ? b.startsAt.getTime() - a.startsAt.getTime()
          : a.startsAt.getTime() - b.startsAt.getTime(),
      )
      .map((item) => ({ ...item }));
  }

  async listAppointments(query: AppointmentsRangeQuery): Promise<Appointment[]> {
    return this.appointments
      .filter((item) => item.startsAt < query.to && item.endsAt > query.from)
      .filter((item) => !query.professionalId || item.professionalId === query.professionalId)
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
      .map((item) => ({ ...item }));
  }

  // -------------------------------------------------------------------------

  private toService(entry: InMemoryCatalog["services"][number]): Service {
    const allowed = entry.professionalIds ? new Set(entry.professionalIds) : null;
    const offerings: ServiceOffering[] = this.catalog.professionals
      .filter((professional) => !allowed || allowed.has(professional.id))
      .map((professional) => ({
        professionalId: professional.id,
        durationMinutes: entry.durationMinutes,
        priceCents: entry.priceCents,
      }));
    return {
      id: entry.id,
      name: entry.name,
      description: entry.description ?? null,
      durationMinutes: entry.durationMinutes,
      bufferMinutes: entry.bufferMinutes ?? 0,
      priceCents: entry.priceCents,
      offerings,
    };
  }

  private service(serviceId: string): Service {
    const entry = this.catalog.services.find((service) => service.id === serviceId);
    if (!entry) {
      throw new NotFoundError("Serviço não encontrado.");
    }
    return this.toService(entry);
  }

  private offeringOf(service: Service, professionalId: string): ServiceOffering {
    const offering = service.offerings.find((item) => item.professionalId === professionalId);
    if (!offering) {
      throw new InvalidInputError("Esse profissional não faz esse serviço.");
    }
    return offering;
  }

  private professionalName(professionalId: string): string {
    return this.catalog.professionals.find((p) => p.id === professionalId)?.name ?? "";
  }

  private changeable(appointmentId: string): Appointment {
    const current = this.appointments.find((item) => item.id === appointmentId);
    if (!current) {
      throw new NotFoundError("Agendamento não encontrado.");
    }
    if (!ACTIVE.includes(current.status)) {
      throw new NotAllowedError("Esse agendamento já foi cancelado ou concluído.");
    }
    if (current.startsAt.getTime() <= this.now().getTime()) {
      throw new NotAllowedError("Esse agendamento já passou.");
    }
    return current;
  }

  private assertAvailable(
    service: Service,
    professionalId: string,
    startsAt: Date,
    excludeId?: string,
  ): void {
    const slots = this.availability(
      service,
      {
        serviceId: service.id,
        professionalId,
        from: startsAt,
        to: new Date(startsAt.getTime() + MINUTE),
      },
      excludeId,
    );
    if (!slots.some((slot) => slot.startsAt.getTime() === startsAt.getTime())) {
      throw new SlotUnavailableError();
    }
  }

  private availability(service: Service, query: AvailabilityQuery, excludeId?: string): Slot[] {
    const offerings = query.professionalId
      ? service.offerings.filter((offering) => offering.professionalId === query.professionalId)
      : service.offerings;
    if (query.professionalId && offerings.length === 0) {
      throw new InvalidInputError("Esse profissional não faz esse serviço.");
    }
    return computeAvailableSlots({
      now: this.now(),
      rules: this.catalog.rules,
      range: { from: query.from, to: query.to },
      professionals: offerings.map((offering) => {
        const professional = this.catalog.professionals.find(
          (p) => p.id === offering.professionalId,
        );
        return {
          id: offering.professionalId,
          durationMinutes: offering.durationMinutes,
          bufferMinutes: service.bufferMinutes,
          weeklyHours: professional?.weeklyHours ?? this.catalog.openingHours ?? emptyWeeklyHours(),
        };
      }),
      blocks: this.catalog.blocks ?? [],
      busy: this.appointments
        .filter((item) => ACTIVE.includes(item.status) && item.id !== excludeId)
        .map((item) => ({
          professionalId: item.professionalId,
          startsAt: item.startsAt,
          endsAt: item.endsAt,
        })),
    });
  }
}
