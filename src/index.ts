#!/usr/bin/env node
import { Command } from "commander";
import { TOOL_NAME, VERSION } from "./version.js";
import { HssError } from "./core/errors.js";
import { registerInit } from "./cli/commands/init.js";
import { registerKeygen } from "./cli/commands/keygen.js";
import { registerDoctor } from "./cli/commands/doctor.js";
import { registerCheck } from "./cli/commands/check.js";
import { registerSign } from "./cli/commands/sign.js";
import { registerVerify } from "./cli/commands/verify.js";

const program = new Command();

program
  .name(TOOL_NAME)
  .version(VERSION, "-v, --version", "显示版本号")
  .description(
    [
      "HarmonyOS 签名与上架自动化工具链",
      "",
      "  hss init                    生成配置、.gitignore 与 CI 模板",
      "  hss keygen                  一键生成本地签名环境（自建 CA 链）",
      "  hss doctor                  体检：环境、证书链、bundleName、profile",
      "  hss check                   只跑校验，不签名（CI 预检）",
      "  hss sign --env release      签名 profile + HAP，并官方验签",
      "  hss verify <package>        验签并核对包内 profile",
    ].join("\n"),
  )
  .showHelpAfterError("（使用 hss --help 查看完整用法）");

registerInit(program);
registerKeygen(program);
registerDoctor(program);
registerCheck(program);
registerSign(program);
registerVerify(program);

program.parseAsync(process.argv).catch((error: unknown) => {
  if (error instanceof HssError) {
    process.stderr.write(`\n✗ ${error.message}\n`);
    if (error.hint) {
      for (const line of error.hint.split("\n")) process.stderr.write(`  ↳ ${line}\n`);
    }
    if (error.code) process.stderr.write(`  code: ${error.code}\n`);
  } else if (error instanceof Error) {
    process.stderr.write(`\n✗ ${error.message}\n`);
    if (process.env.HSS_DEBUG) process.stderr.write(`${error.stack ?? ""}\n`);
  } else {
    process.stderr.write(`\n✗ ${String(error)}\n`);
  }
  process.exitCode = 1;
});
