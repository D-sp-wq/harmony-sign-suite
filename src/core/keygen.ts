/**
 * `hss keygen` — build a complete local signing environment with the official
 * `hap-sign-tool.jar`.
 *
 * Root CA → intermediate CA → app key + chain → profile key + chain → profile
 * template. Six shell commands that are easy to get wrong (empty key passwords,
 * missing `-issuerKeystorePwd`, DN ordering, base64url certificates), collapsed
 * into one.
 */
import { randomUUID, X509Certificate } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { HssError } from "./errors.js";
import { extractPemCertificates } from "./certs.js";
import { toBase64Url } from "./profile.js";
import { fileExists, sha256File, writeTextFile } from "../utils/fsx.js";
import { formatArgv } from "../utils/redact.js";

export interface KeygenAliases {
  root: string;
  intermediate: string;
  app: string;
  profile: string;
}

export interface KeygenSubjects {
  root: string;
  intermediate: string;
  app: string;
  profile: string;
}

export interface KeygenOptions {
  javaCommand: string;
  jarPath: string;
  outDir: string;
  /** One password for the keystore and every key inside it. */
  password: string;
  aliases: KeygenAliases;
  subjects: KeygenSubjects;
  validityDays: number;
  force?: boolean;
}

export interface KeygenPaths {
  keystore: string;
  rootCa: string;
  subCa: string;
  appCert: string;
  profileCert: string;
  profileJson: string;
  manifest: string;
}

export interface KeygenStep {
  id: "root-ca" | "intermediate-ca" | "app-key" | "app-cert" | "profile-key" | "profile-cert";
  title: string;
  argv: string[];
  /** Files this step is expected to create. */
  outputs: string[];
}

export interface RunOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (argv: string[], options: { timeoutMs: number }) => Promise<RunOutcome>;

export const defaultRunner: CommandRunner = async (argv, options) => {
  const [executable, ...args] = argv;
  if (!executable) throw new Error("empty command");
  const result = await execa(executable, args, {
    reject: false,
    timeout: options.timeoutMs,
    windowsHide: true,
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};

export function keygenPaths(outDir: string): KeygenPaths {
  return {
    keystore: join(outDir, "local.p12"),
    rootCa: join(outDir, "rootCA.cer"),
    subCa: join(outDir, "subCA.cer"),
    appCert: join(outDir, "app-local.pem"),
    profileCert: join(outDir, "profile-local.pem"),
    profileJson: join(outDir, "profile-local.json"),
    manifest: join(outDir, "keygen-manifest.json"),
  };
}

/** The six commands, in dependency order. */
export function buildKeygenSteps(options: KeygenOptions): KeygenStep[] {
  const paths = keygenPaths(options.outDir);
  const { aliases, subjects, password, javaCommand, jarPath, validityDays } = options;
  const java = [javaCommand, "-jar", jarPath];
  const keystore = ["-keystoreFile", paths.keystore];
  const keystorePwd = ["-keystorePwd", password];
  const keyPwd = ["-keyPwd", password];
  const issuer = [
    "-issuer",
    subjects.intermediate,
    "-issuerKeyAlias",
    aliases.intermediate,
    "-issuerKeyPwd",
    password,
    "-issuerKeystoreFile",
    paths.keystore,
    "-issuerKeystorePwd",
    password,
  ];

  return [
    {
      id: "root-ca",
      title: "生成根 CA",
      outputs: [paths.rootCa],
      argv: [
        ...java,
        "generate-ca",
        "-keyAlias",
        aliases.root,
        ...keyPwd,
        "-keyAlg",
        "ECC",
        "-keySize",
        "NIST-P-256",
        "-subject",
        subjects.root,
        "-validity",
        String(validityDays),
        "-signAlg",
        "SHA256withECDSA",
        ...keystore,
        ...keystorePwd,
        "-outFile",
        paths.rootCa,
      ],
    },
    {
      id: "intermediate-ca",
      title: "生成中间 CA",
      outputs: [paths.subCa],
      argv: [
        ...java,
        "generate-ca",
        "-keyAlias",
        aliases.intermediate,
        ...keyPwd,
        "-keyAlg",
        "ECC",
        "-keySize",
        "NIST-P-256",
        "-issuer",
        subjects.root,
        "-issuerKeyAlias",
        aliases.root,
        "-issuerKeyPwd",
        password,
        "-issuerKeystoreFile",
        paths.keystore,
        "-issuerKeystorePwd",
        password,
        "-subject",
        subjects.intermediate,
        "-validity",
        String(validityDays),
        "-signAlg",
        "SHA256withECDSA",
        ...keystore,
        ...keystorePwd,
        "-outFile",
        paths.subCa,
      ],
    },
    {
      id: "app-key",
      title: "生成应用签名密钥对",
      outputs: [],
      argv: [
        ...java,
        "generate-keypair",
        "-keyAlias",
        aliases.app,
        ...keyPwd,
        "-keyAlg",
        "ECC",
        "-keySize",
        "NIST-P-256",
        ...keystore,
        ...keystorePwd,
      ],
    },
    {
      id: "app-cert",
      title: "签发应用证书链",
      outputs: [paths.appCert],
      argv: [
        ...java,
        "generate-app-cert",
        "-keyAlias",
        aliases.app,
        ...keyPwd,
        ...issuer,
        "-subject",
        subjects.app,
        "-validity",
        String(validityDays),
        "-signAlg",
        "SHA256withECDSA",
        ...keystore,
        ...keystorePwd,
        "-subCaCertFile",
        paths.subCa,
        "-rootCaCertFile",
        paths.rootCa,
        "-outForm",
        "certChain",
        "-outFile",
        paths.appCert,
      ],
    },
    {
      id: "profile-key",
      title: "生成 profile 签名密钥对",
      outputs: [],
      argv: [
        ...java,
        "generate-keypair",
        "-keyAlias",
        aliases.profile,
        ...keyPwd,
        "-keyAlg",
        "ECC",
        "-keySize",
        "NIST-P-256",
        ...keystore,
        ...keystorePwd,
      ],
    },
    {
      id: "profile-cert",
      title: "签发 profile 证书链",
      outputs: [paths.profileCert],
      argv: [
        ...java,
        "generate-profile-cert",
        "-keyAlias",
        aliases.profile,
        ...keyPwd,
        ...issuer,
        "-subject",
        subjects.profile,
        "-validity",
        String(validityDays),
        "-signAlg",
        "SHA256withECDSA",
        ...keystore,
        ...keystorePwd,
        "-subCaCertFile",
        paths.subCa,
        "-rootCaCertFile",
        paths.rootCa,
        "-outForm",
        "certChain",
        "-outFile",
        paths.profileCert,
      ],
    },
  ];
}

/** Default DN set. Order must stay C, O, OU, CN — the tool validates it. */
export function defaultSubjects(org: string): KeygenSubjects {
  const ou = "Local Dev";
  return {
    root: `C=CN,O=${org},OU=${ou},CN=${org} Local Root CA`,
    intermediate: `C=CN,O=${org},OU=${ou},CN=${org} Local Intermediate CA`,
    app: `C=CN,O=${org},OU=${ou},CN=${org} Local App Release`,
    profile: `C=CN,O=${org},OU=${ou},CN=${org} Local Profile Release`,
  };
}

export interface ProfileOptions {
  bundleName: string;
  type: "release" | "debug";
  validityDays: number;
  appCertPath: string;
  outPath: string;
  developerId?: string;
}

/**
 * Write a HarmonyAppProvision template whose embedded certificate is the leaf
 * of the generated app chain, encoded as unpadded base64url (the encoding
 * hap-sign-tool decodes — PEM and standard base64 both fail).
 */
export async function generateProfileFile(options: ProfileOptions): Promise<void> {
  const pem = await readFile(options.appCertPath, "utf8");
  const pems = extractPemCertificates(pem);
  const leafPem = pems[0];
  if (!leafPem) {
    throw new HssError(`no certificate found in ${options.appCertPath}`, {
      hint: "the app certificate chain should contain leaf + intermediate + root",
      code: "KEYGEN_NO_LEAF",
    });
  }

  const leaf = new X509Certificate(leafPem);
  const b64url = toBase64Url(leaf.raw.toString("base64")).value;

  const now = Math.floor(Date.now() / 1000);
  const certField = options.type === "debug" ? "development-certificate" : "distribution-certificate";
  const profile = {
    "version-name": "2.0.0",
    "version-code": 2,
    "app-distribution-type": "os_integration",
    uuid: randomUUID(),
    validity: {
      "not-before": now - 86_400,
      "not-after": now + options.validityDays * 86_400,
    },
    type: options.type,
    "bundle-info": {
      "developer-id": options.developerId ?? "hss-local",
      [certField]: b64url,
      "bundle-name": options.bundleName,
      apl: "normal",
      "app-feature": "hos_normal_app",
    },
    acls: { "allowed-acls": [""] },
    permissions: { "restricted-permissions": [] },
    issuer: "pki_internal",
  };

  await writeTextFile(options.outPath, `${JSON.stringify(profile, null, 2)}\n`);
}

export interface RunKeygenResult {
  ok: boolean;
  steps: Array<{ id: string; title: string; exitCode: number; durationMs: number; stderr: string }>;
  paths: KeygenPaths;
  manifestPath: string;
  expiresAt: Date;
}

export interface RunKeygenOptions extends KeygenOptions {
  bundleName: string;
  profileType: "release" | "debug";
  runner?: CommandRunner;
  timeoutMs?: number;
  log?: {
    step(msg: string): void;
    success(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
    dim(msg: string): void;
  };
}

/** Refuse to clobber an existing signing environment unless `force`. */
export async function assertFreshOutDir(options: KeygenOptions): Promise<void> {
  const paths = keygenPaths(options.outDir);
  const existing: string[] = [];
  for (const path of [paths.keystore, paths.rootCa, paths.appCert, paths.profileCert, paths.profileJson]) {
    if (await fileExists(path)) existing.push(path);
  }
  if (existing.length > 0 && !options.force) {
    throw new HssError(`signing material already exists in ${options.outDir}`, {
      hint: `use --force to overwrite:\n${existing.map((p) => `  - ${p}`).join("\n")}`,
      code: "KEYGEN_EXISTS",
    });
  }
}

export async function runKeygen(options: RunKeygenOptions): Promise<RunKeygenResult> {
  const runner = options.runner ?? defaultRunner;
  const log = options.log;
  const paths = keygenPaths(options.outDir);
  const steps = buildKeygenSteps(options);
  const results: RunKeygenResult["steps"] = [];
  const timeoutMs = options.timeoutMs ?? 120_000;

  // hap-sign-tool does not create parent directories for `-keystoreFile`.
  await mkdir(options.outDir, { recursive: true });

  for (const step of steps) {
    log?.step(step.title);
    log?.dim(`   ${formatArgv(step.argv, [options.password])}`);
    const started = Date.now();
    const outcome = await runner(step.argv, { timeoutMs });
    const durationMs = Date.now() - started;

    results.push({
      id: step.id,
      title: step.title,
      exitCode: outcome.exitCode,
      durationMs,
      stderr: outcome.stderr,
    });

    if (outcome.exitCode !== 0) {
      const detail = (outcome.stderr || outcome.stdout).trim().split(/\r?\n/).slice(-3).join("\n");
      log?.error(`${step.title} 失败 (exit ${outcome.exitCode})`);
      if (detail) log?.dim(`   ${detail}`);
      throw new HssError(`${step.title} 失败`, {
        hint: detail || "check that the JDK version matches the one used to create the keystore",
        code: "KEYGEN_STEP_FAILED",
      });
    }

    for (const output of step.outputs) {
      if (!(await fileExists(output))) {
        throw new HssError(`${step.title} 未生成预期文件：${output}`, { code: "KEYGEN_OUTPUT_MISSING" });
      }
    }
    log?.success(`   ${step.title} 完成 (${(durationMs / 1000).toFixed(1)}s)`);
  }

  await generateProfileFile({
    bundleName: options.bundleName,
    type: options.profileType,
    validityDays: options.validityDays,
    appCertPath: paths.appCert,
    outPath: paths.profileJson,
  });

  const expiresAt = new Date(Date.now() + options.validityDays * 86_400_000);
  const manifest = {
    tool: "hss keygen",
    generatedAt: new Date().toISOString(),
    note: "Local development chain only. AGC release builds must use certificates issued by AppGallery Connect.",
    aliases: options.aliases,
    subjects: options.subjects,
    validityDays: options.validityDays,
    bundleName: options.bundleName,
    profileType: options.profileType,
    toolchain: { jar: options.jarPath, java: options.javaCommand },
    files: await Promise.all(
      (
        [
          ["keystore", paths.keystore],
          ["rootCa", paths.rootCa],
          ["subCa", paths.subCa],
          ["appCert", paths.appCert],
          ["profileCert", paths.profileCert],
          ["profileJson", paths.profileJson],
        ] as const
      ).map(async ([role, path]) => ({ role, path, sha256: await sha256File(path) })),
    ),
    steps: results.map((s) => ({ id: s.id, exitCode: s.exitCode, durationMs: s.durationMs })),
  };
  await writeTextFile(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`);

  return { ok: true, steps: results, paths, manifestPath: paths.manifest, expiresAt };
}

/** Profile for the generated environment, ready to merge into hss.config.yaml. */
export interface GeneratedEnvironment {
  keystore: string;
  keyAlias: string;
  profileKeyAlias: string;
  keystorePwd: { env: string };
  keyPwd: { env: string };
  signAlg: string;
  appCert: string;
  profileCert: string;
  profileJson: string;
  outputDir: string;
  verify: boolean;
}

export function buildGeneratedEnvironment(paths: KeygenPaths, aliases: KeygenAliases): GeneratedEnvironment {
  return {
    keystore: paths.keystore,
    keyAlias: aliases.app,
    profileKeyAlias: aliases.profile,
    keystorePwd: { env: "HSS_KEYSTORE_PWD" },
    keyPwd: { env: "HSS_KEY_PWD" },
    signAlg: "SHA256withECDSA",
    appCert: paths.appCert,
    profileCert: paths.profileCert,
    profileJson: paths.profileJson,
    outputDir: "dist",
    verify: false,
  };
}
