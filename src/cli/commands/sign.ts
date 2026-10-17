import { join } from "node:path";
import type { Command } from "commander";
import { preflight } from "../preflight.js";
import { loadFromOptions, makeLogger } from "../context.js";
import { formatArgv } from "../../utils/redact.js";
import { formatBytes, shortHash } from "../../utils/fsx.js";
import { buildPlan, executePlan, writeManifest, diagnoseToolOutput, isUntrustedChainError } from "../../core/signing.js";
import { normalizeProfileFile } from "../../core/profile.js";
import { printJson, printReport, renderMarkdown, toJsonPayload } from "../../core/report.js";
import { writeTextFile } from "../../utils/fsx.js";
import { HssError } from "../../core/errors.js";
import { summarize } from "../../core/result.js";

interface SignOptions {
  config?: string;
  env?: string;
  json?: boolean;
  quiet?: boolean;
  dryRun?: boolean;
  force?: boolean;
  timeout?: string;
}

export function registerSign(program: Command): void {
  program
    .command("sign")
    .description("一条命令完成 profile 签名 + HAP 签名 + 官方验签")
    .option("-c, --config <path>", "指定配置文件")
    .option("-e, --env <name>", "签名环境")
    .option("--dry-run", "只打印将要执行的命令，不执行")
    .option("--force", "即使校验有失败项也继续签名")
    .option("--timeout <ms>", "单步超时（毫秒）")
    .option("--json", "输出机器可读 JSON")
    .option("-q, --quiet", "静默模式")
    .action(async (options: SignOptions) => {
      const logger = makeLogger(options);
      const loaded = await loadFromOptions(options);

      const { results, toolchain } = await preflight(loaded);
      const meta = {
        command: "sign",
        configPath: loaded.configPath,
        envName: loaded.envName,
        projectName: loaded.config.project.name,
      };

      if (!options.json) printReport(logger, results, meta);

      const failures = results.filter((r) => r.status === "fail");
      const summary = summarize(results);
      const reportPath = join(loaded.env.outputDir, "hss-report.md");
      await writeTextFile(reportPath, renderMarkdown(results, { ...meta, command: "sign (pre-flight)" }));

      if (!toolchain && !options.dryRun) {
        throw new HssError("未找到 hap-sign-tool.jar，无法签名", {
          hint: "在配置里设置 signing.toolchain，或设置环境变量 HSS_TOOLCHAIN 指向 jar/所在目录",
          code: "TOOLCHAIN_MISSING",
        });
      }

      if (failures.length > 0 && !options.force) {
        if (options.json) {
          printJson({ ...toJsonPayload(results, meta), signed: false, reason: "pre-flight checks failed" });
        } else {
          logger.error(`\n预检有 ${failures.length} 项失败，已中止签名（加 --force 可强制继续）`);
          logger.dim(`report   ${reportPath}`);
        }
        process.exitCode = 1;
        return;
      }

      // hap-sign-tool decodes profile certificates as URL-safe base64; keep the
      // user's source file untouched and sign a normalised copy instead.
      let normalizedProfilePath: string | undefined;
      if (loaded.env.profileJson) {
        const normalized = await normalizeProfileFile(
          loaded.env.profileJson,
          join(loaded.env.outputDir, "hss-profile.normalized.json"),
        );
        if (normalized.changed) {
          loaded.env.profileJson = normalized.path;
          normalizedProfilePath = normalized.path;
          if (!options.json) {
            logger.warn(`profile 内嵌证书编码已自动转为 base64url（${normalized.encodings.join("/")} → base64url）`);
            logger.dim(`   用于签名的副本：${normalized.path}`);
          }
        }
      }
      void normalizedProfilePath;

      const effectiveToolchain = toolchain ?? {
        jarPath: "<hap-sign-tool.jar>",
        java: { path: "java", version: "unknown", major: 0 },
      };
      const plan = buildPlan(loaded, effectiveToolchain);

      if (options.dryRun) {
        if (!toolchain) {
          if (!options.json) logger.warn("未找到 hap-sign-tool.jar：以下命令中的 jar 路径是占位符，仅用于确认参数结构");
        }
        if (options.json) {
          printJson({
            ...toJsonPayload(results, meta),
            dryRun: true,
            plan: {
              env: plan.envName,
              paths: plan.paths,
              commands: plan.commands.map((c) => ({
                id: c.id,
                title: c.title,
                command: formatArgv(c.argv, loaded.secrets),
              })),
            },
          });
          return;
        }
        logger.heading("dry-run：将执行以下命令（口令已脱敏）");
        for (const command of plan.commands) {
          logger.raw(`  [${command.id}] ${command.title}`);
          logger.raw(`    ${formatArgv(command.argv, loaded.secrets)}`);
        }
        logger.raw("");
        logger.dim(`输出目录 ${plan.paths.manifest.replace(/[\\/]hss-sign-manifest\.json$/, "")}`);
        logger.dim("确认无误后去掉 --dry-run 实际执行。");
        return;
      }

      const started = Date.now();
      const steps = await executePlan(plan, {
        secrets: loaded.secrets,
        logger,
        ...(options.timeout ? { timeoutMs: Number.parseInt(options.timeout, 10) } : {}),
      });
      const verifyTrustIssue = steps.find(
        (s) => s.id === "verify-app" && s.exitCode !== 0 && isUntrustedChainError(`${s.stdout}\n${s.stderr}`),
      );
      const failed = steps.filter(
        (s) => s.exitCode !== 0 && !(s.id === "verify-app" && isUntrustedChainError(`${s.stdout}\n${s.stderr}`)),
      );

      const { path: manifestPath, outputs } = await writeManifest({
        plan,
        loaded,
        toolchain: effectiveToolchain,
        steps,
        checks: summary,
      });

      await writeTextFile(
        join(loaded.env.outputDir, "hss-report.md"),
        renderMarkdown(results, { ...meta, command: "sign" }),
      );

      const ok = failed.length === 0;

      if (verifyTrustIssue && !options.json) {
        logger.warn("官方验签未通过信任校验（自建 CA 链的预期结果，不影响出包）");
        logger.dim("   正式上架请使用 AGC 签发的证书链，或设置 verify: false 关闭该步骤");
      }

      if (options.json) {
        printJson({
          ...toJsonPayload(results, meta),
          signed: ok,
          verifyTrusted: !verifyTrustIssue,
          durationMs: Date.now() - started,
          outputs,
          manifest: manifestPath,
          steps: steps.map((s) => ({ id: s.id, exitCode: s.exitCode, durationMs: s.durationMs })),
        });
      } else {
        logger.heading(ok ? "签名完成" : "签名失败");
        for (const output of outputs) {
          logger.success(`${output.role.padEnd(15)} ${formatBytes(output.bytes).padStart(9)}  ${output.path}`);
          logger.dim(`                 sha256 ${shortHash(output.sha256)}`);
        }
        logger.raw("");
        logger.dim(`manifest ${manifestPath}`);
        logger.dim(`report   ${reportPath}`);
        logger.dim(`总耗时   ${((Date.now() - started) / 1000).toFixed(1)}s`);

        if (!ok) {
          logger.raw("");
          for (const step of failed) {
            logger.error(`${step.title} 失败（exit ${step.exitCode}）`);
            for (const hint of diagnoseToolOutput(`${step.stdout}\n${step.stderr}`)) {
              logger.dim(`  ↳ ${hint}`);
            }
          }
        }
      }

      if (!ok) process.exitCode = 1;
    });
}
