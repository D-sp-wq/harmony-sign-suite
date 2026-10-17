import type { CheckResult, CheckStatus, CheckSummary } from "./result.js";
import { summarize } from "./result.js";
import type { Logger } from "../utils/logger.js";

const ICONS: Record<CheckStatus, string> = {
  pass: "✓",
  warn: "!",
  fail: "✗",
  skip: "-",
};

const LABELS: Record<CheckStatus, string> = {
  pass: "PASS",
  warn: "WARN",
  fail: "FAIL",
  skip: "SKIP",
};

export interface ReportMeta {
  command: string;
  configPath?: string;
  envName?: string;
  projectName?: string;
  timestamp?: string;
}

/** Print a check report to the terminal. */
export function printReport(logger: Logger, results: readonly CheckResult[], meta: ReportMeta): void {
  logger.heading(`hss ${meta.command}`);
  if (meta.configPath) logger.dim(`config   ${meta.configPath}`);
  if (meta.envName) logger.dim(`env      ${meta.envName}`);
  logger.raw("");

  const width = Math.min(64, Math.max(...results.map((r) => r.title.length), 10));
  for (const r of results) {
    const padded = r.title.padEnd(width, " ");
    if (r.status === "pass") logger.info(`  ✓ ${padded}  ${r.detail ?? ""}`.trimEnd());
    else if (r.status === "warn") logger.warn(`  ! ${padded}  ${r.detail ?? ""}`.trimEnd());
    else if (r.status === "fail") logger.error(`  ✗ ${padded}  ${r.detail ?? ""}`.trimEnd());
    else logger.dim(`  - ${padded}  ${r.detail ?? ""}`.trimEnd());

    if (r.hint && r.status !== "pass") {
      for (const line of r.hint.split("\n")) logger.dim(`      ↳ ${line}`);
    }
    if (r.docs && r.status !== "pass") logger.dim(`      docs ${r.docs}`);
  }

  const s = summarize(results);
  logger.raw("");
  logger.info(
    `${s.pass} passed · ${s.warn} warning(s) · ${s.fail} failure(s)` +
      (s.skip ? ` · ${s.skip} skipped` : "") +
      `  (${s.total} checks)`,
  );
}

/** Render a Markdown report, suitable for CI artifacts and PR comments. */
export function renderMarkdown(results: readonly CheckResult[], meta: ReportMeta): string {
  const s = summarize(results);
  const lines: string[] = [];
  lines.push(`# hss ${meta.command} report`);
  lines.push("");
  if (meta.configPath) lines.push(`- config: \`${meta.configPath}\``);
  if (meta.envName) lines.push(`- environment: \`${meta.envName}\``);
  if (meta.projectName) lines.push(`- project: \`${meta.projectName}\``);
  lines.push(`- generated: ${meta.timestamp ?? new Date().toISOString()}`);
  lines.push("");
  lines.push(`**${s.fail === 0 ? "Ready to sign" : "Blocked"}** — ${s.pass} passed, ${s.warn} warning(s), ${s.fail} failure(s), ${s.skip} skipped`);
  lines.push("");
  const present = new Set(results.map((r) => r.status));
  const order: CheckStatus[] = ["fail", "warn", "pass", "skip"];
  for (const status of order) {
    if (!present.has(status)) continue;
    lines.push(`## ${LABELS[status]}`);
    lines.push("");
    lines.push("| check | detail | hint |");
    lines.push("| --- | --- | --- |");
    for (const r of results.filter((x) => x.status === status)) {
      const detail = escapeCell(r.detail ?? "");
      const hint = escapeCell(r.hint ?? "");
      lines.push(`| ${escapeCell(r.title)} | ${detail} | ${hint} |`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** Machine-readable payload for `--json`. */
export function toJsonPayload(results: readonly CheckResult[], meta: ReportMeta): Record<string, unknown> {
  const summary: CheckSummary = summarize(results);
  return {
    command: meta.command,
    configPath: meta.configPath,
    envName: meta.envName,
    projectName: meta.projectName,
    timestamp: meta.timestamp ?? new Date().toISOString(),
    summary,
    results,
    ok: summary.fail === 0,
  };
}

export function printJson(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}
