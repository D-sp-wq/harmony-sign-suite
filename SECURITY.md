# Security Policy

## 支持范围

只维护最新的 npm 版本（当前 `0.3.x`）。

## 报告漏洞

请**不要**公开开 issue。使用 GitHub 的 [Private vulnerability reporting](../../security/advisories/new)，或联系仓库维护者。请包含：

- 影响版本
- 复现步骤（不要附真实私钥/口令）
- 可能的影响范围

## 与签名物料有关的注意事项

这个工具会读写密钥库、证书和 profile，因此：

- **不要**在 issue / PR / 日志里粘贴 `.p12`、`.p7b`、私钥或口令；
- `hss` 对日志、manifest、报告中的口令做了脱敏，但**命令行参数本身**（`-keyPwd`）仍会被同机进程看到——这是 `hap-sign-tool` 的参数限制，建议在 CI 中通过 secrets 注入并限制机器权限；
- 生成的本地签名环境默认写入 `.gitignore`，请勿强行提交。

## 已知取舍

| 项 | 说明 |
| --- | --- |
| 口令出现在 argv | `hap-sign-tool` 只接受命令行口令；hss 只保证不落日志/文件 |
| 自建 CA 链 | 仅用于本地/OpenHarmony 调试，AGC 上架必须用 AGC 签发证书 |
| 依赖外部 jar | 不自行实现密码学，签名正确性以官方工具为准 |
