# 发布清单（npm）

发布前逐项打勾。命令以 `pnpm` 为例，`npm` 同样可用。

## 0. 建 GitHub 仓库

```bash
winget install GitHub.cli      # 安装 gh
gh auth login                  # 浏览器登录
pwsh scripts/bootstrap-github.ps1 -Owner <你的 GitHub 用户名>
```

脚本会：替换 README / issue 模板里的 `OWNER` 占位 → 必要时修正 git 身份 → 创建仓库并推送 `main`。

> 没有 `gh` 时脚本会打印手动步骤（网页建仓 → `git remote add` → `git push`）。

## 1. 版本与元数据

- [ ] `package.json` 的 `version` 与 `CHANGELOG.md` 一致
- [ ] `src/version.ts` 的 `VERSION` 与 `package.json` 一致（CLI `--version` 用它）
- [ ] `description` / `keywords` / `license` / `author` 已填写
- [ ] （建议）补上 `repository`、`homepage`、`bugs`，指向真实仓库

## 2. 包名

- [ ] 确认名称未被占用：

  ```bash
  curl -s -o /dev/null -w "%{http_code}\n" https://registry.npmjs.org/harmony-sign-suite
  # 404 = 可用
  ```

- [ ] 若被占用，备选：`hss-cli`、`hss-sign`、`harmony-sign`（均已确认可用，2026-10）

## 3. 构建与测试

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

- [ ] 类型检查 0 错误
- [ ] 全部测试通过（当前 62 项）
- [ ] `dist/index.js` 首行为 `#!/usr/bin/env node`

## 4. 打包检查

```bash
pnpm pack --pack-destination .pack
tar -tf .pack/harmony-sign-suite-<version>.tgz
tar -tvf .pack/harmony-sign-suite-<version>.tgz | grep dist/index.js   # 需要 -rwxr-xr-x
```

- [ ] 只包含 `dist/`、`templates/`、`README.md`、`LICENSE`、`package.json`
- [ ] **不包含** `src/`、`test/`、`docs/`、`.git/`、`node_modules/`、任何 `*.p12` / `*.pem` / `*.p7b`
- [ ] `dist/index.js` 在 tar 中带可执行位

## 5. 安装冒烟测试

```bash
mkdir /tmp/packtest && cd /tmp/packtest
echo '{"name":"packtest","private":true,"type":"module"}' > package.json
pnpm add /path/to/harmony-sign-suite-<version>.tgz

./node_modules/.bin/hss --version      # 应输出 package.json 的 version
./node_modules/.bin/hss --help
mkdir demo && cd demo
../node_modules/.bin/hss init          # 应生成配置、.gitignore、workflow
../node_modules/.bin/hss doctor        # 无口令时应提示 SECRET_ENV_MISSING（预期）
```

- [ ] `--version` 正确
- [ ] `init` 能读到包内 `templates/`（路径解析正确）
- [ ] `doctor` 在缺口令时报可读错误，而不是崩溃

## 6. 发布

> **npm 2026 新政策（实测踩过）**
>
> - 发布**必须开启 2FA**（或使用 bypass-2FA token，且后者 2027-01 起不能再直接发布）。
> - **TOTP 已不能新开**：`npm profile enable-2fa` 会返回 `404 Adding a new TOTP 2FA is no longer supported`，只能在网页用**安全密钥 / 通行密钥**（Windows Hello、Touch ID、YubiKey）。
> - 新包首次发布推荐 `npm stage publish`：先入 staging 队列，再在浏览器用 2FA 批准（`npm stage approve <id>` 会打开认证页）。
> - 后续版本改用 **Trusted Publishing（OIDC）**，CI 不再需要任何 token。

### 首次发布（新包）

```bash
npm stage publish --access public      # 入队，输出 stage id
npm stage list                          # 等到 status: staged
npm stage approve <stage-id>            # 浏览器完成安全密钥验证
```

### 后续版本

1. 在 npm 包页面 → **Settings → Trusted publishing** 添加：
   - Repository owner：`<你的账号>`
   - Repository：`harmony-sign-suite`
   - Workflow：`release.yml`
2. 本地发布（交互式 2FA）：

   ```bash
   npm publish --access public          # 浏览器完成安全密钥验证
   ```

3. 或交给 CI：

   ```bash
   git tag v<version> && git push origin v<version>
   ```

   若该版本已存在，`release.yml` 会检测到并跳过发布，不会红。

- [ ] 发布后验证：

  ```bash
  npx --yes harmony-sign-suite@<version> --version
  ```

- [ ] 在 GitHub 打 tag：`git tag v0.3.0 && git push origin v0.3.0`

## 7. 发布后

- [ ] 更新 README 的安装命令为正式版本
- [ ] 在鸿蒙社区 / 掘金 发布配套文章（`docs/article-agc-signing-pitfalls.md`）
- [ ] 收集前 10 个 issue，决定 0.3.x 的修复优先级
