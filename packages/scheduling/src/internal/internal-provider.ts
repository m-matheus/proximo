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
  whatsappIdVariants,
} from "@proximo/core";
import { isAppointmentOverlapError, type Prisma, type TenantDb } from "@proximo/db";
import {
  type AvailabilityProfessional,
  computeAvailableSlots,
  hasAnyHours,
  toWeeklyHours,
} from "../availability";
import type { ProviderCapabilities, SchedulingProvider } from "../provider";

/** Configuração do negócio que o provider interno precisa. */
export interface InternalBusinessSettings {
  id: string;
  timezone: string;
  minLeadMinutes: number;
  maxAdvanceDays: number;
  slotIntervalMinutes: number;
}

export interface InternalProviderOptions {
  /** Cliente do Prisma já restrito ao negócio, criado com scopeToBusiness. */
  db: TenantDb;
  business: InternalBusinessSettings;
  /** Relógio injetável para testes. */
  now?: () => Date;
}

const MINUTE = 60_000;
const ACTIVE: readonly string[] = ACTIVE_APPOINTMENT_STATUSES;

const APPOINTMENT_INCLUDE = {
  service: { select: { name: true } },
  professional: { select: { name: true } },
  customer: { select: { name: true } },
} satisfies Prisma.AppointmentInclude;

type AppointmentRow = Prisma.AppointmentGetPayload<{ include: typeof APPOINTMENT_INCLUDE }>;

type ServiceWithOfferings = Service;

function toAppointment(row: AppointmentRow): Appointment {
  return {
    id: row.id,
    serviceId: row.serviceId,
    serviceName: row.service.name,
    professionalId: row.professionalId,
    professionalName: row.professional.name,
    customerId: row.customerId,
    customerName: row.customer.name,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    status: row.status,
    priceCents: row.priceCents,
    source: row.source,
  };
}

/**
 * Agenda própria do Próximo, guardada no nosso Postgres (cenário B).
 * A exclusion constraint do banco é a última defesa contra horário duplicado.
 */
export class InternalSchedulingProvider implements SchedulingProvider {
  readonly kind = "internal" as const;
  readonly capabilities: ProviderCapabilities = {
    manageCatalog: true,
    sendsOwnReminders: false,
  };

  private readonly db: TenantDb;
  private readonly business: InternalBusinessSettings;
  private readonly now: () => Date;

  constructor(options: InternalProviderOptions) {
    this.db = options.db;
    this.business = options.business;
    this.now = options.now ?? (() => new Date());
  }

  private get rules(): BookingRules {
    return {
      timezone: this.business.timezone,
      minLeadMinutes: this.business.minLeadMinutes,
      maxAdvanceDays: this.business.maxAdvanceDays,
      slotIntervalMinutes: this.business.slotIntervalMinutes,
    };
  }

  async listServices(): Promise<Service[]> {
    const [services, professionals] = await Promise.all([
      this.db.service.findMany({
        where: { active: true },
        include: { professionals: true },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      }),
      this.activeProfessionals(),
    ]);
    return services.map((service) => this.withOfferings(service, professionals));
  }

  async listProfessionals(filter: { serviceId?: string } = {}): Promise<Professional[]> {
    const professionals = await this.activeProfessionals();
    if (!filter.serviceId) {
      return professionals.map(({ id, name }) => ({ id, name }));
    }
    const service = await this.loadService(filter.serviceId);
    const offered = new Set(service.offerings.map((offering) => offering.professionalId));
    return professionals.filter((p) => offered.has(p.id)).map(({ id, name }) => ({ id, name }));
  }

  async getOpeningHours(): Promise<WeeklyHours> {
    const rows = await this.db.workingHours.findMany({ where: { professionalId: null } });
    return toWeeklyHours(rows);
  }

  async getAvailability(query: AvailabilityQuery): Promise<Slot[]> {
    const service = await this.loadService(query.serviceId);
    return this.availabilityFor(service, query, query.excludeAppointmentId);
  }

  async createAppointment(input: NewAppointment): Promise<Appointment> {
    const service = await this.loadService(input.serviceId);
    const offering = this.offeringOf(service, input.professionalId);
    const customer = await this.db.customer.findUnique({ where: { id: input.customer.id } });
    if (!customer || customer.anonymizedAt) {
      throw new NotFoundError("Cliente não encontrado.");
    }
    await this.assertSlotAvailable(service, input.professionalId, input.startsAt);

    const name = input.customer.name.trim();
    if (name && name !== customer.name) {
      await this.db.customer.update({ where: { id: customer.id }, data: { name } });
    }

    try {
      const row = await this.db.appointment.create({
        data: {
          businessId: this.business.id,
          customerId: customer.id,
          professionalId: input.professionalId,
          serviceId: service.id,
          startsAt: input.startsAt,
          endsAt: new Date(input.startsAt.getTime() + offering.durationMinutes * MINUTE),
          source: input.source,
          priceCents: offering.priceCents,
          notes: input.notes?.trim() || null,
        },
        include: APPOINTMENT_INCLUDE,
      });
      return toAppointment(row);
    } catch (error) {
      if (isAppointmentOverlapError(error)) {
        throw new SlotUnavailableError();
      }
      throw error;
    }
  }

  async rescheduleAppointment(
    appointmentId: string,
    change: { startsAt: Date; professionalId?: string },
  ): Promise<Appointment> {
    const current = await this.loadChangeableAppointment(appointmentId);
    const professionalId = change.professionalId ?? current.professionalId;
    const service = await this.loadService(current.serviceId);
    const offering = this.offeringOf(service, professionalId);
    await this.assertSlotAvailable(service, professionalId, change.startsAt, appointmentId);

    try {
      const row = await this.db.appointment.update({
        where: { id: appointmentId },
        data: {
          professionalId,
          startsAt: change.startsAt,
          endsAt: new Date(change.startsAt.getTime() + offering.durationMinutes * MINUTE),
          priceCents:
            professionalId === current.professionalId ? current.priceCents : offering.priceCents,
          status: "scheduled",
        },
        include: APPOINTMENT_INCLUDE,
      });
      return toAppointment(row);
    } catch (error) {
      if (isAppointmentOverlapError(error)) {
        throw new SlotUnavailableError();
      }
      throw error;
    }
  }

  async cancelAppointment(appointmentId: string, reason?: string): Promise<Appointment> {
    await this.loadChangeableAppointment(appointmentId);
    const row = await this.db.appointment.update({
      where: { id: appointmentId },
      data: {
        status: "cancelled",
        cancelledAt: this.now(),
        cancelReason: reason?.trim() || null,
      },
      include: APPOINTMENT_INCLUDE,
    });
    return toAppointment(row);
  }

  async getAppointment(appointmentId: string): Promise<Appointment | null> {
    const row = await this.db.appointment.findUnique({
      where: { id: appointmentId },
      include: APPOINTMENT_INCLUDE,
    });
    return row ? toAppointment(row) : null;
  }

  async findCustomerAppointments(query: CustomerAppointmentsQuery): Promise<Appointment[]> {
    const customerIds = new Set<string>();
    if (query.customer.id) {
      customerIds.add(query.customer.id);
    }
    if (query.customer.phoneE164) {
      const matches = await this.db.customer.findMany({
        where: {
          OR: [
            { phoneE164: query.customer.phoneE164 },
            { waId: { in: whatsappIdVariants(query.customer.phoneE164) } },
          ],
        },
        select: { id: true },
      });
      for (const match of matches) {
        customerIds.add(match.id);
      }
    }
    if (customerIds.size === 0) {
      return [];
    }
    const rows = await this.db.appointment.findMany({
      where: {
        customerId: { in: [...customerIds] },
        ...(query.includePast
          ? {}
          : { startsAt: { gte: this.now() }, status: { in: [...ACTIVE_APPOINTMENT_STATUSES] } }),
      },
      include: APPOINTMENT_INCLUDE,
      orderBy: { startsAt: query.includePast ? "desc" : "asc" },
      take: 20,
    });
    return rows.map(toAppointment);
  }

  async listAppointments(query: AppointmentsRangeQuery): Promise<Appointment[]> {
    const rows = await this.db.appointment.findMany({
      where: {
        startsAt: { lt: query.to },
        endsAt: { gt: query.from },
        ...(query.professionalId ? { professionalId: query.professionalId } : {}),
      },
      include: APPOINTMENT_INCLUDE,
      orderBy: { startsAt: "asc" },
    });
    return rows.map(toAppointment);
  }

  // -------------------------------------------------------------------------

  private activeProfessionals() {
    return this.db.professional.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    });
  }

  /**
   * Serviço sem vínculo em professional_services vale para todos os profissionais ativos.
   * Com vínculos, só para os vinculados, com duração e preço próprios quando houver.
   */
  private withOfferings(
    service: Prisma.ServiceGetPayload<{ include: { professionals: true } }>,
    professionals: ReadonlyArray<{ id: string }>,
  ): ServiceWithOfferings {
    const links = new Map(service.professionals.map((link) => [link.professionalId, link]));
    const offerings = professionals
      .filter((professional) => links.size === 0 || links.has(professional.id))
      .map((professional) => {
        const link = links.get(professional.id);
        return {
          professionalId: professional.id,
          durationMinutes: link?.durationMinutes ?? service.durationMinutes,
          priceCents: link?.priceCents ?? service.priceCents,
        };
      });
    return {
      id: service.id,
      name: service.name,
      description: service.description,
      durationMinutes: service.durationMinutes,
      bufferMinutes: service.bufferMinutes,
      priceCents: service.priceCents,
      offerings,
    };
  }

  private async loadService(serviceId: string): Promise<ServiceWithOfferings> {
    const [service, professionals] = await Promise.all([
      this.db.service.findFirst({
        where: { id: serviceId, active: true },
        include: { professionals: true },
      }),
      this.activeProfessionals(),
    ]);
    if (!service) {
      throw new NotFoundError("Serviço não encontrado.");
    }
    return this.withOfferings(service, professionals);
  }

  private offeringOf(service: ServiceWithOfferings, professionalId: string): ServiceOffering {
    const offering = service.offerings.find((item) => item.professionalId === professionalId);
    if (!offering) {
      throw new InvalidInputError("Esse profissional não faz esse serviço.");
    }
    return offering;
  }

  private async loadChangeableAppointment(appointmentId: string): Promise<AppointmentRow> {
    const current = await this.db.appointment.findUnique({
      where: { id: appointmentId },
      include: APPOINTMENT_INCLUDE,
    });
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

  private async assertSlotAvailable(
    service: ServiceWithOfferings,
    professionalId: string,
    startsAt: Date,
    excludeAppointmentId?: string,
  ): Promise<void> {
    const slots = await this.availabilityFor(
      service,
      {
        serviceId: service.id,
        professionalId,
        from: startsAt,
        to: new Date(startsAt.getTime() + MINUTE),
      },
      excludeAppointmentId,
    );
    const available = slots.some(
      (slot) =>
        slot.professionalId === professionalId && slot.startsAt.getTime() === startsAt.getTime(),
    );
    if (!available) {
      throw new SlotUnavailableError();
    }
  }

  private async availabilityFor(
    service: ServiceWithOfferings,
    query: AvailabilityQuery,
    excludeAppointmentId?: string,
  ): Promise<Slot[]> {
    const offerings = query.professionalId
      ? service.offerings.filter((offering) => offering.professionalId === query.professionalId)
      : service.offerings;
    if (query.professionalId && offerings.length === 0) {
      throw new InvalidInputError("Esse profissional não faz esse serviço.");
    }
    if (offerings.length === 0 || query.to.getTime() <= query.from.getTime()) {
      return [];
    }

    const professionalIds = offerings.map((offering) => offering.professionalId);
    const longest =
      Math.max(...offerings.map((offering) => offering.durationMinutes)) + service.bufferMinutes;
    const until = new Date(query.to.getTime() + longest * MINUTE);

    const [hours, blocks, busy] = await Promise.all([
      this.db.workingHours.findMany({
        where: { OR: [{ professionalId: null }, { professionalId: { in: professionalIds } }] },
      }),
      this.db.scheduleBlock.findMany({
        where: {
          startsAt: { lt: until },
          endsAt: { gt: query.from },
          OR: [{ professionalId: null }, { professionalId: { in: professionalIds } }],
        },
      }),
      this.db.appointment.findMany({
        where: {
          professionalId: { in: professionalIds },
          status: { in: [...ACTIVE_APPOINTMENT_STATUSES] },
          startsAt: { lt: until },
          endsAt: { gt: query.from },
          ...(excludeAppointmentId ? { id: { not: excludeAppointmentId } } : {}),
        },
        select: { professionalId: true, startsAt: true, endsAt: true },
      }),
    ]);

    const businessHours = toWeeklyHours(hours.filter((row) => row.professionalId === null));
    const professionals: AvailabilityProfessional[] = offerings.map((offering) => {
      const own = toWeeklyHours(
        hours.filter((row) => row.professionalId === offering.professionalId),
      );
      return {
        id: offering.professionalId,
        durationMinutes: offering.durationMinutes,
        bufferMinutes: service.bufferMinutes,
        weeklyHours: hasAnyHours(own) ? own : businessHours,
      };
    });

    return computeAvailableSlots({
      now: this.now(),
      rules: this.rules,
      range: { from: query.from, to: query.to },
      professionals,
      blocks,
      busy,
    });
  }
}
