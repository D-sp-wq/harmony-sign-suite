/**
 * Secret redaction.
 *
 * `hap-sign-tool` only accepts passwords on the command line, so they will
 * inevitably reach argv. We cannot change that, but we must never let them
 * reach logs, reports, manifests or CI output.
 */
const MASK = "********";

/**
 * Secrets shorter than this are only masked where they appear as a flag value,
 * never as a substring: otherwise a password like "demo" would mangle every
 * path (`C:\dev\hss\examples\demo\…` → `examples\********\…`).
 */
const SUBSTRING_REDACT_MIN_LENGTH = 6;

const SECRET_FLAGS = ["-keyPwd", "-keystorePwd", "-issuerKeyPwd", "-profileKeyPwd"];

/** Replace every occurrence of a reasonably long secret with a fixed mask. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < SUBSTRING_REDACT_MIN_LENGTH) continue;
    out = out.split(secret).join(MASK);
  }
  return out;
}

/**
 * Redact an argv array:
 *  - the value following a password flag is always masked;
 *  - other tokens are masked only when they equal a secret exactly.
 */
export function redactArgv(argv: readonly string[], secrets: readonly string[] = []): string[] {
  const exact = new Set(secrets);
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    if (SECRET_FLAGS.includes(token) && i + 1 < argv.length) {
      out.push(token, MASK);
      i += 1;
      continue;
    }
    if (exact.has(token)) {
      out.push(MASK);
      continue;
    }
    out.push(redact(token, secrets));
  }
  return out;
}

/** Human readable form of an argv array, safe to print. */
export function formatArgv(argv: readonly string[], secrets: readonly string[] = []): string {
  return redactArgv(argv, secrets)
    .map((token) => (/[\s"]/.test(token) ? `"${token}"` : token))
    .join(" ");
}
