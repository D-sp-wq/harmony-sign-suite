/**
 * Minimal terminal logger. Supports a machine-readable JSON mode so CI can
 * consume output without parsing human text.
 */
export interface LoggerOptions {
  json?: boolean;
  quiet?: boolean;
  noColor?: boolean;
}

const ESC = "\u001b[";
const COLORS = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  red: `${ESC}31m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  blue: `${ESC}34m`,
  cyan: `${ESC}36m`,
  gray: `${ESC}90m`,
};

export class Logger {
  private readonly json: boolean;
  private readonly quiet: boolean;
  private readonly color: boolean;

  constructor(opts: LoggerOptions = {}) {
    this.json = opts.json === true;
    this.quiet = opts.quiet === true;
    this.color = !opts.noColor && !this.json && process.env.NO_COLOR === undefined;
  }

  get isJson(): boolean {
    return this.json;
  }

  private paint(code: string, text: string): string {
    return this.color ? `${code}${text}${COLORS.reset}` : text;
  }

  /** Structured event (only emitted in JSON mode). */
  event(type: string, payload: Record<string, unknown> = {}): void {
    if (!this.json) return;
    process.stdout.write(`${JSON.stringify({ type, ...payload })}\n`);
  }

  info(msg: string): void {
    if (this.quiet || this.json) return;
    process.stdout.write(`${msg}\n`);
  }

  success(msg: string): void {
    if (this.quiet || this.json) return;
    process.stdout.write(`${this.paint(COLORS.green, "✓")} ${msg}\n`);
  }

  warn(msg: string): void {
    if (this.json) return;
    process.stderr.write(`${this.paint(COLORS.yellow, "!")} ${msg}\n`);
  }

  error(msg: string): void {
    if (this.json) return;
    process.stderr.write(`${this.paint(COLORS.red, "✗")} ${msg}\n`);
  }

  step(msg: string): void {
    if (this.quiet || this.json) return;
    process.stdout.write(`${this.paint(COLORS.cyan, "→")} ${msg}\n`);
  }

  dim(msg: string): void {
    if (this.quiet || this.json) return;
    process.stdout.write(`${this.paint(COLORS.gray, msg)}\n`);
  }

  heading(msg: string): void {
    if (this.quiet || this.json) return;
    process.stdout.write(`\n${this.paint(COLORS.bold, msg)}\n`);
  }

  raw(msg: string): void {
    if (this.json) return;
    process.stdout.write(`${msg}\n`);
  }
}
