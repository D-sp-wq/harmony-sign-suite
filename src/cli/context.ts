import type { LoadedConfig } from "../config/schema.js";
import { loadConfig } from "../config/load.js";
import { Logger } from "../utils/logger.js";

export interface CommonOptions {
  config?: string;
  env?: string;
  json?: boolean;
  quiet?: boolean;
}

export function makeLogger(options: CommonOptions): Logger {
  return new Logger({ json: options.json === true, quiet: options.quiet === true });
}

export function loadFromOptions(options: CommonOptions): Promise<LoadedConfig> {
  return loadConfig({
    configPath: options.config,
    env: options.env,
    cwd: process.cwd(),
  });
}
