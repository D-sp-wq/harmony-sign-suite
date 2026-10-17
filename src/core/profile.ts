import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Normalized view of a HarmonyAppProvision (profile) document. */
export interface ProfileInfo {
  type?: string;
  bundleName?: string;
  uuid?: string;
  notBefore?: Date;
  notAfter?: Date;
  developerId?: string;
  /** Base64 of the distribution (release) certificate. */
  distributionCertificate?: string;
  /** Base64 of the development (debug) certificate. */
  developmentCertificate?: string;
  apl?: string;
  appFeature?: string;
  allowedAcls: string[];
  restrictedPermissions: string[];
  /** Original parsed JSON, useful for evidence/debugging. */
  raw: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function timestampToDate(value: unknown): Date | undefined {
  const seconds = asNumber(value);
  if (seconds === undefined) return undefined;
  return new Date(seconds * 1000);
}

/** Read the fields of a profile JSON document (both the raw template and the signed payload). */
export function parseProfileObject(json: unknown): ProfileInfo {
  const root = asRecord(json);
  if (!root) return { allowedAcls: [], restrictedPermissions: [], raw: json };

  const bundleInfo = asRecord(root["bundle-info"]);
  const validity = asRecord(root.validity);
  const acls = asRecord(root.acls);
  const permissions = asRecord(root.permissions);

  const info: ProfileInfo = {
    allowedAcls: asStringArray(acls?.["allowed-acls"]),
    restrictedPermissions: asStringArray(permissions?.["restricted-permissions"]),
    raw: json,
  };

  const type = asString(root.type);
  if (type) info.type = type;

  const uuid = asString(root.uuid);
  if (uuid) info.uuid = uuid;

  const bundleName = asString(bundleInfo?.["bundle-name"]);
  if (bundleName) info.bundleName = bundleName;

  const developerId = asString(bundleInfo?.["developer-id"]);
  if (developerId) info.developerId = developerId;

  const distributionCertificate = asString(bundleInfo?.["distribution-certificate"]);
  if (distributionCertificate) info.distributionCertificate = distributionCertificate;

  const developmentCertificate = asString(bundleInfo?.["development-certificate"]);
  if (developmentCertificate) info.developmentCertificate = developmentCertificate;

  const apl = asString(bundleInfo?.apl);
  if (apl) info.apl = apl;

  const appFeature = asString(bundleInfo?.["app-feature"]);
  if (appFeature) info.appFeature = appFeature;

  const notBefore = timestampToDate(validity?.["not-before"]);
  if (notBefore) info.notBefore = notBefore;
  const notAfter = timestampToDate(validity?.["not-after"]);
  if (notAfter) info.notAfter = notAfter;

  return info;
}

export function parseProfileJson(text: string): ProfileInfo {
  return parseProfileObject(JSON.parse(text) as unknown);
}

/**
 * Extract the embedded JSON payload from a signed profile (`p7b`, a CMS
 * SignedData whose eContent is the HarmonyAppProvision JSON).
 *
 * We walk the DER-framed content by scanning for balanced JSON objects and
 * validating each candidate with `JSON.parse`. This tolerates the nesting of
 * SignedData / EncapsulatedContentInfo without hand-rolling ASN.1.
 */
export function extractProfileJsonFromP7b(buffer: Buffer): string | null {
  const latin = buffer.toString("latin1");
  for (let start = latin.indexOf("{"); start !== -1; start = latin.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;

    for (let i = start; i < latin.length; i += 1) {
      const ch = latin[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) continue;

    const candidate = Buffer.from(latin.slice(start, end + 1), "latin1").toString("utf8");
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const record = asRecord(parsed);
      if (record && ("bundle-info" in record || "type" in record || "uuid" in record)) {
        return candidate;
      }
    } catch {
      /* not JSON — keep scanning */
    }
  }
  return null;
}

export interface LoadedProfile {
  info: ProfileInfo;
  /** `json` for an unsigned template, `p7b` for a signed profile. */
  source: "json" | "p7b";
  path: string;
}

export async function loadProfile(path: string): Promise<LoadedProfile> {
  const buffer = await readFile(path);
  if (path.toLowerCase().endsWith(".p7b")) {
    const json = extractProfileJsonFromP7b(buffer);
    if (!json) {
      throw new Error(`could not extract the profile JSON from ${path} (is it a valid .p7b?)`);
    }
    return { info: parseProfileObject(JSON.parse(json) as unknown), source: "p7b", path };
  }
  return { info: parseProfileObject(JSON.parse(buffer.toString("utf8")) as unknown), source: "json", path };
}

// ---------------------------------------------------------------------------
// Certificate encoding
//
// hap-sign-tool decodes `distribution-certificate` with a URL-safe Base64
// decoder. A PEM block or a standard base64 string therefore fails with
// `Illegal base64 character 20 / 2b` — one of the most confusing errors in the
// whole signing flow. We normalise the field to unpadded base64url.
// ---------------------------------------------------------------------------

export type CertificateEncoding = "pem" | "base64" | "base64url";

export interface CertEncodingResult {
  value: string;
  encoding: CertificateEncoding;
}

/** Detect and convert a profile certificate value to unpadded base64url. */
export function toBase64Url(value: string): CertEncodingResult {
  const trimmed = value.trim();
  if (trimmed.includes("BEGIN CERTIFICATE")) {
    const body = trimmed.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "");
    return { value: toUrlSafe(body), encoding: "pem" };
  }
  const compact = trimmed.replace(/\s+/g, "");
  const isUrlSafe = /^[A-Za-z0-9_-]+$/.test(compact);
  if (isUrlSafe) return { value: compact, encoding: "base64url" };
  return { value: toUrlSafe(compact), encoding: "base64" };
}

function toUrlSafe(base64: string): string {
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const CERT_FIELDS = ["distribution-certificate", "development-certificate"] as const;

export interface NormalizedProfile {
  json: unknown;
  changed: boolean;
  encodings: CertificateEncoding[];
}

/** Rewrite certificate fields of a profile document to base64url in place (copy). */
export function normalizeProfileObject(input: unknown): NormalizedProfile {
  const root = asRecord(input);
  const bundleInfo = asRecord(root?.["bundle-info"]);
  if (!root || !bundleInfo) return { json: input, changed: false, encodings: [] };

  const json = structuredClone(input) as Record<string, unknown>;
  const target = asRecord(json["bundle-info"]);
  if (!target) return { json: input, changed: false, encodings: [] };

  let changed = false;
  const encodings: CertificateEncoding[] = [];
  for (const field of CERT_FIELDS) {
    const raw = target[field];
    if (typeof raw !== "string" || raw.trim().length === 0) continue;
    const result = toBase64Url(raw);
    encodings.push(result.encoding);
    if (result.value !== raw) {
      target[field] = result.value;
      changed = true;
    }
  }
  return { json, changed, encodings };
}

/**
 * Write a base64url-normalised copy of the profile next to the output, so the
 * user's source file is never modified behind their back.
 */
export async function normalizeProfileFile(
  sourcePath: string,
  outputPath: string,
): Promise<{ path: string; changed: boolean; encodings: CertificateEncoding[] }> {
  const raw = JSON.parse(await readFile(sourcePath, "utf8")) as unknown;
  const normalized = normalizeProfileObject(raw);
  if (!normalized.changed) return { path: sourcePath, changed: false, encodings: normalized.encodings };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(normalized.json, null, 2)}\n`, "utf8");
  return { path: outputPath, changed: true, encodings: normalized.encodings };
}
