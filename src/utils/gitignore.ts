import { join } from "node:path";
import { fileExists, readTextFile, writeTextFile } from "./fsx.js";

/** Rules that keep a generated signing environment out of version control. */
export const SIGNING_IGNORE_RULES = [
  "signing/",
  "*.p12",
  "*.jks",
  "*.p7b",
  "*.pem",
  "*.cer",
  "*.key",
] as const;

/**
 * Make sure signing material is ignored by git. Returns the rules that were
 * added (empty when the file already covered everything).
 */
export async function ensureSigningIgnored(dir: string): Promise<string[]> {
  const path = join(dir, ".gitignore");
  const existing = (await fileExists(path)) ? await readTextFile(path) : "";
  const present = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
  const missing = SIGNING_IGNORE_RULES.filter((rule) => !present.has(rule));
  if (missing.length === 0) return [];

  const head = existing.trimEnd();
  const block = [
    ...(head.length > 0 ? [head, ""] : []),
    "# ---- added by hss: never commit signing material ----",
    ...missing,
  ].join("\n");
  await writeTextFile(path, `${block}\n`);
  return missing;
}
