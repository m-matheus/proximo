import type { Professional, Service } from "@proximo/core";

/**
 * Apelidos curtos para serviços (s1, s2...) e profissionais (p1, p2...).
 * O modelo erra menos com códigos curtos do que copiando UUIDs, e as ferramentas
 * aceitam só os códigos do catálogo. O catálogo fica congelado na sessão: se
 * mudar, o prompt muda e o worker abre uma sessão nova.
 */
export interface Catalog {
  services: Array<{ alias: string; service: Service }>;
  professionals: Array<{ alias: string; professional: Professional }>;
}

export function buildCatalog(services: Service[], professionals: Professional[]): Catalog {
  return {
    services: services.map((service, index) => ({ alias: `s${index + 1}`, service })),
    professionals: professionals.map((professional, index) => ({
      alias: `p${index + 1}`,
      professional,
    })),
  };
}

export function serviceByAlias(catalog: Catalog, alias: string): Service | undefined {
  return catalog.services.find((entry) => entry.alias === alias)?.service;
}

export function professionalByAlias(catalog: Catalog, alias: string): Professional | undefined {
  return catalog.professionals.find((entry) => entry.alias === alias)?.professional;
}

export function professionalAlias(catalog: Catalog, professionalId: string): string {
  return (
    catalog.professionals.find((entry) => entry.professional.id === professionalId)?.alias ?? "?"
  );
}

export function professionalName(catalog: Catalog, professionalId: string): string {
  return (
    catalog.professionals.find((entry) => entry.professional.id === professionalId)?.professional
      .name ?? "profissional"
  );
}
