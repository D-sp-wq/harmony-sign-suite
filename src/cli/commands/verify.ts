import { join, resolve } from "node:path";
import { execa } from "execa";
import type { Command } from "commander";
import { loadFromOptions, makeLogger } from "../context.js";
import { findToolchain, resolveJavaCommand } from "../../core/toolchain.js";
import { HssError } from "../../core/errors.js";
import { findNewestHap } from "../../core/discover.js";
import { readHapInfo } from "../../core/hap.js";
import { parsePemChain, validateChainOrder, summarizeCertificate } from "../../core/certs.js";
import { parseProfileJson } from "../../core/profile.js";
import { isUntrustedChainError } from "../../core/signing.js";
import { fail, ok, warn, type CheckResult } from "../../core/result.js";
import { printJson, printReport, toJsonPayload } from "../../core/report.js";
import { fileExists, readTextFile } from "../../utils/fsx.js";
import { VERSION } from "../../version.js";

interface VerifyOptions {
  config?: string;
  env?: string;
  json?: boolean;
  quiet?: boolean;
}

export function registerVerify(program: Command): void {
  program
    .command("verify [package]")
    .description("对已签名包做官方验签，并核对包内 profile 与 bundleName")
    .option("-c, --config <path>", "指定配置文件")
    .option("-e, --env <name>", "签名环境")
    .option("--json", "输出机器可读 JSON")
    .option("-q, --quiet", "静默模式")
    .action(async (packageArg: string | undefined, options: VerifyOptions) => {
      const logger = makeLogger(options);
      const loaded = await loadFromOptions(options);

      const search = await findToolchain({
        configured: loaded.config.signing.toolchain,
        configDir: loaded.configDir,
      });
      if (!search.info) {
        throw new HssError("未找到 hap-sign-tool.jar，无法验签", {
          hint: "设置 signing.toolchain 或 HSS_TOOLCHAIN",
          code: "TOOLCHAIN_MISSING",
        });
      }
      const toolchain = search.info;

      let target: string;
      if (packageArg) {
        target = resolve(process.cwd(), packageArg);
      } else {
        const found = await findNewestHap(loaded.env.outputDir);
        if (!found) {
          throw new HssError("没有指定包，且在输出目录中没有找到 .hap", {
            hint: `用法：hss verify <path/to/app.hap>，或先执行 hss sign`,
            code: "VERIFY_NO_PACKAGE",
          });
        }
        target = found;
      }

      if (!(await fileExists(target))) {
        throw new HssError(`包不存在：${target}`, { code: "VERIFY_NO_PACKAGE" });
      }

      const outDir = join(loaded.env.outputDir, "verify");
      const certChainPath = join(outDir, "certchain.pem");
      const profilePath = join(outDir, "profile.json");
      const java = resolveJavaCommand(loaded.config.signing.javaPath);

      const result = await execa(
        java,
        ["-jar", toolchain.jarPath, "verify-app", "-inFile", target, "-outCertchain", certChainPath, "-outProfile", profilePath],
        { reject: false, timeout: 120_000, windowsHide: true },
      );

      const results: CheckResult[] = [];
      const stderr = `${result.stdout}\n${result.stderr}`.trim();
      const detail = summarizeToolError(stderr);

      if (result.exitCode === 0) {
        results.push(ok("verify.official", "官方验签 (verify-app)", "签名与证书链校验通过"));
      } else if (isUntrustedChainError(stderr)) {
        results.push(
          warn(
            "verify.official",
            "官方验签 (verify-app)",
            "证书链不被工具信任（自建 / 非华为 CA 的预期结果，签名本身有效）",
            "正式上架请使用 AGC 签发的证书链；如需跳过该校验，可设置 signing.<env>.verify: false",
          ),
        );
      } else {
        results.push(
          fail("verify.official", "官方验签 (verify-app)", detail, "包可能被篡改、证书链不完整或 profile 不匹配"),
        );
      }

      const hapInfo = (() => {
        try {
          return readHapInfo(target);
        } catch {
          return undefined;
        }
      })();

      if ((await fileExists(certChainPath))) {
        try {
          const chain = parsePemChain(await readTextFile(certChainPath));
          const validation = validateChainOrder(chain);
          results.push(
            validation.ok
              ? ok("verify.chain", "包内证书链", `${chain.length} 张 · ${chain[0] ? summarizeCertificate(chain[0]) : ""}`)
              : fail("verify.chain", "包内证书链", validation.problems.map((p) => p.message).join("；")),
          );
        } catch (error) {
          results.push(fail("verify.chain", "包内证书链", error instanceof Error ? error.message : String(error)));
        }
      }

      if (await fileExists(profilePath)) {
        try {
          const profile = parseProfileJson(await readTextFile(profilePath));
          if (hapInfo?.bundleName && profile.bundleName && hapInfo.bundleName !== profile.bundleName) {
            results.push(
              fail(
                "verify.bundle-name",
                "包内 bundleName 一致性",
                `HAP=${hapInfo.bundleName}，profile=${profile.bundleName}`,
              ),
            );
          } else if (profile.bundleName) {
            results.push(ok("verify.bundle-name", "包内 bundleName 一致性", profile.bundleName));
          }

          if (profile.type) {
            results.push(
              profile.type === "release"
                ? ok("verify.profile-type", "包内 profile 类型", "release")
                : warn("verify.profile-type", "包内 profile 类型", `${profile.type}（上架需 release）`),
            );
          }
        } catch (error) {
          results.push(warn("verify.bundle-name", "包内 profile", error instanceof Error ? error.message : String(error)));
        }
      }

      const meta = {
        command: "verify",
        configPath: loaded.configPath,
        envName: loaded.envName,
        projectName: loaded.config.project.name,
      };

      if (options.json) {
        printJson({ ...toJsonPayload(results, meta), package: target, hssVersion: VERSION });
      } else {
        printReport(logger, results, meta);
        logger.raw("");
        logger.dim(`package  ${target}`);
        if (await fileExists(certChainPath)) logger.dim(`chain    ${certChainPath}`);
        if (await fileExists(profilePath)) logger.dim(`profile  ${profilePath}`);
      }

      if (results.some((r) => r.status === "fail")) process.exitCode = 1;
    });
}

/** Pick the useful line out of hap-sign-tool's noisy output. */
function summarizeToolError(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const message =
    lines.find((line) => /^Error Message:/i.test(line)) ??
    lines.find((line) => /^ERROR:/i.test(line)) ??
    lines[lines.length - 1] ??
    "verify-app 失败";
  return message.replace(/^Error Message:\s*/i, "").replace(/^ERROR:\s*/i, "");
}
