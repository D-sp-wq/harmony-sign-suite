import type { LoadedConfig } from "../config/schema.js";
import { findToolchain, type ToolchainInfo } from "../core/toolchain.js";
import { runChecks } from "../core/checks.js";
import type { CheckResult } from "../core/result.js";

export interface PreflightResult {
  results: CheckResult[];
  toolchain?: ToolchainInfo;
  attempts: string[];
}

/** Discover the toolchain and run every applicable check. */
export async function preflight(loaded: LoadedConfig): Promise<PreflightResult> {
  const search = await findToolchain({
    configured: loaded.config.signing.toolchain,
    configDir: loaded.configDir,
  });

  const results = await runChecks({
    loaded,
    ...(search.info ? { toolchain: search.info } : {}),
    toolchainAttempts: search.attempts,
  });

  return {
    results,
    ...(search.info ? { toolchain: search.info } : {}),
    attempts: search.attempts,
  };
}
