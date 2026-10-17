/**
 * Secret redaction.
 *
 * `hap-sign-tool` only accepts passwords on the command line, so they will
 * inevitably reach argv. We cannot change that, but we must never let them
 * reach logs, reports, manifests or CI output.
 */
const MASK = "********";

const SECRET_FLAGS = [
  "-keyPwd",
  "-keystorePwd",
  "-issuerKeyPwd",
  "-profileSigned",
];

/** Replace every occurrence of a secret with a fixed mask. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 1) continue;
    out = out.split(secret).join(MASK);
  }
  return out;
}

/**
 * Redact an argv array: masks the value that follows a known password flag and
 * any standalone occurrence of a resolved secret.
 */
export function redactArgv(argv: readonly string[], secrets: readonly string[] = []): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    const isSecretFlag = SECRET_FLAGS.includes(token);
    out.push(token);
    if (isSecretFlag && i + 1 < argv.length) {
      out.push(MASK);
      i += 1;
    }
  }
  return out.map((token) => redact(token, secrets));
}

/** Human readable form of an argv array, safe to print. */
export function formatArgv(argv: readonly string[], secrets: readonly string[] = []): string {
  return redactArgv(argv, secrets)
    .map((token) => (/[\s"]/.test(token) ? `"${token}"` : token))
    .join(" ");
}
