import { createHash, X509Certificate } from "node:crypto";
import type { SignAlg } from "../config/schema.js";

const PEM_CERT = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g;

export interface ParsedCertificate {
  /** Normalized PEM text. */
  pem: string;
  certificate: X509Certificate;
  subject: string;
  issuer: string;
  validFrom: Date;
  validTo: Date;
  serialNumber: string;
  /** `ec`, `rsa`, `ed25519`, … as reported by node:crypto. */
  keyType: string;
  /** SHA-256 over the DER-encoded SubjectPublicKeyInfo. */
  spkiSha256: string;
  isCa: boolean;
}

/** Extract every certificate from a PEM bundle, normalizing line endings. */
export function extractPemCertificates(text: string): string[] {
  const out: string[] = [];
  const matches = text.matchAll(PEM_CERT);
  for (const match of matches) {
    const body = (match[1] ?? "").replace(/\s+/g, "");
    if (body.length === 0) continue;
    const wrapped = body.match(/.{1,64}/g)?.join("\n") ?? body;
    out.push(`-----BEGIN CERTIFICATE-----\n${wrapped}\n-----END CERTIFICATE-----\n`);
  }
  return out;
}

/** Wrap a base64 (standard or URL-safe) DER certificate into PEM. */
export function pemFromBase64Certificate(base64: string): string {
  const body = base64
    .replace(/\s+/g, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const wrapped = body.match(/.{1,64}/g)?.join("\n") ?? body;
  return `-----BEGIN CERTIFICATE-----\n${wrapped}\n-----END CERTIFICATE-----\n`;
}

export function describeCertificate(pem: string): ParsedCertificate {
  const certificate = new X509Certificate(pem);
  const spki = certificate.publicKey.export({ type: "spki", format: "der" });
  return {
    pem,
    certificate,
    subject: certificate.subject,
    issuer: certificate.issuer,
    validFrom: new Date(certificate.validFrom),
    validTo: new Date(certificate.validTo),
    serialNumber: certificate.serialNumber,
    keyType: certificate.publicKey.asymmetricKeyType ?? "unknown",
    spkiSha256: createHash("sha256").update(spki).digest("hex"),
    isCa: certificate.ca === true,
  };
}

export function parsePemChain(text: string): ParsedCertificate[] {
  return extractPemCertificates(text).map(describeCertificate);
}

export interface ChainProblem {
  index: number;
  message: string;
}

export interface ChainValidation {
  /** True when every certificate is issued and signed by the next one. */
  ok: boolean;
  problems: ChainProblem[];
}

/**
 * Validate that a PEM chain is ordered leaf → intermediate → … → root.
 *
 * A common cause of `code 107 Wrong key usage` / `code 108 unable to find a
 * valid certification path` is a chain in the wrong order or a bundle that is
 * not a chain at all.
 */
export function validateChainOrder(chain: readonly ParsedCertificate[]): ChainValidation {
  const problems: ChainProblem[] = [];

  if (chain.length === 0) {
    return { ok: false, problems: [{ index: -1, message: "no certificate found" }] };
  }

  if (chain.length === 1) {
    const only = chain[0];
    if (only && !only.isCa) {
      problems.push({
        index: 0,
        message:
          "only one certificate present; hap-sign-tool requires a full chain (leaf + intermediate + root)",
      });
    }
  }

  for (let i = 0; i < chain.length - 1; i += 1) {
    const child = chain[i];
    const parent = chain[i + 1];
    if (!child || !parent) continue;

    const issued = child.certificate.checkIssued(parent.certificate);
    const verified = child.certificate.verify(parent.certificate.publicKey);

    if (!verified) {
      problems.push({
        index: i,
        message: `certificate #${i} is not signed by #${i + 1} (${shortDn(parent.subject)})`,
      });
    } else if (!issued) {
      problems.push({
        index: i,
        message: `certificate #${i} issuer (${shortDn(child.issuer)}) does not match #${i + 1} subject (${shortDn(parent.subject)})`,
      });
    }
  }

  if (chain.length > 1) {
    const last = chain[chain.length - 1];
    const first = chain[0];
    if (last && first && last.subject === first.subject && chain.length === 2) {
      problems.push({
        index: chain.length - 1,
        message: "chain looks truncated: the first certificate is also the issuer",
      });
    }
  }

  return { ok: problems.length === 0, problems };
}

export function shortDn(dn: string): string {
  const cn = /CN=([^,]+)/.exec(dn);
  if (cn?.[1]) return cn[1].trim();
  return dn.length > 48 ? `${dn.slice(0, 45)}…` : dn;
}

export function daysUntil(date: Date, now: Date = new Date()): number {
  return Math.floor((date.getTime() - now.getTime()) / 86_400_000);
}

/** Does the certificate key type match the requested signature algorithm? */
export function keyTypeMatchesSignAlg(keyType: string, signAlg: SignAlg): boolean {
  if (signAlg.includes("ECDSA")) return keyType === "ec";
  if (signAlg.includes("RSA")) return keyType === "rsa";
  return false;
}

/** Human readable certificate summary used in reports. */
export function summarizeCertificate(cert: ParsedCertificate): string {
  return `${shortDn(cert.subject)} · ${cert.keyType.toUpperCase()} · 有效至 ${formatDate(cert.validTo)}`;
}

export function formatDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const d = `${date.getUTCDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
}
