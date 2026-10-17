import { fileExists, canWriteTo, readTextFile, resolvePath } from "../utils/fsx.js";
import { HssError } from "./errors.js";
import type { LoadedConfig } from "../config/schema.js";
import type { ToolchainInfo } from "./toolchain.js";
import { detectJava } from "./toolchain.js";
import { fail, ok, skip, warn, type CheckResult } from "./result.js";
import {
  describeCertificate,
  daysUntil,
  formatDate,
  keyTypeMatchesSignAlg,
  parsePemChain,
  pemFromBase64Certificate,
  shortDn,
  summarizeCertificate,
  validateChainOrder,
  type ParsedCertificate,
} from "./certs.js";
import { readHapInfo } from "./hap.js";
import { loadProfile, toBase64Url } from "./profile.js";

export interface CheckOptions {
  loaded: LoadedConfig;
  toolchain?: ToolchainInfo;
  toolchainAttempts?: string[];
  /** Skips filesystem checks that need the toolchain, for pure `hss check` runs. */
  skipToolchainCheck?: boolean;
}

export const CHECK_IDS = {
  configLoaded: "config.loaded",
  envJava: "env.java",
  envToolchain: "env.toolchain",
  fileKeystore: "files.keystore",
  fileAppCert: "files.app-cert",
  fileProfileCert: "files.profile-cert",
  fileProfileSource: "files.profile-source",
  fileHap: "files.hap",
  certAppChainOrder: "cert.app-chain-order",
  certProfileChainOrder: "cert.profile-chain-order",
  certExpiry: "cert.expiry",
  certKeyAlg: "cert.key-alg-match",
  certLeafCa: "cert.leaf-is-ca",
  hapStructure: "hap.structure",
  hapBundleName: "hap.bundle-name",
  profileType: "profile.type",
  profileBundleName: "profile.bundle-name",
  profileValidity: "profile.validity",
  profileCertMatch: "profile.cert-match",
  profileCertEncoding: "profile.cert-encoding",
  outputWritable: "output.writable",
  repoGitignore: "repo.gitignore",
} as const;

async function readChain(path: string): Promise<ParsedCertificate[]> {
  const text = await readTextFile(path);
  return parsePemChain(text);
}

function parseProfileCertificate(base64: string): ParsedCertificate | null {
  try {
    if (base64.includes("BEGIN CERTIFICATE")) {
      const chain = parsePemChain(base64);
      return chain[0] ?? null;
    }
    return describeCertificate(pemFromBase64Certificate(base64));
  } catch {
    return null;
  }
}

export async function runChecks(options: CheckOptions): Promise<CheckResult[]> {
  const { loaded, toolchain } = options;
  const { config, env, envName } = loaded;
  const results: CheckResult[] = [];
  const ignore = new Set(config.checks.ignore);

  const push = (result: CheckResult): void => {
    if (ignore.has(result.id)) return;
    results.push(result);
  };

  // ---------------------------------------------------------------- config
  push(
    ok(CHECK_IDS.configLoaded, "配置文件", `${loaded.configPath} · env=${envName}`, {
      configPath: loaded.configPath,
      envName,
    }),
  );

  // ------------------------------------------------------------ toolchain
  if (toolchain) {
    push(
      ok(
        CHECK_IDS.envToolchain,
        "签名工具链",
        `${shortPath(toolchain.jarPath)} · java ${toolchain.java.version}`,
        { jarPath: toolchain.jarPath, javaVersion: toolchain.java.version },
      ),
    );
    if (toolchain.java.major < 8) {
      push(
        fail(
          CHECK_IDS.envJava,
          "Java 版本",
          `java ${toolchain.java.version} 过低`,
          "hap-sign-tool 需要 Java 8 及以上，请安装 JRE/JDK 8+ 并设置 JAVA_HOME",
        ),
      );
    } else {
      push(ok(CHECK_IDS.envJava, "Java 版本", `java ${toolchain.java.version}`));
    }
  } else if (options.skipToolchainCheck) {
    push(skip(CHECK_IDS.envToolchain, "签名工具链", "未检测（check 模式）"));
  } else {
    const java = await detectJava();
    if (java) {
      push(warn(CHECK_IDS.envJava, "Java 版本", `java ${java.version}`, "系统有 Java，但未找到 hap-sign-tool.jar"));
    } else {
      push(fail(CHECK_IDS.envJava, "Java 版本", "未找到 java", "安装 JDK/JRE 8+ 并把 java 加入 PATH"));
    }
    const tried = options.toolchainAttempts?.slice(0, 6) ?? [];
    push(
      fail(
        CHECK_IDS.envToolchain,
        "签名工具链",
        "未找到 hap-sign-tool.jar",
        [
          "在配置中显式指定 signing.toolchain，或设置环境变量 HSS_TOOLCHAIN 指向 jar 所在目录",
          ...(tried.length > 0 ? [`已尝试：${tried.join(" | ")}`] : []),
        ].join("\n"),
      ),
    );
  }

  // ---------------------------------------------------------------- files
  const keystoreOk = await fileExists(env.keystore);
  push(
    keystoreOk
      ? ok(CHECK_IDS.fileKeystore, "密钥库", shortPath(env.keystore))
      : fail(CHECK_IDS.fileKeystore, "密钥库", `不存在：${env.keystore}`, "检查 signing.keystore 路径"),
  );

  const appCertOk = await fileExists(env.appCert);
  push(
    appCertOk
      ? ok(CHECK_IDS.fileAppCert, "应用签名证书", shortPath(env.appCert))
      : fail(CHECK_IDS.fileAppCert, "应用签名证书", `不存在：${env.appCert}`, "检查 signing.appCert 路径"),
  );

  const profileCertOk = await fileExists(env.profileCert);
  push(
    profileCertOk
      ? ok(CHECK_IDS.fileProfileCert, "Profile 签名证书", shortPath(env.profileCert))
      : fail(CHECK_IDS.fileProfileCert, "Profile 签名证书", `不存在：${env.profileCert}`, "检查 signing.profileCert 路径"),
  );

  const profileSource = env.profileP7b ?? env.profileJson;
  let profileOk = false;
  if (!profileSource) {
    push(fail(CHECK_IDS.fileProfileSource, "Profile 文件", "未配置 profileJson 或 profileP7b", "二选一提供"));
  } else {
    profileOk = await fileExists(profileSource);
    push(
      profileOk
        ? ok(CHECK_IDS.fileProfileSource, "Profile 文件", shortPath(profileSource))
        : fail(CHECK_IDS.fileProfileSource, "Profile 文件", `不存在：${profileSource}`),
    );
  }

  const hapOk = env.hapPath ? await fileExists(env.hapPath) : false;
  push(
    env.hapPath
      ? hapOk
        ? ok(CHECK_IDS.fileHap, "HAP 包", shortPath(env.hapPath))
        : fail(CHECK_IDS.fileHap, "HAP 包", `不存在：${env.hapPath}`, "先执行构建，或修正 project.hapPath")
      : fail(CHECK_IDS.fileHap, "HAP 包", "未配置 hapPath", "在 project 或 signing 环境中提供 hapPath"),
  );

  // -------------------------------------------------------------- certs
  let appLeaf: ParsedCertificate | undefined;
  if (appCertOk) {
    try {
      const chain = await readChain(env.appCert);
      appLeaf = chain[0];
      const validation = validateChainOrder(chain);
      if (chain.length === 0) {
        push(fail(CHECK_IDS.certAppChainOrder, "应用证书链", "文件中没有证书", "提供 PEM 证书链：叶子证书 → 中间 CA → 根 CA"));
      } else if (validation.ok) {
        push(ok(CHECK_IDS.certAppChainOrder, "应用证书链", `${chain.length} 张证书，顺序正确`));
      } else {
        push(
          fail(
            CHECK_IDS.certAppChainOrder,
            "应用证书链",
            validation.problems.map((p) => p.message).join("；"),
            "证书链顺序必须是 最终实体证书 → 中间 CA → 根 CA；顺序错误会触发 105/107/108",
          ),
        );
      }

      if (appLeaf && appLeaf.isCa) {
        push(warn(CHECK_IDS.certLeafCa, "叶子证书 CA 标记", "叶子证书带 CA 标记，通常应为 false"));
      }

      if (appLeaf) {
        const expired = chain.filter((c) => c.validTo.getTime() < Date.now());
        const soon = chain.filter((c) => !expired.includes(c) && daysUntil(c.validTo) < 30);
        if (expired.length > 0) {
          push(
            fail(
              CHECK_IDS.certExpiry,
              "证书有效期",
              `已过期：${expired.map((c) => `${shortDn(c.subject)}@${formatDate(c.validTo)}`).join("，")}`,
              "在 AGC 重新申请证书并替换 signing.appCert / profileCert",
            ),
          );
        } else if (soon.length > 0) {
          push(warn(CHECK_IDS.certExpiry, "证书有效期", `即将过期：${soon.map((c) => formatDate(c.validTo)).join("，")}`, "建议提前 30 天更换证书"));
        } else {
          push(ok(CHECK_IDS.certExpiry, "证书有效期", `叶子证书至 ${formatDate(appLeaf.validTo)}`));
        }

        if (!keyTypeMatchesSignAlg(appLeaf.keyType, env.signAlg)) {
          push(
            fail(
              CHECK_IDS.certKeyAlg,
              "密钥类型与算法",
              `证书密钥 ${appLeaf.keyType}，但 signAlg=${env.signAlg}`,
              "ECC 证书配 SHA256withECDSA/SHA384withECDSA；RSA 证书配 SHA256withRSA/SHA384withRSA",
            ),
          );
        } else {
          push(ok(CHECK_IDS.certKeyAlg, "密钥类型与算法", `${appLeaf.keyType} ↔ ${env.signAlg}`));
        }
      }
    } catch (error) {
      push(fail(CHECK_IDS.certAppChainOrder, "应用证书链", errorMessage(error), "确认文件是 PEM 格式的证书链"));
    }
  }

  if (profileCertOk) {
    try {
      const chain = await readChain(env.profileCert);
      const validation = validateChainOrder(chain);
      if (chain.length === 0) {
        push(fail(CHECK_IDS.certProfileChainOrder, "Profile 证书链", "文件中没有证书"));
      } else if (validation.ok) {
        push(ok(CHECK_IDS.certProfileChainOrder, "Profile 证书链", `${chain.length} 张证书，顺序正确`));
      } else {
        push(
          fail(
            CHECK_IDS.certProfileChainOrder,
            "Profile 证书链",
            validation.problems.map((p) => p.message).join("；"),
            "profile 签名证书链同样必须 叶子 → 中间 CA → 根 CA",
          ),
        );
      }
    } catch (error) {
      push(fail(CHECK_IDS.certProfileChainOrder, "Profile 证书链", errorMessage(error)));
    }
  }

  // ---------------------------------------------------------------- HAP
  let hapBundleName: string | undefined;
  if (env.hapPath && hapOk) {
    try {
      const info = readHapInfo(env.hapPath);
      hapBundleName = info.bundleName;
      if (!info.isZip) {
        push(fail(CHECK_IDS.hapStructure, "HAP 包结构", "不是有效的 zip/hap 文件", "确认路径指向构建产物 .hap，而不是目录"));
      } else if (!info.hasModuleJson) {
        push(fail(CHECK_IDS.hapStructure, "HAP 包结构", "缺少 module.json", "这不是编译后的 HAP"));
      } else {
        push(
          ok(
            CHECK_IDS.hapStructure,
            "HAP 包结构",
            `${info.entryNames.length} 个条目` + (info.hasPackInfo ? " · pack.info ✓" : ""),
          ),
        );
      }

      const declared = config.project.bundleName;
      if (hapBundleName && declared && hapBundleName !== declared) {
        push(
          fail(
            CHECK_IDS.hapBundleName,
            "bundleName（HAP vs 配置）",
            `HAP=${hapBundleName}，配置=${declared}`,
            "签名与 AGC 都要求包名一致；修改配置或重新构建",
          ),
        );
      } else if (hapBundleName) {
        push(ok(CHECK_IDS.hapBundleName, "bundleName（HAP vs 配置）", hapBundleName));
      } else {
        push(warn(CHECK_IDS.hapBundleName, "bundleName（HAP vs 配置）", "未能从 HAP 中读取 bundleName"));
      }
    } catch (error) {
      push(fail(CHECK_IDS.hapStructure, "HAP 包结构", errorMessage(error)));
    }
  }

  // ------------------------------------------------------------ profile
  let profileInfo: Awaited<ReturnType<typeof loadProfile>> | undefined;
  if (profileSource && profileOk) {
    try {
      profileInfo = await loadProfile(profileSource);
      const info = profileInfo.info;

      if (!info.type) {
        push(warn(CHECK_IDS.profileType, "Profile 类型", "未声明 type"));
      } else if (envName.toLowerCase().includes("debug")) {
        push(
          info.type === "debug"
            ? ok(CHECK_IDS.profileType, "Profile 类型", "debug（与调试环境匹配）")
            : fail(CHECK_IDS.profileType, "Profile 类型", `期望 debug，实际 ${info.type}`),
        );
      } else if (info.type !== "release") {
        push(
          fail(
            CHECK_IDS.profileType,
            "Profile 类型",
            `release 环境使用了 ${info.type} profile`,
            "上架 AGC 必须使用 release 类型的 profile；debug profile 只能用于真机调试",
          ),
        );
      } else {
        push(ok(CHECK_IDS.profileType, "Profile 类型", "release"));
      }

      const hapName = hapBundleName ?? config.project.bundleName;
      if (info.bundleName && hapName && info.bundleName !== hapName) {
        push(
          fail(
            CHECK_IDS.profileBundleName,
            "bundleName（Profile vs 应用）",
            `Profile=${info.bundleName}，应用=${hapName}`,
            "系统安装时会校验 HAP 的 bundleName 与 profile 的 bundle-name 是否一致",
          ),
        );
      } else if (info.bundleName) {
        push(ok(CHECK_IDS.profileBundleName, "bundleName（Profile vs 应用）", info.bundleName));
      } else {
        push(warn(CHECK_IDS.profileBundleName, "bundleName（Profile vs 应用）", "profile 缺少 bundle-info.bundle-name"));
      }

      if (info.notAfter) {
        const days = daysUntil(info.notAfter);
        if (info.notBefore && info.notBefore.getTime() > Date.now()) {
          push(fail(CHECK_IDS.profileValidity, "Profile 有效期", `尚未生效：${formatDate(info.notBefore)}`));
        } else if (days < 0) {
          push(
            fail(
              CHECK_IDS.profileValidity,
              "Profile 有效期",
              `已于 ${formatDate(info.notAfter)} 过期`,
              "在 AGC 重新生成 profile 并更新 profileJson",
            ),
          );
        } else if (days < 30) {
          push(warn(CHECK_IDS.profileValidity, "Profile 有效期", `剩 ${days} 天`, "建议提前更新 profile"));
        } else {
          push(ok(CHECK_IDS.profileValidity, "Profile 有效期", `至 ${formatDate(info.notAfter)}`));
        }
      } else {
        push(skip(CHECK_IDS.profileValidity, "Profile 有效期", "未提供 validity"));
      }

      // The certificate that AGC compares against the uploaded package.
      const embedded = info.distributionCertificate ?? info.developmentCertificate;
      if (!embedded) {
        push(skip(CHECK_IDS.profileCertMatch, "证书一致性", "profile 未内嵌证书"));
      } else if (!appLeaf) {
        push(skip(CHECK_IDS.profileCertMatch, "证书一致性", "应用证书不可用，无法比对"));
      } else {
        const encoding = toBase64Url(embedded).encoding;
        if (profileInfo.source === "p7b") {
          // A signed profile cannot be rewritten, and AGC-issued p7b files are
          // accepted by hap-sign-tool even with a PEM payload — so this is
          // informational only, not a problem to fix.
          push(
            skip(
              CHECK_IDS.profileCertEncoding,
              "Profile 证书编码",
              `已签名 profile 内嵌证书为 ${encoding}（不可改写；若 sign-app 报 Illegal base64 请向 AGC 重新下载）`,
            ),
          );
        } else {
          push(
            encoding === "base64url"
              ? ok(CHECK_IDS.profileCertEncoding, "Profile 证书编码", "base64url")
              : warn(
                  CHECK_IDS.profileCertEncoding,
                  "Profile 证书编码",
                  `当前为 ${encoding}；自签 profile 会把它原样写入 p7b，sign-app 随后报 Illegal base64 character`,
                  "hss sign 会自动生成 base64url 副本用于签名；手动调用 hap-sign-tool 时需自行转换",
                ),
          );
        }

        const embeddedCert = parseProfileCertificate(embedded);
        if (!embeddedCert) {
          push(warn(CHECK_IDS.profileCertMatch, "证书一致性", "profile 内嵌证书无法解析"));
        } else if (embeddedCert.spkiSha256 === appLeaf.spkiSha256) {
          push(
            ok(CHECK_IDS.profileCertMatch, "证书一致性", `公钥指纹一致（${appLeaf.spkiSha256.slice(0, 12)}…）`),
          );
        } else {
          push(
            fail(
              CHECK_IDS.profileCertMatch,
              "证书一致性",
              "profile 内嵌证书与应用签名证书不是同一把密钥",
              "这是 AGC 993 类错误的典型成因：重新在 AGC 生成 profile，确保使用的是同一张应用证书",
              ),
          );
        }
      }
    } catch (error) {
      push(fail(CHECK_IDS.fileProfileSource, "Profile 文件", errorMessage(error)));
    }
  }

  // -------------------------------------------------------------- output
  if (await canWriteTo(env.outputDir)) {
    push(ok(CHECK_IDS.outputWritable, "输出目录", shortPath(env.outputDir)));
  } else {
    push(fail(CHECK_IDS.outputWritable, "输出目录", `不可写：${env.outputDir}`));
  }

  // --------------------------------------------------------- repo hygiene
  try {
    const gitignorePath = resolvePath(".gitignore", loaded.configDir);
    if (await fileExists(gitignorePath)) {
      const text = await readTextFile(gitignorePath);
      const coversSecrets = /(^|\n)\s*(signing\/|\*\.p12|\*\.p7b|\*\.jks)/m.test(text);
      push(
        coversSecrets
          ? ok(CHECK_IDS.repoGitignore, ".gitignore 排除密钥", "已忽略签名物料")
          : warn(
              CHECK_IDS.repoGitignore,
              ".gitignore 排除密钥",
              "签名物料未被忽略",
              "把 signing/、*.p12、*.p7b、*.pem 加入 .gitignore，避免私钥泄露",
            ),
      );
    } else {
      push(warn(CHECK_IDS.repoGitignore, ".gitignore 排除密钥", "未找到 .gitignore"));
    }
  } catch {
    push(skip(CHECK_IDS.repoGitignore, ".gitignore 排除密钥"));
  }

  return results;
}

function shortPath(path: string, max = 58): string {
  if (path.length <= max) return path;
  return `…${path.slice(path.length - max + 1)}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof HssError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

export { summarizeCertificate };
