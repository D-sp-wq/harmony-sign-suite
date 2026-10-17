import type { Command } from "commander";
import { CONFIG_FILE } from "../../version.js";
import { loadConfig } from "../../config/load.js";
import { HssError } from "../../core/errors.js";
import { detectJava, findToolchain } from "../../core/toolchain.js";
import { fail, ok, warn, type CheckResult } from "../../core/result.js";
import { preflight } from "../preflight.js";
import { makeLogger } from "../context.js";
import { printJson, printReport, toJsonPayload } from "../../core/report.js";

interface DoctorOptions {
  config?: string;
  env?: string;
  json?: boolean;
  quiet?: boolean;
}

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("体检：Java、签名工具链、证书链、bundleName、profile 一致性")
    .option("-c, --config <path>", "指定配置文件")
    .option("-e, --env <name>", "签名环境")
    .option("--json", "输出机器可读 JSON")
    .option("-q, --quiet", "静默模式")
    .action(async (options: DoctorOptions) => {
      const logger = makeLogger(options);

      let loaded;
      try {
        loaded = await loadConfig({ configPath: options.config, env: options.env, cwd: process.cwd() });
      } catch (error) {
        if (error instanceof HssError && error.code === "CONFIG_NOT_FOUND") {
          // Allow bootstrapping: report environment only.
          const results: CheckResult[] = [];
          const java = await detectJava();
          results.push(
            java && java.major >= 8
              ? ok("env.java", "Java 版本", `java ${java.version}`)
              : fail("env.java", "Java 版本", java ? `java ${java.version} 过低` : "未找到 java", "安装 JDK/JRE 8+"),
          );
          const search = await findToolchain({ configDir: process.cwd() });
          results.push(
            search.info
              ? ok("env.toolchain", "签名工具链", search.info.jarPath)
              : warn(
                  "env.toolchain",
                  "签名工具链",
                  "未找到 hap-sign-tool.jar",
                  [
                    "设置 HSS_TOOLCHAIN 指向 jar 或所在目录",
                    ...(search.attempts.length > 0 ? [`已尝试：${search.attempts.slice(0, 5).join(" | ")}`] : []),
                  ].join("\n"),
                ),
          );
          results.push(warn("config.loaded", "配置文件", `未找到 ${CONFIG_FILE}`, "运行 hss init 生成配置"));

          if (options.json) {
            printJson(toJsonPayload(results, { command: "doctor" }));
          } else {
            printReport(logger, results, { command: "doctor" });
            logger.raw("");
            logger.dim("提示：当前目录还没有配置文件，运行 `hss init` 开始接入。");
          }
          return;
        }
        throw error;
      }

      const { results, toolchain, attempts } = await preflight(loaded);

      if (options.json) {
        printJson(
          toJsonPayload(results, {
            command: "doctor",
            configPath: loaded.configPath,
            envName: loaded.envName,
            projectName: loaded.config.project.name,
          }),
        );
        return;
      }

      printReport(logger, results, {
        command: "doctor",
        configPath: loaded.configPath,
        envName: loaded.envName,
        projectName: loaded.config.project.name,
      });

      if (!toolchain) {
        logger.raw("");
        logger.dim("签名工具链探测路径：");
        for (const attempt of attempts.slice(0, 12)) logger.dim(`  - ${attempt}`);
      }

      const failures = results.filter((r) => r.status === "fail");
      if (failures.length > 0) process.exitCode = 1;
    });
}
