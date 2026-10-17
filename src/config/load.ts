import { readFile } from "node:fs/promises";
import { dirname, join, parse as parsePath, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  configSchema,
  formatConfigIssues,
  type HssConfig,
  type LoadedConfig,
  type ResolvedEnvironment,
  type SecretRef,
} from "./schema.js";
import { CONFIG_FILE } from "../version.js";
import { HssError } from "../core/errors.js";
import { fileExists, resolvePath } from "../utils/fsx.js";

export interface LoadOptions {
  /** Explicit config path (`--config`). */
  configPath?: string;
  /** Directory to start searching from. */
  cwd?: string;
  /** Environment name (`--env`); defaults to `signing.defaultEnv`. */
  env?: string;
}

/**
 * Locate `hss.config.yaml`: an explicit path wins, otherwise walk up from the
 * working directory so the CLI works from any subdirectory of a project.
 */
export async function findConfigPath(cwd: string, explicit?: string): Promise<string> {
  if (explicit) {
    const candidate = resolve(cwd, explicit);
    if (!(await fileExists(candidate))) {
      throw new HssError(`config file not found: ${candidate}`, {
        hint: `run \`hss init\` to create ${CONFIG_FILE}, or pass the correct --config path`,
        code: "CONFIG_NOT_FOUND",
      });
    }
    return candidate;
  }

  let dir = resolve(cwd);
  const root = parsePath(dir).root;
  for (;;) {
    const candidate = join(dir, CONFIG_FILE);
    if (await fileExists(candidate)) return candidate;
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new HssError(`no ${CONFIG_FILE} found in ${cwd} or any parent directory`, {
    hint: "run `hss init` in your project root to generate one",
    code: "CONFIG_NOT_FOUND",
  });
}

async function resolveSecret(ref: SecretRef | undefined, configDir: string): Promise<string | undefined> {
  if (ref === undefined) return undefined;

  if (typeof ref === "string") {
    if (ref.trim().length === 0) {
      throw new HssError("secret reference resolved to an empty value", { code: "SECRET_EMPTY" });
    }
    return ref;
  }

  if ("env" in ref) {
    const value = process.env[ref.env];
    if (value === undefined || value.length === 0) {
      throw new HssError(`environment variable ${ref.env} is not set`, {
        hint: `export ${ref.env}=<your-password> before running hss (never commit it)`,
        code: "SECRET_ENV_MISSING",
      });
    }
    return value;
  }

  const filePath = resolvePath(ref.file, configDir);
  if (!(await fileExists(filePath))) {
    throw new HssError(`secret file not found: ${filePath}`, { code: "SECRET_FILE_MISSING" });
  }
  const value = (await readFile(filePath, "utf8")).replace(/\r?\n$/, "");
  if (value.length === 0) {
    throw new HssError(`secret file is empty: ${filePath}`, { code: "SECRET_EMPTY" });
  }
  return value;
}

export async function loadConfig(options: LoadOptions = {}): Promise<LoadedConfig> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = await findConfigPath(cwd, options.configPath);
  const configDir = dirname(configPath);

  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch (error) {
    throw new HssError(`cannot read ${configPath}`, { cause: error, code: "CONFIG_UNREADABLE" });
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    throw new HssError(`invalid YAML in ${configPath}`, {
      hint: error instanceof Error ? error.message : String(error),
      code: "CONFIG_INVALID_YAML",
    });
  }

  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const issues = formatConfigIssues(result.error);
    throw new HssError(`${configPath} is invalid:\n  - ${issues.join("\n  - ")}`, {
      hint: "compare your file with `hss init` output or the JSON schema in the docs",
      code: "CONFIG_INVALID",
    });
  }
  const config = result.data;

  const envNames = Object.keys(config.signing.environments);
  if (envNames.length === 0) {
    throw new HssError("no signing environments defined", {
      hint: "add at least one entry under signing.environments, e.g. `release:`",
      code: "CONFIG_NO_ENV",
    });
  }

  const envName = options.env ?? config.signing.defaultEnv;
  const envConfig = config.signing.environments[envName];
  if (!envConfig) {
    throw new HssError(`signing environment "${envName}" is not defined`, {
      hint: `available environments: ${envNames.join(", ")}`,
      code: "CONFIG_ENV_UNKNOWN",
    });
  }

  const keyPwd = await resolveSecret(envConfig.keyPwd, configDir);
  const profileKeyPwd = await resolveSecret(envConfig.profileKeyPwd, configDir);
  const keystorePwd = await resolveSecret(envConfig.keystorePwd, configDir);

  const hapPath = envConfig.hapPath ?? config.project.hapPath;

  const env: ResolvedEnvironment = {
    name: envName,
    keystore: resolvePath(envConfig.keystore, configDir),
    keyAlias: envConfig.keyAlias,
    ...(keyPwd !== undefined ? { keyPwd } : {}),
    ...(envConfig.profileKeyAlias ? { profileKeyAlias: envConfig.profileKeyAlias } : {}),
    ...(profileKeyPwd !== undefined ? { profileKeyPwd } : {}),
    ...(keystorePwd !== undefined ? { keystorePwd } : {}),
    signAlg: envConfig.signAlg,
    appCert: resolvePath(envConfig.appCert, configDir),
    profileCert: resolvePath(envConfig.profileCert, configDir),
    ...(envConfig.profileJson ? { profileJson: resolvePath(envConfig.profileJson, configDir) } : {}),
    ...(envConfig.profileP7b ? { profileP7b: resolvePath(envConfig.profileP7b, configDir) } : {}),
    ...(hapPath ? { hapPath: resolvePath(hapPath, configDir) } : {}),
    outputDir: resolvePath(envConfig.outputDir, configDir),
    ...(envConfig.outputName ? { outputName: envConfig.outputName } : {}),
    verify: envConfig.verify,
  };

  const secrets = [keyPwd, profileKeyPwd, keystorePwd].filter((s): s is string => Boolean(s));

  return { configPath, configDir, config, envName, env, secrets };
}

/** Validate a config object without touching the filesystem (used by tests). */
export function validateConfigObject(value: unknown): HssConfig {
  const result = configSchema.safeParse(value);
  if (!result.success) {
    throw new HssError(`invalid config:\n  - ${formatConfigIssues(result.error).join("\n  - ")}`);
  }
  return result.data;
}
