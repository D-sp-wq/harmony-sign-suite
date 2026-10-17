import type { Command } from "commander";
import { loadFromOptions, makeLogger } from "../context.js";
import { applyFixes, planFixes } from "../../core/fix.js";
import { preflight } from "../preflight.js";
import { summarize } from "../../core/result.js";
import { printJson } from "../../core/report.js";
import { formatBytes, fileSize } from "../../utils/fsx.js";

interface FixOptions {
  config?: string;
  env?: string;
  dryRun?: boolean;
  noBackup?: boolean;
  json?: boolean;
  quiet?: boolean;
}

export function registerFix(program: Command): void {
  program
    .command("fix")
    .description("自动修复证书链顺序与 profile 证书编码（默认写入，自动备份）")
    .option("-c, --config <path>", "指定配置文件")
    .option("-e, --env <name>", "签名环境")
    .option("--dry-run", "只预览将修改的内容，不写入")
    .option("--no-backup", "不生成 .bak 备份")
    .option("--json", "输出机器可读 JSON")
    .option("-q, --quiet", "静默模式")
    .action(async (options: FixOptions) => {
      const logger = makeLogger(options);
      const loaded = await loadFromOptions(options);

      logger.heading("hss fix");
      logger.dim(`config   ${loaded.configPath}`);
      logger.dim(`env      ${loaded.envName}`);

      const plan = await planFixes(loaded);

      if (plan.repairs.length === 0) {
        if (options.json) {
          printJson({
            command: "fix",
            configPath: loaded.configPath,
            envName: loaded.envName,
            changed: [],
            skipped: plan.skipped,
            ok: plan.skipped.length === 0,
          });
          return;
        }
        logger.success("没有需要修复的问题");
        reportSkipped(logger, plan.skipped);
        return;
      }

      if (!options.dryRun) {
        await applyFixes(plan, { backup: options.noBackup !== true });
      }

      // Report what happened.
      logger.raw("");
      for (const repair of plan.repairs) {
        const size = await fileSize(repair.path);
        for (const change of repair.changes) {
          logger.info(`  [${change.id}] ${change.file}  (${formatBytes(size)})`);
          logger.dim(`      修复前  ${change.before}`);
          logger.info(`      修复后  ${change.after}`);
        }
      }

      // Verify the result by running the same checks again.
      let after: ReturnType<typeof summarize> | undefined;
      if (!options.dryRun) {
        const result = await preflight(loaded);
        after = summarize(result.results);
        logger.raw("");
        logger.success(`已写入 ${plan.repairs.length} 个文件${options.noBackup ? "（未备份）" : "（已生成 .bak 备份）"}`);
        logger.info(
          `修复后体检：${after.pass} passed · ${after.warn} warning · ${after.fail} failure（共 ${after.total} 项）`,
        );
        if (after.fail > 0) {
          logger.dim("仍有失败项，运行 `hss doctor` 查看详情");
          process.exitCode = 1;
        }
      } else {
        logger.raw("");
        logger.dim("预览模式：去掉 --dry-run 即可写入（会自动生成 .bak 备份）");
      }

      reportSkipped(logger, plan.skipped);

      if (options.json) {
        printJson({
          command: "fix",
          configPath: loaded.configPath,
          envName: loaded.envName,
          dryRun: options.dryRun === true,
          changed: plan.repairs.map((repair) => ({
            path: repair.path,
            kind: repair.kind,
            changes: repair.changes,
          })),
          skipped: plan.skipped,
          ...(after ? { checks: after } : {}),
        });
      }
    });
}

function reportSkipped(
  logger: { warn(msg: string): void; dim(msg: string): void },
  skipped: ReadonlyArray<{ file: string; id: string; reason: string }>,
): void {
  if (skipped.length === 0) return;
  logger.warn("以下问题需要人工处理：");
  for (const item of skipped) {
    logger.dim(`  [${item.id}] ${item.file}`);
    logger.dim(`      ${item.reason}`);
  }
}
