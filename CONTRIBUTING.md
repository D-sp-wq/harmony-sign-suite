# Contributing

感谢你愿意参与。这个项目的目标是：**把鸿蒙签名里"报错不说人话"的环节，变成可检查、可修复、可复现的工程流程。**

## 开发环境

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

- Node >= 18.18，pnpm 11
- 需要真实签名链路时，安装 DevEco Studio（提供 `hap-sign-tool.jar`）
- 没有证书也能开发：`pnpm demo` 会生成一个可演练的工程

## 目录结构

```
src/cli/commands/   init / keygen / doctor / check / fix / sign / verify
src/config/         zod schema、YAML 加载、口令引用解析
src/core/
  toolchain.ts      Java 与 hap-sign-tool 探测
  certs.ts          PEM 链解析、签发关系校验、公钥指纹
  hap.ts            HAP(zip) 结构、bundleName、json5 宽容解析
  profile.ts        profile 解析、p7b 提取、base64url 规范化
  checks.ts         规则引擎
  fix.ts            链重排 + 编码修复（带备份）
  keygen.ts         六步建链
  signing.ts        命令编排、脱敏、manifest
test/               单测（用 @peculiar/x509 现造证书链）
```

## 提交规范

使用 [Conventional Commits](https://www.conventionalcommits.org/)：

```
feat(sign): 支持 --timeout
fix(checks): p7b 的编码检查降级为提示
docs: 补充 AGC 反序链说明
```

## 新增一个检查项

1. 在 `src/core/checks.ts` 的 `CHECK_IDS` 里加 id；
2. 实现检查逻辑，返回 `ok/warn/fail/skip`，**必须带可执行的 hint**；
3. 在 `test/checks.test.ts` 里补正反用例（一个通过、一个失败）；
4. 如果是可自动修复的，在 `src/core/fix.ts` 里加对应的 `plan*Repair`，并保证幂等；
5. 更新 README 的检查项表格。

## 隐私与安全

- **绝不**提交 `signing/`、`*.p12`、`*.p7b`、`*.pem`、口令文件；
- 日志、manifest、报告里的口令必须脱敏（参考 `src/utils/redact.ts`）；
- 发现安全问题请走 [SECURITY.md](SECURITY.md)，不要开公开 issue。
