import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as toYaml } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, validateConfigObject } from "../src/config/load.js";
import { HssError } from "../src/core/errors.js";

function baseConfig() {
  return {
    version: 1,
    project: { bundleName: "com.demo.app", hapPath: "build/app.hap" },
    signing: {
      defaultEnv: "release",
      environments: {
        release: {
          keystore: "signing/release.p12",
          keyAlias: "key1",
          keystorePwd: { env: "HSS_TEST_KEYSTORE_PWD" },
          signAlg: "SHA256withECDSA",
          appCert: "signing/app.pem",
          profileCert: "signing/profile.pem",
          profileJson: "signing/profile.json",
          outputDir: "dist",
        },
      },
    },
  };
}

describe("config schema", () => {
  it("accepts a minimal valid config", () => {
    const parsed = validateConfigObject(baseConfig());
    expect(parsed.signing.environments.release?.signAlg).toBe("SHA256withECDSA");
  });

  it("rejects an environment without a profile source", () => {
    const config = baseConfig();
    const env = config.signing.environments.release as Record<string, unknown>;
    delete env.profileJson;
    expect(() => validateConfigObject(config)).toThrow(HssError);
  });

  it("rejects a malformed bundleName", () => {
    const config = baseConfig();
    config.project.bundleName = "not a bundle";
    expect(() => validateConfigObject(config)).toThrow();
  });

  it("rejects an unknown signature algorithm", () => {
    const config = baseConfig();
    (config.signing.environments.release as Record<string, unknown>).signAlg = "MD5withRSA";
    expect(() => validateConfigObject(config)).toThrow();
  });
});

describe("loadConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves paths relative to the config file and reads secrets from env", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hss-config-"));
    await mkdir(join(dir, "signing"), { recursive: true });
    await writeFile(join(dir, "hss.config.yaml"), toYaml(baseConfig()), "utf8");
    vi.stubEnv("HSS_TEST_KEYSTORE_PWD", "s3cret");

    const loaded = await loadConfig({ cwd: dir });
    expect(loaded.configPath).toBe(join(dir, "hss.config.yaml"));
    expect(loaded.env.keystore).toBe(join(dir, "signing", "release.p12"));
    expect(loaded.env.keystorePwd).toBe("s3cret");
    expect(loaded.secrets).toContain("s3cret");
  });

  it("finds the config from a nested working directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hss-config-"));
    const nested = join(dir, "src", "pages");
    await mkdir(nested, { recursive: true });
    await writeFile(join(dir, "hss.config.yaml"), toYaml(baseConfig()), "utf8");
    vi.stubEnv("HSS_TEST_KEYSTORE_PWD", "s3cret");

    const loaded = await loadConfig({ cwd: nested });
    expect(loaded.configPath).toBe(join(dir, "hss.config.yaml"));
  });

  it("fails clearly when the environment variable is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hss-config-"));
    await writeFile(join(dir, "hss.config.yaml"), toYaml(baseConfig()), "utf8");
    vi.stubEnv("HSS_TEST_KEYSTORE_PWD", "");

    await expect(loadConfig({ cwd: dir })).rejects.toMatchObject({ code: "SECRET_ENV_MISSING" });
  });

  it("lists available environments for an unknown --env", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hss-config-"));
    await writeFile(join(dir, "hss.config.yaml"), toYaml(baseConfig()), "utf8");
    vi.stubEnv("HSS_TEST_KEYSTORE_PWD", "s3cret");

    await expect(loadConfig({ cwd: dir, env: "production" })).rejects.toMatchObject({
      code: "CONFIG_ENV_UNKNOWN",
    });
  });
});
