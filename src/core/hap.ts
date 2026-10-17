import AdmZip from "adm-zip";

export interface HapInfo {
  bundleName?: string;
  versionCode?: string;
  versionName?: string;
  moduleName?: string;
  /** Zip entries, used for structure checks and diagnostics. */
  entryNames: string[];
  /** Where bundleName was found (`module.json`, `app.json5`, …). */
  bundleSource?: string;
  hasModuleJson: boolean;
  hasPackInfo: boolean;
  isZip: boolean;
}

/**
 * Parse a JSON5-ish configuration file defensively:
 * strips comments and trailing commas while respecting string literals.
 */
export function parseLenientJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    /* fall through to lenient parsing */
  }

  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? "";
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }
    out += ch;
  }
  out = out.replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(out);
}

function pickString(record: unknown, key: string): string | undefined {
  if (typeof record !== "object" || record === null) return undefined;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/** Accept numbers too: compiled module.json stores versionCode as a number. */
function pickScalar(record: unknown, key: string): string | undefined {
  if (typeof record !== "object" || record === null) return undefined;
  const value = (record as Record<string, unknown>)[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function pickObject(record: unknown, key: string): unknown {
  if (typeof record !== "object" || record === null) return undefined;
  return (record as Record<string, unknown>)[key];
}

interface Extracted {
  bundleName?: string;
  versionCode?: string;
  versionName?: string;
  moduleName?: string;
}

function extractFromConfig(json: unknown): Extracted {
  const result: Extracted = {};
  const app = pickObject(json, "app");
  const module = pickObject(json, "module");

  const bundleName = pickString(app, "bundleName") ?? pickString(json, "bundleName");
  if (bundleName) result.bundleName = bundleName;

  const versionCode = pickScalar(app, "versionCode") ?? pickScalar(json, "versionCode");
  if (versionCode) result.versionCode = versionCode;

  const versionName = pickScalar(app, "versionName") ?? pickScalar(json, "versionName");
  if (versionName) result.versionName = versionName;

  const moduleName = pickString(module, "name") ?? pickString(json, "moduleName");
  if (moduleName) result.moduleName = moduleName;

  return result;
}

const BUNDLE_NAME_RE = /"bundleName"\s*:\s*"([^"]+)"/;

/** Read bundle metadata and package structure from a HAP file. */
export function readHapInfo(hapPath: string): HapInfo {
  const info: HapInfo = {
    entryNames: [],
    hasModuleJson: false,
    hasPackInfo: false,
    isZip: false,
  };

  let zip: AdmZip;
  try {
    zip = new AdmZip(hapPath);
    info.entryNames = zip.getEntries().map((entry) => entry.entryName);
    info.isZip = info.entryNames.length > 0;
  } catch {
    return info;
  }

  const candidates = ["module.json", "module.json5", "app.json", "app.json5", "AppScope/app.json5"];
  for (const name of candidates) {
    const entry = zip.getEntry(name);
    if (!entry) continue;
    if (name.startsWith("module")) info.hasModuleJson = true;
    if (name === "pack.info") info.hasPackInfo = true;
    const text = entry.getData().toString("utf8");
    try {
      const parsed = parseLenientJson(text);
      const extracted = extractFromConfig(parsed);
      if (extracted.bundleName && !info.bundleName) {
        info.bundleName = extracted.bundleName;
        info.bundleSource = name;
      }
      if (extracted.versionCode && !info.versionCode) info.versionCode = extracted.versionCode;
      if (extracted.versionName && !info.versionName) info.versionName = extracted.versionName;
      if (extracted.moduleName && !info.moduleName) info.moduleName = extracted.moduleName;
    } catch {
      const match = BUNDLE_NAME_RE.exec(text);
      if (match?.[1] && !info.bundleName) {
        info.bundleName = match[1];
        info.bundleSource = `${name} (regex fallback)`;
      }
    }
  }

  const packInfo = zip.getEntry("pack.info");
  if (packInfo) {
    info.hasPackInfo = true;
    const text = packInfo.getData().toString("utf8");
    try {
      const parsed = parseLenientJson(text) as { summary?: { app?: { bundleName?: string } } };
      const summary = parsed?.summary;
      if (!info.bundleName && summary?.app?.bundleName) {
        info.bundleName = summary.app.bundleName;
        info.bundleSource = "pack.info";
      }
    } catch {
      /* pack.info is optional metadata */
    }
  }

  if (!info.bundleName) {
    for (const entry of zip.getEntries()) {
      if (!entry.entryName.endsWith(".json") && !entry.entryName.endsWith(".json5")) continue;
      if (entry.header.size > 512 * 1024) continue;
      const match = BUNDLE_NAME_RE.exec(entry.getData().toString("utf8"));
      if (match?.[1]) {
        info.bundleName = match[1];
        info.bundleSource = `${entry.entryName} (scanned)`;
        break;
      }
    }
  }

  return info;
}
