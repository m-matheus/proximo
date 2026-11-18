import {
  type Appointment,
  type AppointmentsRangeQuery,
  type AvailabilityQuery,
  type CustomerAppointmentsQuery,
  type NewAppointment,
  NotImplementedError,
  type Professional,
  type Service,
  type Slot,
  type WeeklyHours,
} from "@proximo/core";
import type { ProviderCapabilities, SchedulingProvider } from "../provider";

/**
 * Cenário A: agenda no AppBarber. AINDA NÃO IMPLEMENTADO.
 *
 * Em 30/09/2026 o AppBarber não tinha API pública documentada, e os termos de uso
 * proíbem engenharia reversa e captura de dados do sistema (cláusulas 9 e 17).
 * Só dá para implementar com uma API oficial ou parceria com a StarApp.
 *
 * Quando houver API, implemente cada método abaixo e rode a suíte de contrato
 * de @proximo/scheduling/testing contra este provider.
 */

export interface AppBarberConfig {
  /** TODO: confirmar com a StarApp como a autenticação funciona. */
  apiBaseUrl?: string;
  apiKey?: string;
  /** TODO: ID do estabelecimento no AppBarber. */
  establishmentId?: string;
}

const NOT_AVAILABLE =
  "A integração com o AppBarber ainda não existe. Use a agenda do Próximo neste negócio.";

export class AppBarberSchedulingProvider implements SchedulingProvider {
  readonly kind = "appbarber" as const;
  readonly capabilities: ProviderCapabilities = {
    // O catálogo e os horários seriam editados no próprio AppBarber.
    manageCatalog: false,
    // O AppBarber já envia lembrete por push e e-mail.
    sendsOwnReminders: true,
  };

  readonly config: AppBarberConfig;

  constructor(config: AppBarberConfig = {}) {
    this.config = config;
  }

  async listServices(): Promise<Service[]> {
    // TODO: buscar serviços do estabelecimento e mapear duração, preço e profissionais.
    throw new NotImplementedError(NOT_AVAILABLE);
  }

  async listProfessionals(_filter?: { serviceId?: string }): Promise<Professional[]> {
    // TODO: buscar profissionais ativos; filtrar pelos que fazem o serviço.
    throw new NotImplementedError(NOT_AVAILABLE);
  }

  async getOpeningHours(): Promise<WeeklyHours> {
    // TODO: horário de funcionamento do estabelecimento, convertido para WeeklyHours.
    throw new NotImplementedError(NOT_AVAILABLE);
  }

  async getAvailability(_query: AvailabilityQuery): Promise<Slot[]> {
    // TODO: usar a disponibilidade calculada pelo AppBarber. Não recalcular aqui:
    // a fonte da verdade da agenda passa a ser o sistema deles.
    throw new NotImplementedError(NOT_AVAILABLE);
  }

  async createAppointment(_input: NewAppointment): Promise<Appointment> {
    // TODO: criar ou achar o cliente pelo telefone, criar o agendamento e mapear
    // "horário ocupado" para SlotUnavailableError.
    throw new NotImplementedError(NOT_AVAILABLE);
  }

  async rescheduleAppointment(
    _appointmentId: string,
    _change: { startsAt: Date; professionalId?: string },
  ): Promise<Appointment> {
    // TODO: remarcar; se a API não permitir, cancelar e criar de novo numa operação segura.
    throw new NotImplementedError(NOT_AVAILABLE);
  }

  async cancelAppointment(_appointmentId: string, _reason?: string): Promise<Appointment> {
    // TODO: cancelar e devolver o agendamento atualizado.
    throw new NotImplementedError(NOT_AVAILABLE);
  }

  async confirmAppointment(_appointmentId: string): Promise<Appointment> {
    // TODO: marcar a presença como confirmada, se o AppBarber tiver esse status.
    throw new NotImplementedError(NOT_AVAILABLE);
  }

  async getAppointment(_appointmentId: string): Promise<Appointment | null> {
    // TODO: buscar um agendamento pelo ID do AppBarber.
    throw new NotImplementedError(NOT_AVAILABLE);
  }

  async findCustomerAppointments(_query: CustomerAppointmentsQuery): Promise<Appointment[]> {
    // TODO: buscar o cliente pelo telefone; o ID interno do Próximo não existe lá.
    throw new NotImplementedError(NOT_AVAILABLE);
  }

  async listAppointments(_query: AppointmentsRangeQuery): Promise<Appointment[]> {
    // TODO: listar a agenda do período, para o painel mostrar em modo leitura.
    throw new NotImplementedError(NOT_AVAILABLE);
  }
}
