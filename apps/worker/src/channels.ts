import { decryptJson } from "@proximo/core";
import { type MessagingChannel, SimulatorChannel, WhatsAppCloudChannel } from "@proximo/messaging";

export interface ChannelRow {
  id: string;
  type: "whatsapp_cloud" | "simulator";
  externalId: string;
  credentials: string | null;
  updatedAt: Date;
}

/** Cria e guarda em memória o cliente de cada canal, decifrando o token só quando precisa. */
export class ChannelRegistry {
  private readonly cache = new Map<string, { version: number; channel: MessagingChannel }>();
  private readonly options: {
    graphApiVersion: string;
    encryptionKey?: Buffer;
    simulator?: SimulatorChannel;
    fetch?: typeof fetch;
  };

  constructor(options: ChannelRegistry["options"]) {
    this.options = options;
  }

  get(row: ChannelRow): MessagingChannel {
    const version = row.updatedAt.getTime();
    const cached = this.cache.get(row.id);
    if (cached && cached.version === version) {
      return cached.channel;
    }
    const channel = this.create(row);
    this.cache.set(row.id, { version, channel });
    return channel;
  }

  private create(row: ChannelRow): MessagingChannel {
    if (row.type === "simulator") {
      return this.options.simulator ?? new SimulatorChannel();
    }
    if (!row.credentials) {
      throw new Error(`Canal ${row.id} sem credenciais do WhatsApp.`);
    }
    if (!this.options.encryptionKey) {
      throw new Error("ENCRYPTION_KEY é necessária para usar canais do WhatsApp.");
    }
    const { accessToken } = decryptJson<{ accessToken: string }>(
      row.credentials,
      this.options.encryptionKey,
    );
    return new WhatsAppCloudChannel({
      phoneNumberId: row.externalId,
      accessToken,
      graphApiVersion: this.options.graphApiVersion,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    });
  }
}
