import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { Command } from "commander";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { loadConfig } from "../../config/load.js";
import { HssError } from "../../core/errors.js";
import { findToolchain, resolveJavaCommand } from "../../core/toolchain.js";
import { readHapInfo } from "../../core/hap.js";
import { findNewestHap } from "../../core/discover.js";
import {
  assertFreshOutDir,
  buildGeneratedEnvironment,
  buildKeygenSteps,
  defaultSubjects,
  keygenPaths,
  runKeygen,
  type KeygenAliases,
} from "../../core/keygen.js";
import { fileExists, fileSize, formatBytes, writeTextFile } from "../../utils/fsx.js";
import { ensureSigningIgnored } from "../../utils/gitignore.js";
import { formatArgv } from "../../utils/redact.js";
import { Logger } from "../../utils/logger.js";
import { VERSION } from "../../version.js";

interface KeygenCliOptions {
  out?: string;
  envName?: string;
  bundleName?: string;
  password?: string;
  validity?: string;
  org?: string;
  type?: string;
  aliasPrefix?: string;
  writeConfig?: boolean;
  force?: boolean;
  dryRun?: boolean;
  json?: boolean;
  quiet?: boolean;
}

function generatePassword(): string {
  return randomBytes(18).toString("base64url");
}

/** Rewrite hss.config.yaml with the generated environment, keeping a backup. */
async function patchConfig(options: {
  configPath: string;
  configDir: string;
  envName: string;
  bundleName: string;
  outDir: string;
  aliases: KeygenAliases;
  logger: Logger;
  hapPath?: string;
}): Promise<string> {
  const { configPath, configDir, envName, bundleName, outDir, aliases, logger, hapPath } = options;
  const paths = keygenPaths(outDir);
  const env = buildGeneratedEnvironment(paths, aliases);

  const rel = (path: string): string => relative(configDir, path).replace(/\\/g, "/");
  const environment = {
    ...env,
    keystore: rel(env.keystore),
    appCert: rel(env.appCert),
    profileCert: rel(env.profileCert),
    profileJson: rel(env.profileJson),
  };

  let document: Record<string, unknown> = {};
  if (await fileExists(configPath)) {
    const text = await readFile(configPath, "utf8");
    await writeFile(`${configPath}.bak`, text, "utf8");
    const parsed = parseYaml(text) as unknown;
    document = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    logger.dim(`   已备份原配置 → ${configPath}.bak`);
  }

  document.version = document.version ?? 1;
  const project = (document.project as Record<string, unknown> | undefined) ?? {};
  project.bundleName = project.bundleName ?? bundleName;
  if (hapPath && !project.hapPath) {
    project.hapPath = relative(configDir, hapPath).replace(/\\/g, "/");
  }
  document.project = project;

  const signing = (document.signing as Record<string, unknown> | undefined) ?? {};
  signing.defaultEnv = envName;
  const environments = (signing.environments as Record<string, unknown> | undefined) ?? {};
  environments[envName] = environment;
  signing.environments = environments;
  document.signing = signing;

  await writeTextFile(configPath, stringifyYaml(document));
  return configPath;
}

export function registerKeygen(program: Command): void {
  program
    .command("keygen")
    .description("一键生成本地签名环境：根 CA → 中间 CA → 应用证书链 → profile 证书链 → profile 模板")
    .option("-o, --out <dir>", "输出目录", "signing")
    .option("-e, --env-name <name>", "写入配置的环境名", "local")
    .option("-b, --bundle-name <name>", "profile 使用的 bundleName（默认取配置或 HAP）")
    .option("-p, --password <pwd>", "密钥库/密钥口令（也可用 HSS_KEYGEN_PASSWORD；默认随机生成）")
    .option("-v, --validity <days>", "证书有效期（天）", "365")
    .option("--org <org>", "证书组织名（DN 的 O 字段）", "HSS")
    .option("--type <type>", "profile 类型：release | debug", "release")
    .option("--alias-prefix <prefix>", "密钥别名前缀", "hss")
    .option("--write-config", "把生成结果写入 hss.config.yaml（自动备份）")
    .option("--force", "覆盖已存在的签名物料")
    .option("--dry-run", "只打印将执行的命令")
    .option("--json", "输出机器可读 JSON")
    .option("-q, --quiet", "静默模式")
    .action(async (options: KeygenCliOptions) => {
      const logger = new Logger({ json: options.json === true, quiet: options.quiet === true });

      // 1. optional config — keygen must work even before a config exists, and
      //    it must not refuse to run just because an existing file is incomplete.
      let loaded: Awaited<ReturnType<typeof loadConfig>> | undefined;
      try {
        loaded = await loadConfig({ cwd: process.cwd() });
      } catch (error) {
        if (error instanceof HssError && error.code !== "CONFIG_NOT_FOUND") {
          new Logger({ json: options.json === true, quiet: options.quiet === true }).warn(
            `现有配置无法解析，将忽略并生成新配置：${error.message.split("\n")[0]}`,
          );
        }
        loaded = undefined;
      }
      const configDir = loaded?.configDir ?? process.cwd();

      // 2. bundle name: flag > config > HAP
      let bundleName = options.bundleName ?? loaded?.config.project.bundleName;
      if (!bundleName) {
        try {
          const config = loaded?.config;
          const hapPath = config?.project.hapPath;
          if (hapPath) {
            const info = readHapInfo(resolve(configDir, hapPath));
            bundleName = info.bundleName;
          }
        } catch {
          /* best effort */
        }
      }
      if (!bundleName) {
        throw new HssError("无法确定 bundleName", {
          hint: "传 --bundle-name com.example.app，或先运行 hss init 并在 project.bundleName 中填写，或提供 HAP 构建产物",
          code: "KEYGEN_NO_BUNDLE",
        });
      }

      // 3. password: flag > env > generated
      const generatedPassword = !options.password && !process.env.HSS_KEYGEN_PASSWORD;
      const password = options.password ?? process.env.HSS_KEYGEN_PASSWORD ?? generatePassword();
      if (password.length < 6) {
        throw new HssError("口令至少 6 位", { hint: "hap-sign-tool 对过短口令的加密强度有要求", code: "KEYGEN_WEAK_PASSWORD" });
      }

      const validityDays = Number.parseInt(options.validity ?? "365", 10);
      if (!Number.isFinite(validityDays) || validityDays <= 0) {
        throw new HssError(`无效的有效期：${options.validity}`, { code: "KEYGEN_BAD_VALIDITY" });
      }
      const profileType = options.type === "debug" ? "debug" : "release";
      const outDir = resolve(configDir, options.out ?? "signing");
      const prefix = options.aliasPrefix ?? "hss";
      const aliases: KeygenAliases = {
        root: `${prefix}-root`,
        intermediate: `${prefix}-sub`,
        app: `${prefix}-app`,
        profile: `${prefix}-profile`,
      };
      const subjects = defaultSubjects(options.org ?? "HSS");

      // 4. toolchain
      const search = await findToolchain({
        configured: loaded?.config.signing.toolchain,
        configDir,
      });
      if (!search.info) {
        throw new HssError("未找到 hap-sign-tool.jar，无法生成签名环境", {
          hint: [
            "在配置里设置 signing.toolchain，或设置环境变量 HSS_TOOLCHAIN",
            ...(search.attempts.length > 0 ? [`已尝试：${search.attempts.slice(0, 5).join(" | ")}`] : []),
          ].join("\n"),
          code: "TOOLCHAIN_MISSING",
        });
      }
      const toolchain = search.info;
      const javaCommand = resolveJavaCommand(loaded?.config.signing.javaPath);

      const keygenOptions = {
        javaCommand,
        jarPath: toolchain.jarPath,
        outDir,
        password,
        aliases,
        subjects,
        validityDays,
        force: options.force === true,
      };

      if (options.dryRun) {
        logger.heading("hss keygen — dry run");
        for (const step of buildKeygenSteps(keygenOptions)) {
          logger.raw(`  [${step.id}] ${step.title}`);
          logger.raw(`    ${formatArgv(step.argv, [password])}`);
        }
        logger.raw("");
        logger.dim(`输出目录 ${outDir}`);
        logger.dim(`工具链   ${toolchain.jarPath}`);
        return;
      }

      await assertFreshOutDir(keygenOptions);

      logger.heading("hss keygen");
      logger.dim(`   输出目录 ${outDir}`);
      logger.dim(`   工具链   ${toolchain.jarPath} · java ${toolchain.java.version}`);

      const result = await runKeygen({
        ...keygenOptions,
        bundleName,
        profileType,
        log: {
          step: (msg) => logger.step(msg),
          success: (msg) => logger.success(msg),
          warn: (msg) => logger.warn(msg),
          error: (msg) => logger.error(msg),
          dim: (msg) => logger.dim(msg),
        },
      });

      const files: Array<{ role: string; path: string; bytes: number }> = [];      for (const [role, path] of [
        ["keystore", result.paths.keystore],
        ["root CA", result.paths.rootCa],
        ["intermediate CA", result.paths.subCa],
        ["app chain", result.paths.appCert],
        ["profile chain", result.paths.profileCert],
        ["profile json", result.paths.profileJson],
        ["manifest", result.manifestPath],
      ] as const) {
        if (await fileExists(path)) files.push({ role, path, bytes: await fileSize(path) });
      }

      let configPath: string | undefined;
      if (options.writeConfig) {
        const discoveredHap = loaded?.config.project.hapPath ? undefined : await findNewestHap(configDir);
        configPath = await patchConfig({
          configPath: join(configDir, "hss.config.yaml"),
          configDir,
          envName: options.envName ?? "local",
          bundleName,
          outDir,
          aliases,
          logger,
          ...(discoveredHap ? { hapPath: discoveredHap } : {}),
        });
      }

      const ignored = await ensureSigningIgnored(configDir);
      if (ignored.length > 0 && !options.json) {
        logger.success(`已写入 .gitignore（${ignored.join(", ")}）`);
      }

      if (options.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              tool: "hss keygen",
              version: VERSION,
              ok: true,
              envName: options.envName ?? "local",
              bundleName,
              profileType,
              validityDays,
              outDir,
              aliases,
              passwordGenerated: generatedPassword,
              configPath: configPath ?? null,
              files,
              manifest: result.manifestPath,
            },
            null,
            2,
          )}\n`,
        );
        return;
      }

      logger.heading("签名环境已生成");
      for (const file of files) {
        logger.success(`${file.role.padEnd(16)} ${formatBytes(file.bytes).padStart(9)}  ${file.path}`);
      }
      logger.raw("");
      if (configPath) logger.success(`已写入配置 ${configPath}（env=${options.envName ?? "local"}）`);

      if (generatedPassword) {
        logger.raw("");
        logger.warn("已生成随机口令，只显示这一次，请立即保存：");
        logger.raw(`   ${password}`);
      }
      logger.raw("");
      logger.heading("下一步");
      logger.info("  1. 设置口令环境变量：");
      logger.info(`       PowerShell:  $env:HSS_KEYSTORE_PWD="${generatedPassword ? password : "<你的口令>"}"; $env:HSS_KEY_PWD="${generatedPassword ? password : "<你的口令>"}"`);
      logger.info(`       bash/zsh:    export HSS_KEYSTORE_PWD='${generatedPassword ? password : "<口令>"}' HSS_KEY_PWD='${generatedPassword ? password : "<口令>"}'`);
      logger.info("  2. 体检：  hss doctor");
      logger.info("  3. 签名：  hss sign --dry-run && hss sign");
      logger.raw("");
      logger.dim("注意：自建 CA 链仅用于本地/OpenHarmony 设备调试，AGC 上架必须使用 AppGallery Connect 签发的证书。");
    });
}
