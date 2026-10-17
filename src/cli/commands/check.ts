import { join } from "node:path";
import type { Command } from "commander";
import { preflight } from "../preflight.js";
import { loadFromOptions, makeLogger } from "../context.js";
import { printJson, printReport, renderMarkdown, toJsonPayload } from "../../core/report.js";
import { writeTextFile } from "../../utils/fsx.js";

interface CheckOptions {
  config?: string;
  env?: string;
  json?: boolean;
  quiet?: boolean;
  report?: string;
}

export function registerCheck(program: Command): void {
  program
    .command("check")
    .description("只跑校验规则，不执行签名（CI 预检用）")
    .option("-c, --config <path>", "指定配置文件")
    .option("-e, --env <name>", "签名环境")
    .option("--json", "输出机器可读 JSON")
    .option("-q, --quiet", "静默模式")
    .option("--report <path>", "同时写出 Markdown 报告")
    .action(async (options: CheckOptions) => {
      const logger = makeLogger(options);
      const loaded = await loadFromOptions(options);
      const { results } = await preflight(loaded);

      const meta = {
        command: "check",
        configPath: loaded.configPath,
        envName: loaded.envName,
        projectName: loaded.config.project.name,
      };

      if (options.json) {
        printJson(toJsonPayload(results, meta));
      } else {
        printReport(logger, results, meta);
      }

      const reportPath = options.report ?? join(loaded.env.outputDir, "hss-report.md");
      await writeTextFile(reportPath, renderMarkdown(results, meta));
      if (!options.json) logger.dim(`\nreport   ${reportPath}`);

      if (results.some((r) => r.status === "fail")) process.exitCode = 1;
    });
}
