import { decryptJson } from "@proximo/core";
import { type Db, scopeToBusiness } from "@proximo/db";
import { type AppBarberConfig, AppBarberSchedulingProvider } from "./appbarber/appbarber-provider";
import {
  type InternalBusinessSettings,
  InternalSchedulingProvider,
} from "./internal/internal-provider";
import type { SchedulingProvider, SchedulingProviderKind } from "./provider";

export interface BusinessForProvider extends InternalBusinessSettings {
  schedulingProvider: SchedulingProviderKind;
  providerConfig: string | null;
}

export interface ProviderFactoryDeps {
  db: Db;
  /** Necessária só para providers externos, que guardam credenciais cifradas. */
  encryptionKey?: Buffer;
  now?: () => Date;
}

/** Escolhe o provider de agenda configurado para o negócio. */
export function createSchedulingProvider(
  business: BusinessForProvider,
  deps: ProviderFactoryDeps,
): SchedulingProvider {
  switch (business.schedulingProvider) {
    case "internal":
      return new InternalSchedulingProvider({
        db: scopeToBusiness(deps.db, business.id),
        business,
        now: deps.now,
      });
    case "appbarber": {
      let config: AppBarberConfig = {};
      if (business.providerConfig) {
        if (!deps.encryptionKey) {
          throw new Error("ENCRYPTION_KEY é necessária para ler a configuração do AppBarber.");
        }
        config = decryptJson<AppBarberConfig>(business.providerConfig, deps.encryptionKey);
      }
      return new AppBarberSchedulingProvider(config);
    }
  }
}
