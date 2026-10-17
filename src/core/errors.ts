/** Error type that carries an actionable hint for the CLI to print. */
export class HssError extends Error {
  readonly hint?: string;
  readonly code?: string;

  constructor(message: string, options: { hint?: string; code?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "HssError";
    this.hint = options.hint;
    this.code = options.code;
  }
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
