export type DomainErrorCode =
  | "NOT_FOUND"
  | "SLOT_UNAVAILABLE"
  | "INVALID_INPUT"
  | "NOT_ALLOWED"
  | "NOT_IMPLEMENTED"
  | "PROVIDER_UNAVAILABLE";

/**
 * Erro de regra de negócio. A mensagem é escrita em português porque pode
 * chegar ao agente e, por ele, ao cliente.
 */
export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = new.target.name;
  }
}

export class NotFoundError extends DomainError {
  constructor(message: string) {
    super("NOT_FOUND", message);
  }
}

export class SlotUnavailableError extends DomainError {
  constructor(message = "Esse horário não está mais disponível.") {
    super("SLOT_UNAVAILABLE", message);
  }
}

export class InvalidInputError extends DomainError {
  constructor(message: string) {
    super("INVALID_INPUT", message);
  }
}

export class NotAllowedError extends DomainError {
  constructor(message: string) {
    super("NOT_ALLOWED", message);
  }
}

export class NotImplementedError extends DomainError {
  constructor(message: string) {
    super("NOT_IMPLEMENTED", message);
  }
}

export class ProviderUnavailableError extends DomainError {
  constructor(message: string, options?: ErrorOptions) {
    super("PROVIDER_UNAVAILABLE", message, options);
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
