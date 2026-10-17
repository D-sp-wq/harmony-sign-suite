import { readFile, mkdir } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { CONFIG_FILE } from "../../version.js";
import { HssError } from "../../core/errors.js";
import { fileExists, readTextFile, writeTextFile } from "../../utils/fsx.js";
import { findNewestHap } from "../../core/discover.js";
import { readHapInfo } from "../../core/hap.js";
import { Logger } from "../../utils/logger.js";

const TEMPLATES_DIR = fileURLToPath(new URL("../../../templates", import.meta.url));

interface InitOptions {
  dir?: string;
  force?: boolean;
  bundleName?: string;
  name?: string;
}

/** Quote a value for safe embedding into a YAML plain/single-quoted scalar. */
function yamlScalar(value: string): string {
  if (/^[A-Za-z0-9_./\\:-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "''")}'`;
}

async function readTemplate(name: string): Promise<string> {
  return readFile(join(TEMPLATES_DIR, name), "utf8");
}

async function mergeGitignore(dir: string, snippet: string, logger: Logger): Promise<void> {
  const path = join(dir, ".gitignore");
  const existing = (await fileExists(path)) ? await readTextFile(path) : "";
  const missing = snippet
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0 && !line.trim().startsWith("#"))
    .filter((line) => !existing.split(/\r?\n/).some((current) => current.trim() === line.trim()));

  if (missing.length === 0) {
    logger.dim("   .gitignore 已包含签名物料规则");
    return;
  }
  const block = [
    "",
    "# ---- added by hss (HarmonyOS signing material) ----",
    ...snippet.split(/\r?\n/),
    "",
  ].join("\n");
  await writeTextFile(path, `${existing.trimEnd()}\n${block}`);
  logger.success(`已更新 .gitignore（补充 ${missing.length} 条规则）`);
}

export function registerInit(program: Command): void {
  program
    .command("init")
    .description("生成 hss.config.yaml、.gitignore 规则与 CI 模板")
    .option("-d, --dir <dir>", "目标目录", ".")
    .option("-f, --force", "覆盖已存在的文件")
    .option("-b, --bundle-name <name>", "bundleName（默认从最近的 HAP 推断）")
    .option("-n, --name <name>", "项目名")
    .action(async (options: InitOptions) => {
      const logger = new Logger();
      const dir = resolve(process.cwd(), options.dir ?? ".");
      await mkdir(dir, { recursive: true });

      const configPath = join(dir, CONFIG_FILE);
      if ((await fileExists(configPath)) && !options.force) {
        throw new HssError(`${CONFIG_FILE} 已存在：${configPath}`, {
          hint: "使用 --force 覆盖，或先备份旧配置",
          code: "INIT_EXISTS",
        });
      }

      logger.heading("hss init");

      // Try to infer sensible defaults from an existing build output.
      const hap = await findNewestHap(dir);
      let hapRel = "build/default/outputs/default/entry-default-signed.hap";
      let bundleName = options.bundleName ?? "com.example.app";

      if (hap) {
        hapRel = relative(dir, hap) || hap;
        logger.dim(`   发现 HAP：${hapRel}`);
        if (!options.bundleName) {
          try {
            const info = readHapInfo(hap);
            if (info.bundleName) {
              bundleName = info.bundleName;
              logger.dim(`   从 HAP 读取 bundleName：${bundleName}`);
            }
          } catch {
            /* best effort */
          }
        }
      }

      const projectName = options.name ?? basename(dir);
      const template = await readTemplate("hss.config.yaml");
      const content = template
        .replaceAll("__PROJECT_NAME__", yamlScalar(projectName))
        .replaceAll("__BUNDLE_NAME__", yamlScalar(bundleName))
        .replaceAll("__HAP_PATH__", yamlScalar(hapRel));
      await writeTextFile(configPath, content);
      logger.success(`已生成 ${relative(process.cwd(), configPath) || CONFIG_FILE}`);

      await mergeGitignore(dir, await readTemplate("gitignore-snippet.txt"), logger);

      const workflowPath = join(dir, ".github", "workflows", "hss-sign.yml");
      if ((await fileExists(workflowPath)) && !options.force) {
        logger.dim("   .github/workflows/hss-sign.yml 已存在，跳过");
      } else {
        await mkdir(join(dir, ".github", "workflows"), { recursive: true });
        await writeTextFile(workflowPath, await readTemplate("github-sign.yml"));
        logger.success("已生成 .github/workflows/hss-sign.yml");
      }

      logger.heading("下一步");
      logger.info("  1. 把密钥库与证书放进 signing/ 目录（该目录已被 .gitignore 忽略）");
      logger.info("  2. 设置口令环境变量（不要写进配置文件）：");
      logger.info("       PowerShell:  $env:HSS_KEYSTORE_PWD=\"...\"; $env:HSS_KEY_PWD=\"...\"");
      logger.info("       bash/zsh:    export HSS_KEYSTORE_PWD=...  HSS_KEY_PWD=...");
      logger.info("  3. 体检：  hss doctor");
      logger.info("  4. 签名：  hss sign --env release --dry-run   # 先看命令，不执行");
      logger.info("            hss sign --env release");
      logger.raw("");
      logger.dim(`  模板目录：${TEMPLATES_DIR}`);
    });
}
