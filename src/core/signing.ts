import { basename, extname, join } from "node:path";
import { execa } from "execa";
import type { LoadedConfig } from "../config/schema.js";
import type { ToolchainInfo } from "./toolchain.js";
import { resolveJavaCommand } from "./toolchain.js";
import { formatArgv, redact } from "../utils/redact.js";
import { fileExists, fileSize, sha256File, writeTextFile } from "../utils/fsx.js";
import type { CheckSummary } from "./result.js";
import { VERSION } from "../version.js";

export interface SignCommand {
  id: "sign-profile" | "sign-app" | "verify-app";
  title: string;
  argv: string[];
}

export interface SignPlan {
  envName: string;
  javaCommand: string;
  jarPath: string;
  commands: SignCommand[];
  paths: {
    hap: string;
    signedProfile: string;
    signedHap: string;
    certChain: string;
    extractedProfile: string;
    manifest: string;
  };
  /** True when a pre-signed .p7b was supplied, so sign-profile is skipped. */
  usesPresignedProfile: boolean;
}

export interface StepResult {
  id: SignCommand["id"];
  title: string;
  command: string;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export interface SignResult {
  ok: boolean;
  plan: SignPlan;
  steps: StepResult[];
  manifestPath: string;
  outputs: Array<{ role: string; path: string; sha256: string; bytes: number }>;
}

export function buildPlan(loaded: LoadedConfig, toolchain: ToolchainInfo): SignPlan {
  const { env } = loaded;
  if (!env.hapPath) {
    throw new Error("hapPath is not configured (project.hapPath or signing.<env>.hapPath)");
  }

  const javaCommand = resolveJavaCommand(loaded.config.signing.javaPath);
  const base = env.outputName ?? basename(env.hapPath, extname(env.hapPath));
  const outputDir = env.outputDir;

  const signedProfile = join(outputDir, `${base}.p7b`);
  const signedHap = join(outputDir, `${base}-signed.hap`);
  const certChain = join(outputDir, `${base}-certchain.pem`);
  const extractedProfile = join(outputDir, `${base}-profile.json`);
  const manifest = join(outputDir, "hss-sign-manifest.json");

  const common: string[] = ["-mode", "localSign", "-signAlg", env.signAlg];
  const keystoreArgs: string[] = ["-keystoreFile", env.keystore];
  if (env.keystorePwd) keystoreArgs.push("-keystorePwd", env.keystorePwd);

  const appKeyArgs: string[] = ["-keyAlias", env.keyAlias];
  if (env.keyPwd) appKeyArgs.push("-keyPwd", env.keyPwd);

  const profileKeyArgs: string[] = ["-keyAlias", env.profileKeyAlias ?? env.keyAlias];
  const profileKeyPwd = env.profileKeyPwd ?? env.keyPwd;
  if (profileKeyPwd) profileKeyArgs.push("-keyPwd", profileKeyPwd);

  const commands: SignCommand[] = [];
  const jar = toolchain.jarPath;

  if (env.profileJson && !env.profileP7b) {
    commands.push({
      id: "sign-profile",
      title: "签名 HarmonyAppProvision",
      argv: [
        javaCommand,
        "-jar",
        jar,
        "sign-profile",
        ...common,
        ...profileKeyArgs,
        "-profileCertFile",
        env.profileCert,
        "-inFile",
        env.profileJson,
        ...keystoreArgs,
        "-outFile",
        signedProfile,
      ],
    });
  }

  const profileFile = env.profileP7b ?? signedProfile;
  commands.push({
    id: "sign-app",
    title: "签名 HAP 包",
    argv: [
      javaCommand,
      "-jar",
      jar,
      "sign-app",
      ...common,
      ...appKeyArgs,
      "-appCertFile",
      env.appCert,
      "-profileFile",
      profileFile,
      "-inFile",
      env.hapPath,
      ...keystoreArgs,
      "-outFile",
      signedHap,
    ],
  });

  if (loaded.env.verify) {
    commands.push({
      id: "verify-app",
      title: "官方验签",
      argv: [
        javaCommand,
        "-jar",
        jar,
        "verify-app",
        "-inFile",
        signedHap,
        "-outCertchain",
        certChain,
        "-outProfile",
        extractedProfile,
      ],
    });
  }

  return {
    envName: loaded.envName,
    javaCommand,
    jarPath: jar,
    commands,
    paths: { hap: env.hapPath, signedProfile, signedHap, certChain, extractedProfile, manifest },
    usesPresignedProfile: Boolean(env.profileP7b) && !env.profileJson,
  };
}

export interface ExecuteOptions {
  secrets: string[];
  logger: {
    step(msg: string): void;
    success(msg: string): void;
    dim(msg: string): void;
    error(msg: string): void;
    warn(msg: string): void;
  };
  timeoutMs?: number;
}

export async function executePlan(plan: SignPlan, options: ExecuteOptions): Promise<StepResult[]> {
  const results: StepResult[] = [];
  const timeout = options.timeoutMs ?? 10 * 60_000;

  for (const command of plan.commands) {
    const [executable, ...args] = command.argv;
    if (!executable) throw new Error(`empty command for ${command.id}`);

    options.logger.step(`${command.title}`);
    options.logger.dim(`   ${formatArgv(command.argv, options.secrets)}`);
    const started = Date.now();
    const result = await execa(executable, args, {
      reject: false,
      timeout,
      windowsHide: true,
      env: { ...process.env, JAVA_TOOL_OPTIONS: "" },
    });

    const step: StepResult = {
      id: command.id,
      title: command.title,
      command: formatArgv(command.argv, options.secrets),
      exitCode: result.exitCode ?? 1,
      durationMs: Date.now() - started,
      stdout: redact(result.stdout ?? "", options.secrets),
      stderr: redact(result.stderr ?? "", options.secrets),
    };
    results.push(step);

    if (step.exitCode !== 0) {
      const trustOnly = command.id === "verify-app" && isUntrustedChainError(`${step.stdout}\n${step.stderr}`);
      if (trustOnly) {
        options.logger.warn(`   ${command.title}：证书链不受工具信任（自建 CA 链的预期结果，签名本身有效）`);
      } else {
        options.logger.error(`   ${command.title} 失败 (exit ${step.exitCode})`);
        for (const hint of diagnoseToolOutput(`${step.stdout}\n${step.stderr}`)) {
          options.logger.dim(`   ↳ ${hint}`);
        }
        const tail = step.stderr.trim().split(/\r?\n/).slice(-4).join("\n");
        if (tail) options.logger.dim(`   ${tail}`);
      }
      break;
    }
    options.logger.success(`   ${command.title} 完成 (${(step.durationMs / 1000).toFixed(1)}s)`);
  }

  return results;
}

/** Turn known hap-sign-tool failures into actionable guidance. */
export function diagnoseToolOutput(output: string): string[] {
  const hints: string[] = [];
  const text = output.toLowerCase();

  if (/illegal base64 character/.test(text)) {
    hints.push(
      "profile 内嵌证书编码不对：hap-sign-tool 用 URL-safe Base64 解码，PEM 或标准 base64 都会报这个错。hss sign 会自动转成 base64url，手动调用时需自行转换。",
    );
  }
  if (/param is not trusted/.test(text) || /not trusted/.test(text)) {
    hints.push(
      "证书链不被工具信任：自建 CA 的链无法通过 verify-app 的信任校验（不影响 sign-app 出包）。正式上架请使用 AGC 签发的证书链。",
    );
  }
  if (/code:\s*105/.test(text) || /not_support_error/.test(text)) {
    hints.push("错误码 105：参数不受支持。常见原因是 signAlg 与证书密钥类型不匹配（ECC 证书必须用 SHA256withECDSA / SHA384withECDSA）。");
  }
  if (/code:\s*107/.test(text) || /wrong key usage/.test(text)) {
    hints.push("错误码 107：证书用途不匹配或证书链顺序错误。确认 profile 证书链是 叶子 → 中间 CA → 根 CA。");
  }
  if (/code:\s*108/.test(text) || /unable to find valid certification path/.test(text)) {
    hints.push("错误码 108：证书链无法验证。检查证书链是否完整、顺序是否正确、是否用了错误的 CA。");
  }
  if (/keystore was tampered with|password verification failed|failed to decrypt/.test(text) || /keystore/.test(text) && /password/.test(text)) {
    hints.push("密钥库口令错误或密钥库损坏。检查 keystorePwd / keyPwd（注意 PowerShell 里 $pwd 是自动变量，避免同名）。");
  }
  if (/no such file|does not exist|filenotfound/.test(text)) {
    hints.push("有文件路径不存在：核对配置里的 keystore / appCert / profileCert / profileJson / hapPath。");
  }
  if (/outfile/.test(text) && hints.length === 0) {
    hints.push("输出路径问题：确认输出目录存在且可写，参数中的 - 必须用英文连字符。");
  }
  return hints;
}

/**
 * `verify-app` validates against the tool's trust store, so chains built from a
 * self-signed CA are rejected with "Param is not trusted" even when the
 * signature itself is valid. That case should be a warning, not a failed build.
 */
export function isUntrustedChainError(output: string): boolean {
  return /param is not trusted|not trusted/i.test(output);
}

export interface ManifestInput {
  plan: SignPlan;
  loaded: LoadedConfig;
  toolchain: ToolchainInfo;
  steps: StepResult[];
  checks: CheckSummary;
}

export async function writeManifest(input: ManifestInput): Promise<{ path: string; outputs: SignResult["outputs"] }> {
  const { plan, loaded, toolchain, steps, checks } = input;

  const inputRoles: Array<{ role: string; path: string }> = [
    { role: "hap", path: plan.paths.hap },
    { role: "keystore", path: loaded.env.keystore },
    { role: "appCert", path: loaded.env.appCert },
    { role: "profileCert", path: loaded.env.profileCert },
  ];
  if (loaded.env.profileJson) inputRoles.push({ role: "profileJson", path: loaded.env.profileJson });
  if (loaded.env.profileP7b) inputRoles.push({ role: "profileP7b", path: loaded.env.profileP7b });

  const inputs: Array<{ role: string; path: string; sha256: string }> = [];
  for (const item of inputRoles) {
    if (!(await fileExists(item.path))) continue;
    inputs.push({ ...item, sha256: await sha256File(item.path) });
  }

  const outputs: SignResult["outputs"] = [];
  for (const role of ["signedHap", "signedProfile", "certChain", "extractedProfile"] as const) {
    const path = plan.paths[role];
    if (!(await fileExists(path))) continue;
    outputs.push({ role, path, sha256: await sha256File(path), bytes: await fileSize(path) });
  }

  const jarSha = (await fileExists(plan.jarPath)) ? await sha256File(plan.jarPath) : "unknown";

  const manifest = {
    tool: "hss",
    version: VERSION,
    generatedAt: new Date().toISOString(),
    env: loaded.envName,
    project: {
      bundleName: loaded.config.project.bundleName ?? null,
      hap: loaded.env.hapPath,
    },
    toolchain: {
      jar: plan.jarPath,
      jarSha256: jarSha,
      javaCommand: plan.javaCommand,
      javaVersion: toolchain.java.version,
      toolVersion: toolchain.toolVersion ?? null,
    },
    checks,
    inputs,
    outputs,
    steps: steps.map((s) => ({
      id: s.id,
      command: s.command,
      exitCode: s.exitCode,
      durationMs: s.durationMs,
      stderrTail: s.stderr.trim().split(/\r?\n/).slice(-5).join("\n"),
    })),
    ok: steps.every((s) => s.exitCode === 0) && outputs.some((o) => o.role === "signedHap"),
  };

  await writeTextFile(plan.paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
  return { path: plan.paths.manifest, outputs };
}
