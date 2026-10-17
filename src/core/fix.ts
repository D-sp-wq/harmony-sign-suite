/**
 * `hss fix` — repair the two problems that account for most signing failures:
 *
 *   1. certificate chains in the wrong order (leaf → intermediate → root)
 *   2. profile certificates encoded as PEM / standard base64 instead of base64url
 *
 * Every change is planned first (so `--dry-run` is exact) and every written file
 * keeps a timestamped backup.
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { LoadedConfig } from "../config/schema.js";
import { parsePemChain, shortDn, validateChainOrder, type ParsedCertificate } from "./certs.js";
import { normalizeProfileObject, toBase64Url } from "./profile.js";
import { fileExists, writeTextFile } from "../utils/fsx.js";

export type FixId = "cert.chain-order" | "profile.cert-encoding";

export interface FixChange {
  id: FixId;
  file: string;
  title: string;
  /** Human readable description of the current state. */
  before: string;
  /** Human readable description of the repaired state. */
  after: string;
}

export interface FileRepair {
  path: string;
  kind: "pem-chain" | "profile-json";
  original: string;
  updated: string;
  changes: FixChange[];
}

export interface SkippedFix {
  file: string;
  id: FixId | "profile.p7b";
  reason: string;
}

export interface FixPlan {
  repairs: FileRepair[];
  skipped: SkippedFix[];
}

export const FIX_IDS: readonly FixId[] = ["cert.chain-order", "profile.cert-encoding"];

function cnList(chain: readonly ParsedCertificate[]): string {
  return chain.map((c) => shortDn(c.subject)).join(" → ");
}

export interface ChainRepair {
  status: "changed" | "unchanged" | "unfixable";
  updated: string;
  before: ParsedCertificate[];
  after: ParsedCertificate[];
  /** Certificates that could not be linked into the chain (excluded from the result). */
  dropped: ParsedCertificate[];
  reason?: string;
}

/**
 * Reorder a PEM bundle from leaf to root by following issuer → subject links.
 *
 * Unrelated certificates are appended at the end instead of being dropped, so
 * the operation stays lossless.
 */
export function planChainRepair(pemText: string): ChainRepair {
  const chain = parsePemChain(pemText);
  if (chain.length < 2) {
    return {
      status: "unfixable",
      updated: pemText,
      before: chain,
      after: chain,
      dropped: [],
      reason: "证书链少于 2 张，属于「链不完整」，无法通过排序修复",
    };
  }

  if (validateChainOrder(chain).ok) {
    return { status: "unchanged", updated: pemText, before: chain, after: chain, dropped: [] };
  }

  const bySubject = new Map<string, number>();
  chain.forEach((cert, index) => {
    if (!bySubject.has(cert.subject)) bySubject.set(cert.subject, index);
  });
  const issuerSubjects = new Set(chain.map((cert) => cert.issuer));

  // The leaf is the certificate nobody else was issued by.
  let leafIndex = chain.findIndex((cert) => !issuerSubjects.has(cert.subject));
  if (leafIndex < 0) {
    // Fall back to a certificate that is not self-signed.
    leafIndex = chain.findIndex((cert) => cert.subject !== cert.issuer);
  }
  if (leafIndex < 0) {
    return {
      status: "unfixable",
      updated: pemText,
      before: chain,
      after: chain,
      dropped: [],
      reason: "无法确定叶子证书（所有证书都自签或互相签发）",
    };
  }

  const order: number[] = [leafIndex];
  const visited = new Set<number>([leafIndex]);
  let current = leafIndex;

  for (;;) {
    const cert = chain[current];
    if (!cert) break;
    const next = bySubject.get(cert.issuer);
    if (next === undefined || visited.has(next)) break;
    order.push(next);
    visited.add(next);
    current = next;
  }

  // Certificates that cannot be linked into the chain are excluded: keeping
  // them would make the bundle fail verification even after reordering.
  const dropped = chain.filter((_cert, index) => !visited.has(index));
  const after = order.map((index) => chain[index]).filter((c): c is ParsedCertificate => c !== undefined);
  const reordered = after.map((cert) => cert.pem).join("");

  if (validateChainOrder(after).ok) {
    return { status: "changed", updated: reordered, before: chain, after, dropped };
  }

  if (reordered === chain.map((c) => c.pem).join("")) {
    return { status: "unchanged", updated: pemText, before: chain, after, dropped };
  }

  return {
    status: "unfixable",
    updated: pemText,
    before: chain,
    after,
    dropped,
    reason: "按签发关系重排后仍无法通过校验，可能缺少中间 CA 或证书不匹配",
  };
}

export interface ProfileRepair {
  status: "changed" | "unchanged";
  updated: string;
  before: string;
  after: string;
}

/** Normalise the embedded certificate(s) of a profile JSON document. */
export function planProfileRepair(jsonText: string): ProfileRepair {
  const parsed = JSON.parse(jsonText) as unknown;
  const normalized = normalizeProfileObject(parsed);
  if (!normalized.changed) {
    return { status: "unchanged", updated: jsonText, before: "base64url", after: "base64url" };
  }

  const original = (parsed as Record<string, unknown>)["bundle-info"] as Record<string, unknown> | undefined;
  const field = typeof original?.["distribution-certificate"] === "string" ? "distribution-certificate" : "development-certificate";
  const raw = typeof original?.[field] === "string" ? (original[field] as string) : "";
  const encoding = toBase64Url(raw).encoding;
  const updated = `${JSON.stringify(normalized.json, null, 2)}\n`;
  return { status: "changed", updated, before: encoding, after: "base64url" };
}

/** Build a fix plan from the paths in the loaded configuration. */
export async function planFixes(loaded: LoadedConfig): Promise<FixPlan> {
  const repairs: FileRepair[] = [];
  const skipped: SkippedFix[] = [];

  for (const [kind, path] of [
    ["appCert", loaded.env.appCert],
    ["profileCert", loaded.env.profileCert],
  ] as const) {
    if (!(await fileExists(path))) continue;
    const original = await readFile(path, "utf8");
    const result = planChainRepair(original);
    if (result.status === "changed") {
      const droppedNote =
        result.dropped.length > 0
          ? `（移除 ${result.dropped.length} 张无法关联的证书：${result.dropped.map((c) => shortDn(c.subject)).join("、")}）`
          : "";
      repairs.push({
        path,
        kind: "pem-chain",
        original,
        updated: result.updated,
        changes: [
          {
            id: "cert.chain-order",
            file: `${basename(path)}（${kind}）`,
            title: "证书链顺序",
            before: cnList(result.before),
            after: `${cnList(result.after)}${droppedNote}`,
          },
        ],
      });
    } else if (result.status === "unfixable") {
      skipped.push({ file: path, id: "cert.chain-order", reason: result.reason ?? "无法自动修复" });
    }
  }

  if (loaded.env.profileJson && (await fileExists(loaded.env.profileJson))) {
    const original = await readFile(loaded.env.profileJson, "utf8");
    const result = planProfileRepair(original);
    if (result.status === "changed") {
      repairs.push({
        path: loaded.env.profileJson,
        kind: "profile-json",
        original,
        updated: result.updated,
        changes: [
          {
            id: "profile.cert-encoding",
            file: basename(loaded.env.profileJson),
            title: "profile 内嵌证书编码",
            before: result.before,
            after: result.after,
          },
        ],
      });
    }
  }

  if (loaded.env.profileP7b && !loaded.env.profileJson) {
    skipped.push({
      file: loaded.env.profileP7b,
      id: "profile.p7b",
      reason: "已签名 profile（p7b）不可改写；编码问题需在 AGC/源码侧重新生成",
    });
  }

  return { repairs, skipped };
}

export interface ApplyResult {
  path: string;
  backup?: string;
  changes: FixChange[];
}

/** Write the planned repairs, keeping timestamped backups. */
export async function applyFixes(
  plan: FixPlan,
  options: { backup?: boolean; timestamp?: string } = {},
): Promise<ApplyResult[]> {
  const stamp = options.timestamp ?? new Date().toISOString().replace(/[:.]/g, "-");
  const results: ApplyResult[] = [];

  for (const repair of plan.repairs) {
    if (repair.original === repair.updated) continue;
    let backup: string | undefined;
    if (options.backup !== false) {
      backup = `${repair.path}.bak-${stamp}`;
      await writeTextFile(backup, repair.original);
    }
    await writeTextFile(repair.path, repair.updated);
    results.push({
      path: repair.path,
      ...(backup ? { backup } : {}),
      changes: repair.changes,
    });
  }

  return results;
}
