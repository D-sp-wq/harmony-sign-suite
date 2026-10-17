export type CheckStatus = "pass" | "warn" | "fail" | "skip";

export interface CheckResult {
  /** Stable machine id, e.g. `cert.chain-order`. */
  id: string;
  /** Human readable one-liner. */
  title: string;
  status: CheckStatus;
  /** What was actually observed. */
  detail?: string;
  /** What the user should do about it. */
  hint?: string;
  /** Optional reference link. */
  docs?: string;
  /** Extra machine readable facts (paths, hashes, versions). */
  evidence?: Record<string, string>;
}

export interface CheckSummary {
  total: number;
  pass: number;
  warn: number;
  fail: number;
  skip: number;
}

export function summarize(results: readonly CheckResult[]): CheckSummary {
  const summary: CheckSummary = { total: results.length, pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const r of results) {
    summary[r.status] += 1;
  }
  return summary;
}

/** Exit code convention: failures are fatal, warnings are not. */
export function exitCodeFor(results: readonly CheckResult[]): number {
  return results.some((r) => r.status === "fail") ? 1 : 0;
}

export function ok(id: string, title: string, detail?: string, evidence?: Record<string, string>): CheckResult {
  return { id, title, status: "pass", ...(detail ? { detail } : {}), ...(evidence ? { evidence } : {}) };
}

export function warn(id: string, title: string, detail?: string, hint?: string): CheckResult {
  return { id, title, status: "warn", ...(detail ? { detail } : {}), ...(hint ? { hint } : {}) };
}

export function fail(id: string, title: string, detail?: string, hint?: string): CheckResult {
  return { id, title, status: "fail", ...(detail ? { detail } : {}), ...(hint ? { hint } : {}) };
}

export function skip(id: string, title: string, detail?: string): CheckResult {
  return { id, title, status: "skip", ...(detail ? { detail } : {}) };
}
