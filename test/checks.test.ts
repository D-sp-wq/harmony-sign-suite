import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { stringify as toYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.js";
import { runChecks } from "../src/core/checks.js";
import type { ToolchainInfo } from "../src/core/toolchain.js";
import type { CheckResult } from "../src/core/result.js";
import { createTestChain, type TestChain } from "./helpers/certs.js";

interface Project {
  dir: string;
  chain: TestChain;
  bundleName: string;
}

async function createProject(options: { expired?: boolean; bundleName?: string } = {}): Promise<Project> {
  const dir = await mkdtemp(join(tmpdir(), "hss-project-"));
  const chain = await createTestChain({ expired: options.expired === true });
  const bundleName = options.bundleName ?? "com.demo.app";

  await mkdir(join(dir, "signing"), { recursive: true });
  await mkdir(join(dir, "build"), { recursive: true });

  await writeFile(join(dir, "signing", "release.p12"), "dummy-keystore");
  await writeFile(join(dir, "signing", "app.pem"), chain.chainPem);
  await writeFile(join(dir, "signing", "profile.pem"), chain.chainPem);

  const profile = {
    "version-code": 1,
    "version-name": "1.0.0",
    uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    type: "release",
    issuer: "HSS Test",
    validity: {
      "not-before": Math.floor(Date.now() / 1000) - 86_400,
      "not-after": Math.floor(Date.now() / 1000) + 365 * 86_400,
    },
    "bundle-info": {
      "developer-id": "dev-1",
      "distribution-certificate": chain.leafDerBase64,
      "bundle-name": bundleName,
      apl: "normal",
      "app-feature": "hos_normal_app",
    },
  };
  await writeFile(join(dir, "signing", "profile.json"), JSON.stringify(profile, null, 2));

  const zip = new AdmZip();
  zip.addFile(
    "module.json",
    Buffer.from(JSON.stringify({ app: { bundleName, versionCode: 6, versionName: "1.6.0" }, module: { name: "entry" } })),
  );
  zip.writeZip(join(dir, "build", "entry.hap"));

  await writeFile(join(dir, ".gitignore"), "signing/\n*.p12\n");

  const config = {
    version: 1,
    project: { bundleName, hapPath: "build/entry.hap" },
    signing: {
      defaultEnv: "release",
      environments: {
        release: {
          keystore: "signing/release.p12",
          keyAlias: "key1",
          signAlg: "SHA256withECDSA",
          appCert: "signing/app.pem",
          profileCert: "signing/profile.pem",
          profileJson: "signing/profile.json",
          outputDir: "dist",
        },
      },
    },
  };
  await writeFile(join(dir, "hss.config.yaml"), toYaml(config));

  return { dir, chain, bundleName };
}

function fakeToolchain(): ToolchainInfo {
  return {
    jarPath: "C:\\fake\\hap-sign-tool.jar",
    java: { path: "java", version: "17.0.1", major: 17 },
  };
}

function find(results: CheckResult[], id: string): CheckResult | undefined {
  return results.find((r) => r.id === id);
}

describe("runChecks", () => {
  it("passes a consistent project", async () => {
    const project = await createProject();
    const loaded = await loadConfig({ cwd: project.dir });
    const results = await runChecks({ loaded, toolchain: fakeToolchain() });

    const failures = results.filter((r) => r.status === "fail");
    expect(failures.map((f) => `${f.id}: ${f.detail}`)).toEqual([]);

    expect(find(results, "cert.app-chain-order")?.status).toBe("pass");
    expect(find(results, "cert.profile-chain-order")?.status).toBe("pass");
    expect(find(results, "cert.key-alg-match")?.status).toBe("pass");
    expect(find(results, "hap.bundle-name")?.status).toBe("pass");
    expect(find(results, "profile.bundle-name")?.status).toBe("pass");
    expect(find(results, "profile.type")?.status).toBe("pass");
    expect(find(results, "profile.cert-match")?.status).toBe("pass");
    expect(find(results, "output.writable")?.status).toBe("pass");
  });

  it("fails when the configured bundleName differs from the HAP", async () => {
    const project = await createProject();
    // Rewrite the config with a different bundleName.
    const configPath = join(project.dir, "hss.config.yaml");
    const config = {
      version: 1,
      project: { bundleName: "com.other.app", hapPath: "build/entry.hap" },
      signing: {
        defaultEnv: "release",
        environments: {
          release: {
            keystore: "signing/release.p12",
            keyAlias: "key1",
            signAlg: "SHA256withECDSA",
            appCert: "signing/app.pem",
            profileCert: "signing/profile.pem",
            profileJson: "signing/profile.json",
            outputDir: "dist",
          },
        },
      },
    };
    await writeFile(configPath, toYaml(config));

    const loaded = await loadConfig({ cwd: project.dir });
    const results = await runChecks({ loaded, toolchain: fakeToolchain() });

    const bundleCheck = find(results, "hap.bundle-name");
    expect(bundleCheck?.status).toBe("fail");
    expect(bundleCheck?.detail).toContain("com.demo.app");
  });

  it("fails on an expired certificate", async () => {
    const project = await createProject({ expired: true });
    const loaded = await loadConfig({ cwd: project.dir });
    const results = await runChecks({ loaded, toolchain: fakeToolchain() });

    expect(find(results, "cert.expiry")?.status).toBe("fail");
  });

  it("respects checks.ignore", async () => {
    const project = await createProject({ expired: true });
    const configPath = join(project.dir, "hss.config.yaml");
    const config = {
      version: 1,
      project: { bundleName: project.bundleName, hapPath: "build/entry.hap" },
      signing: {
        defaultEnv: "release",
        environments: {
          release: {
            keystore: "signing/release.p12",
            keyAlias: "key1",
            signAlg: "SHA256withECDSA",
            appCert: "signing/app.pem",
            profileCert: "signing/profile.pem",
            profileJson: "signing/profile.json",
            outputDir: "dist",
          },
        },
      },
      checks: { ignore: ["cert.expiry"] },
    };
    await writeFile(configPath, toYaml(config));

    const loaded = await loadConfig({ cwd: project.dir });
    const results = await runChecks({ loaded, toolchain: fakeToolchain() });
    expect(find(results, "cert.expiry")).toBeUndefined();
  });

  it("treats encoding of a signed p7b profile as informational, not a warning", async () => {
    const project = await createProject();
    // Replace the unsigned template with a signed-looking p7b that embeds a PEM cert.
    const p7bJson = {
      type: "release",
      uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      validity: {
        "not-before": Math.floor(Date.now() / 1000) - 86_400,
        "not-after": Math.floor(Date.now() / 1000) + 86_400,
      },
      "bundle-info": {
        "bundle-name": project.bundleName,
        "distribution-certificate": project.chain.leafPem,
      },
    };
    await writeFile(
      join(project.dir, "signing", "profile.p7b"),
      Buffer.concat([Buffer.from([0x30, 0x82, 0x01, 0x00]), Buffer.from(JSON.stringify(p7bJson))]),
    );

    const configPath = join(project.dir, "hss.config.yaml");
    await writeFile(
      configPath,
      toYaml({
        version: 1,
        project: { bundleName: project.bundleName, hapPath: "build/entry.hap" },
        signing: {
          defaultEnv: "release",
          environments: {
            release: {
              keystore: "signing/release.p12",
              keyAlias: "key1",
              signAlg: "SHA256withECDSA",
              appCert: "signing/app.pem",
              profileCert: "signing/profile.pem",
              profileP7b: "signing/profile.p7b",
              outputDir: "dist",
            },
          },
        },
      }),
    );

    const loaded = await loadConfig({ cwd: project.dir });
    const results = await runChecks({ loaded, toolchain: fakeToolchain() });
    expect(find(results, "profile.cert-encoding")?.status).toBe("skip");
    expect(find(results, "profile.type")?.status).toBe("pass");
  });
});
