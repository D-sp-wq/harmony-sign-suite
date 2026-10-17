import { readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { execa } from "execa";
import { fileExists, resolvePath } from "../utils/fsx.js";

export interface JavaInfo {
  path: string;
  /** Raw version string as printed by `java -version`. */
  version: string;
  /** Major version, `1.8.0_401` → 8. */
  major: number;
}

export interface ToolchainInfo {
  jarPath: string;
  java: JavaInfo;
  /** Version reported by the jar itself when available. */
  toolVersion?: string;
}

export interface ToolchainSearchResult {
  info?: ToolchainInfo;
  /** Paths that were probed, in order, for diagnostics. */
  attempts: string[];
}

const JAR_NAMES = new Set(["hap-sign-tool.jar"]);
const SDK_ENV_VARS = [
  "HSS_TOOLCHAIN",
  "OHOS_SDK_HOME",
  "HARMONY_SDK_HOME",
  "DEVECO_SDK_HOME",
  "DEVECO_HOME",
  "OVS_SDK_HOME",
  "OHOS_SDK",
];

/** Run `java -version` and parse the major version. */
export async function detectJava(javaPath?: string): Promise<JavaInfo | null> {
  const executable = javaPath ?? "java";
  try {
    const result = await execa(executable, ["-version"], { reject: false, timeout: 20_000 });
    const text = `${result.stderr}\n${result.stdout}`;
    if (result.exitCode !== 0 && !/version/i.test(text)) return null;

    const match = /version\s+"([^"]+)"/i.exec(text);
    const version = match?.[1] ?? "unknown";
    return { path: executable, version, major: parseJavaMajor(version) };
  } catch {
    return null;
  }
}

export function parseJavaMajor(version: string): number {
  const cleaned = version.trim();
  if (cleaned.startsWith("1.")) {
    const second = cleaned.split(".")[1] ?? "0";
    return Number.parseInt(second, 10) || 0;
  }
  const major = Number.parseInt(cleaned.split(/[.+-]/)[0] ?? "0", 10);
  return Number.isNaN(major) ? 0 : major;
}

async function isJar(path: string): Promise<boolean> {
  if (!path.toLowerCase().endsWith(".jar")) return false;
  return fileExists(path);
}

/** Bounded recursive search for `hap-sign-tool.jar`. */
async function findJarUnder(root: string, maxDepth: number): Promise<string | null> {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    let entries;
    try {
      entries = await readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && JAR_NAMES.has(entry.name.toLowerCase())) {
        return join(current.dir, entry.name);
      }
    }
    if (current.depth >= maxDepth) continue;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      queue.push({ dir: join(current.dir, entry.name), depth: current.depth + 1 });
    }
  }
  return null;
}

interface Candidate {
  path: string;
  label: string;
}

function defaultRoots(): Candidate[] {
  const home = homedir();
  const platform = process.platform;
  const roots: Candidate[] = [];

  if (platform === "win32") {
    roots.push(
      { path: join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Huawei", "Sdk"), label: "%LOCALAPPDATA%\\Huawei\\Sdk" },
      { path: join(process.env.LOCALAPPDATA ?? "", "Huawei", "HarmonyOS", "Sdk"), label: "%LOCALAPPDATA%\\Huawei\\HarmonyOS\\Sdk" },
      { path: join(home, "Huawei", "Sdk"), label: "~/Huawei/Sdk" },
      { path: "C:\\Program Files\\Huawei\\DevEco Studio\\sdk", label: "DevEco Studio default sdk" },
      { path: "C:\\Program Files\\Huawei\\DevEco Studio", label: "DevEco Studio install" },
    );
  } else if (platform === "darwin") {
    roots.push(
      { path: join(home, "Library", "Huawei", "Sdk"), label: "~/Library/Huawei/Sdk" },
      { path: "/Applications/DevEco-Studio.app/Contents/sdk", label: "DevEco Studio app sdk" },
      { path: join(home, "Huawei", "Sdk"), label: "~/Huawei/Sdk" },
    );
  } else {
    roots.push(
      { path: join(home, "Huawei", "Sdk"), label: "~/Huawei/Sdk" },
      { path: "/opt/huawei/sdk", label: "/opt/huawei/sdk" },
      { path: "/opt/Huawei/Sdk", label: "/opt/Huawei/Sdk" },
    );
  }
  return roots.filter((r) => r.path.length > 0);
}

/**
 * Discover the signing toolchain:
 *   1. explicit config path (file or directory)
 *   2. `HSS_TOOLCHAIN` / SDK environment variables
 *   3. well-known DevEco Studio SDK locations
 */
export async function findToolchain(options: {
  configured?: string;
  configDir: string;
}): Promise<ToolchainSearchResult> {
  const attempts: string[] = [];

  const tryCandidate = async (candidate: string, label: string): Promise<string | null> => {
    const resolved = resolvePath(candidate, options.configDir);
    attempts.push(`${label}: ${resolved}`);
    if (await isJar(resolved)) return resolved;
    try {
      const found = await findJarUnder(resolved, 5);
      if (found) {
        attempts[attempts.length - 1] = `${label}: ${found}`;
        return found;
      }
    } catch {
      /* ignore */
    }
    return null;
  };

  let jarPath: string | null = null;

  if (options.configured) {
    jarPath = await tryCandidate(options.configured, "config signing.toolchain");
  }

  if (!jarPath) {
    for (const envVar of SDK_ENV_VARS) {
      const value = process.env[envVar];
      if (!value) continue;
      jarPath = await tryCandidate(value, `$${envVar}`);
      if (jarPath) break;
    }
  }

  if (!jarPath) {
    for (const root of defaultRoots()) {
      if (!root.path) continue;
      jarPath = await tryCandidate(root.path, `default(${root.label})`);
      if (jarPath) break;
    }
  }

  if (!jarPath) return { attempts };

  const java = await detectJava(process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", "java") : undefined);
  if (!java) return { attempts };

  const toolVersion = await probeToolVersion(jarPath, java.path);
  return {
    info: { jarPath, java, ...(toolVersion ? { toolVersion } : {}) },
    attempts,
  };
}

async function probeToolVersion(jarPath: string, javaPath: string): Promise<string | undefined> {
  try {
    const result = await execa(javaPath, ["-jar", jarPath, "-version"], {
      reject: false,
      timeout: 30_000,
    });
    const text = `${result.stdout}\n${result.stderr}`.trim();
    if (result.exitCode !== 0) return undefined;
    return text.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim();
  } catch {
    return undefined;
  }
}

/** Java command used to run the tool: explicit config > JAVA_HOME > PATH. */
export function resolveJavaCommand(configured?: string): string {
  if (configured) return configured;
  if (process.env.JAVA_HOME) {
    return join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java");
  }
  return "java";
}

export function describeToolchain(info: ToolchainInfo): string {
  return `${basename(info.jarPath)} (java ${info.java.version})`;
}
