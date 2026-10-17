# hss — HarmonyOS 签名与上架自动化工具链

一条命令，把「未签名 HAP → AGC 可上传的签名包」跑完，并在上传前把会让 AGC 打回的问题本地查出来。

```
hss init      生成配置 + .gitignore + CI 模板
hss doctor    体检：Java、工具链、证书链、bundleName、profile 一致性
hss check     只跑校验，不签名（CI 预检）
hss sign      签 profile → 签 HAP → 官方验签 → 写 manifest/report
hss verify    对已有包验签，并核对包内 profile
```

> 定位：**不重新实现签名算法**。真正的密码学由官方 `hap-sign-tool.jar` 完成，hss 负责编排、校验、诊断与可复现性。

---

## 为什么需要它

签名链路本身不复杂，但坑极多，而且官方报错完全不说人话：

| 报错 | 真实原因 | hss 的处理 |
| --- | --- | --- |
| `Illegal base64 character 20 / 2b` | profile 里 `distribution-certificate` 用了 PEM 或标准 base64，工具只认 **base64url** | 预检标记 + 自动生成 base64url 副本再签名 |
| `code 107 Wrong key usage` / `code 108 unable to find valid certification path` | 证书链顺序错（必须是 叶子 → 中间 CA → 根 CA） | 预检逐张校验签发关系与签名 |
| `code 105 SignAlg params is incorrect` | ECC 证书配了 RSA 算法 | 预检比对密钥类型与 signAlg |
| `Param is not trusted`（verify-app） | 自建 CA 链无法通过工具的信任库（签名本身有效） | 降级为警告，不阻断出包 |
| AGC `993` / 包解析失败 | profile 内嵌证书与应用证书不是同一把密钥、bundleName 不一致 | 预检比对公钥指纹与三方 bundleName |
| 签名密码静默失效 | PowerShell 里 `$pwd` 是自动变量 | 文档 + 日志中口令一律脱敏 |

以上编码与信任两个坑，是**用真实 `hap-sign-tool.jar` 端到端跑出来的**，不是从文档抄的。

---

## 快速开始

```bash
# Node >= 18.18，Java >= 8
npm i -g harmony-sign-suite     # 或本地：pnpm build && node dist/index.js

hss init                        # 生成 hss.config.yaml / .gitignore / CI
# 把 p12、证书、profile 放进 signing/（已被 .gitignore 忽略）

# 口令只放环境变量
export HSS_KEYSTORE_PWD=***   HSS_KEY_PWD=***

hss doctor                      # 先体检
hss sign --dry-run              # 只打印将要执行的命令（口令已脱敏）
hss sign                        # 真正签名
```

产物：

```
dist/
  entry-default.p7b                 已签名的 profile
  entry-default-signed.hap          待上传 AGC 的包
  entry-default-certchain.pem       验签导出的证书链
  entry-default-profile.json        包内 profile（明文，便于核对）
  hss-profile.normalized.json       base64url 规范化后的 profile 副本
  hss-sign-manifest.json            输入/输出 sha256、命令、耗时、检查结果
  hss-report.md                     可读报告（可直接贴 CI artifact）
```

---

## 配置

```yaml
version: 1
project:
  bundleName: com.demo.app
  hapPath: build/default/outputs/default/entry-default-signed.hap

signing:
  # toolchain: /path/to/hap-sign-tool.jar   # 留空自动探测 DevEco / SDK
  defaultEnv: release
  environments:
    release:
      keystore: signing/release.p12
      keyAlias: oh-app1-key-v1
      # profileKeyAlias: oh-profile-key-v1  # profile 密钥可与应用密钥不同
      keystorePwd: { env: HSS_KEYSTORE_PWD } # 口令只写引用
      keyPwd: { env: HSS_KEY_PWD }
      signAlg: SHA256withECDSA
      appCert: signing/app-release.pem
      profileCert: signing/profile-release.pem
      profileJson: signing/profile-release.json   # 或 profileP7b
      outputDir: dist
      verify: true                                 # 是否执行 verify-app

checks:
  ignore: []            # 例：["cert.expiry"]
```

工具链探测顺序：`signing.toolchain` → `HSS_TOOLCHAIN` / `OHOS_SDK_HOME` / `DEVECO_HOME` 等环境变量 → DevEco Studio 常见安装路径（有界递归查找 `hap-sign-tool.jar`）。

---

## 校验项

| id | 检查 |
| --- | --- |
| `env.java` / `env.toolchain` | Java ≥ 8、hap-sign-tool 可用 |
| `files.*` | 密钥库、证书、profile、HAP 是否存在 |
| `cert.app-chain-order` / `cert.profile-chain-order` | 证书链顺序与签发关系（`checkIssued` + `verify`） |
| `cert.expiry` | 证书有效期，< 30 天给警告 |
| `cert.key-alg-match` | ECC ↔ ECDSA / RSA ↔ RSA |
| `hap.structure` / `hap.bundle-name` | HAP 结构、HAP 与配置的包名一致 |
| `profile.type` | release 环境不得使用 debug profile |
| `profile.bundle-name` | profile 与应用的 bundleName 一致 |
| `profile.validity` | profile 生效区间 |
| `profile.cert-match` | profile 内嵌证书与应用证书**公钥指纹**一致（993 类问题根因） |
| `profile.cert-encoding` | 内嵌证书是否为 base64url（工具要求） |
| `output.writable` / `repo.gitignore` | 输出目录可写、密钥物料已忽略 |

`hss check --json` 输出机器可读结果，`--report` 写出 Markdown。

---

## CI

`hss init` 会生成 `.github/workflows/hss-sign.yml`：证书以 base64 存进 Secrets，运行时落盘到 `signing/`，口令通过环境变量注入，产物与报告上传 artifact。

---

## 安全设计

- 口令支持 `{ env: NAME }` / `{ file: path }` 引用，只有显式写字符串才会内联（并在候选中提示）。
- 所有日志、manifest、report 中的口令统一脱敏；`sign-manifest.json` 不含明文。
- 默认拒绝把 `signing/`、`*.p12`、`*.p7b` 提交进仓库（检查 id `repo.gitignore`）。
- 用户源文件不会被改写：编码规范化只写 `dist/hss-profile.normalized.json`。

---

## 项目结构

```
src/
  index.ts                 CLI 入口
  cli/commands/            init / doctor / check / sign / verify
  config/                  zod schema + YAML 加载 + 口令解析
  core/
    toolchain.ts           Java 与 hap-sign-tool 探测
    certs.ts               PEM 链解析、签发关系校验、公钥指纹
    hap.ts                 HAP(zip) 结构、bundlename、json5 宽容解析
    profile.ts             HarmonyAppProvision 解析、p7b 提取、base64url 规范化
    checks.ts              规则引擎（22 条检查）
    signing.ts             命令编排、脱敏、manifest
    report.ts              终端 / Markdown / JSON 报告
test/                      37 个单测（含用 @peculiar/x509 现造证书链）
scripts/demo.ts            生成可演练的示例工程
```

## 开发

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm demo            # 生成 examples/demo
```

## 已验证 / 未验证

已验证（本机真实跑通）：

- 自动探测 `E:\huawei\DevEco Studio\sdk\...\hap-sign-tool.jar` 并读取 Java 版本
- 用工具自建 CA 链 → `sign-profile` → `sign-app` 出真实签名包
- 自动把 PEM 证书转 base64url，修复 `Illegal base64 character`
- `verify-app` 对自建链的 `not trusted` 识别为警告
- 命令参数与官方 `-help` 逐项核对

尚未覆盖：

- AGC 服务端 993 的真实复现（需要 AGC 账号与真实证书）
- DevEco Studio 插件形态
- macOS / Linux 实机验证（代码按平台分支编写，未实测）

## 路线图

- [ ] `hss fix`：批量修复 profile 编码 / 证书链顺序并给出 diff
- [ ] `hss keygen`：一条命令自建 OpenHarmony 本地调试签名环境（当前需 9 条手工命令）
- [ ] DevEco Studio 插件（右键 `hss sign`）
- [ ] 可重复构建校验：同一 commit 两次签名产物哈希对比

## License

MIT
