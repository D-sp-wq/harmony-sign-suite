import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertFreshOutDir,
  buildGeneratedEnvironment,
  buildKeygenSteps,
  defaultSubjects,
  generateProfileFile,
  keygenPaths,
  runKeygen,
  type CommandRunner,
  type KeygenOptions,
} from "../src/core/keygen.js";
import { toBase64Url } from "../src/core/profile.js";
import { ensureSigningIgnored } from "../src/utils/gitignore.js";
import { createTestChain } from "./helpers/certs.js";

const PASSWORD = "kg-test-password";

function options(outDir: string): KeygenOptions {
  return {
    javaCommand: "java",
    jarPath: "/fake/hap-sign-tool.jar",
    outDir,
    password: PASSWORD,
    aliases: { root: "r-root", intermediate: "r-sub", app: "r-app", profile: "r-profile" },
    subjects: defaultSubjects("HSS"),
    validityDays: 365,
    force: false,
  };
}

describe("buildKeygenSteps", () => {
  it("emits the six commands in dependency order", () => {
    const steps = buildKeygenSteps(options("C:/tmp/keygen"));
    expect(steps.map((s) => s.id)).toEqual([
      "root-ca",
      "intermediate-ca",
      "app-key",
      "app-cert",
      "profile-key",
      "profile-cert",
    ]);
    expect(steps.map((s) => s.argv[3])).toEqual([
      "generate-ca",
      "generate-ca",
      "generate-keypair",
      "generate-app-cert",
      "generate-keypair",
      "generate-profile-cert",
    ]);
  });

  it("issues the intermediate CA from the root with both password flags", () => {
    const [, intermediate] = buildKeygenSteps(options("C:/tmp/keygen"));
    const argv = intermediate?.argv ?? [];
    expect(argv).toContain("-issuerKeyAlias");
    expect(argv[argv.indexOf("-issuerKeyAlias") + 1]).toBe("r-root");
    expect(argv).toContain("-issuerKeyPwd");
    expect(argv).toContain("-issuerKeystorePwd");
    expect(argv[argv.indexOf("-issuerKeyPwd") + 1]).toBe(PASSWORD);
  });

  it("asks for a full certificate chain on app and profile certs", () => {
    const steps = buildKeygenSteps(options("C:/tmp/keygen"));
    const subjects = defaultSubjects("HSS");
    for (const id of ["app-cert", "profile-cert"] as const) {
      const argv = steps.find((s) => s.id === id)?.argv ?? [];
      expect(argv).toContain("-outForm");
      expect(argv[argv.indexOf("-outForm") + 1]).toBe("certChain");
      expect(argv).toContain("-subCaCertFile");
      expect(argv).toContain("-rootCaCertFile");
      expect(argv).toContain("-issuerKeyPwd");
      // hap-sign-tool refuses to run without the intermediate subject
      expect(argv).toContain("-issuer");
      expect(argv[argv.indexOf("-issuer") + 1]).toBe(subjects.intermediate);
    }
  });

  it("sets a key password on every step so the issuer password works later", () => {
    for (const step of buildKeygenSteps(options("C:/tmp/keygen"))) {
      expect(step.argv).toContain("-keyPwd");
      expect(step.argv[step.argv.indexOf("-keyPwd") + 1]).toBe(PASSWORD);
    }
  });
});

describe("defaultSubjects", () => {
  it("keeps the C,O,OU,CN order the tool validates", () => {
    const subjects = defaultSubjects("ACME");
    for (const dn of Object.values(subjects)) {
      expect(dn).toMatch(/^C=CN,O=ACME,OU=.+,CN=.+$/);
    }
    expect(subjects.root).toContain("Root CA");
    expect(subjects.intermediate).toContain("Intermediate CA");
  });
});

describe("generateProfileFile", () => {
  it("writes a profile with a base64url certificate and the bundle name", async () => {
    const chain = await createTestChain();
    const dir = await mkdtemp(join(tmpdir(), "hss-keygen-"));
    const certPath = join(dir, "app.pem");
    const profilePath = join(dir, "profile.json");
    await writeFile(certPath, chain.chainPem);

    await generateProfileFile({
      bundleName: "com.demo.app",
      type: "release",
      validityDays: 30,
      appCertPath: certPath,
      outPath: profilePath,
    });

    const profile = JSON.parse(await readFile(profilePath, "utf8")) as Record<string, unknown>;
    expect(profile.type).toBe("release");
    const bundleInfo = profile["bundle-info"] as Record<string, string>;
    expect(bundleInfo["bundle-name"]).toBe("com.demo.app");
    expect(bundleInfo.apl).toBe("normal");

    const certField = bundleInfo["distribution-certificate"] ?? "";
    expect(certField).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(certField).toBe(toBase64Url(chain.leafPem).value);

    const validity = profile.validity as Record<string, number>;
    expect(validity["not-after"]).toBeGreaterThan(validity["not-before"] ?? 0);
  });

  it("uses development-certificate for debug profiles", async () => {
    const chain = await createTestChain();
    const dir = await mkdtemp(join(tmpdir(), "hss-keygen-"));
    const certPath = join(dir, "app.pem");
    const profilePath = join(dir, "profile.json");
    await writeFile(certPath, chain.chainPem);

    await generateProfileFile({
      bundleName: "com.demo.app",
      type: "debug",
      validityDays: 7,
      appCertPath: certPath,
      outPath: profilePath,
    });

    const bundleInfo = (JSON.parse(await readFile(profilePath, "utf8")) as Record<string, unknown>)[
      "bundle-info"
    ] as Record<string, string>;
    expect(bundleInfo["development-certificate"]).toBeDefined();
    expect(bundleInfo["distribution-certificate"]).toBeUndefined();
  });
});

describe("assertFreshOutDir", () => {
  it("refuses to overwrite existing signing material", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hss-keygen-"));
    const paths = keygenPaths(dir);
    await writeFile(paths.keystore, "existing");

    await expect(assertFreshOutDir(options(dir))).rejects.toMatchObject({ code: "KEYGEN_EXISTS" });
    await expect(assertFreshOutDir({ ...options(dir), force: true })).resolves.toBeUndefined();
  });
});

describe("runKeygen", () => {
  const fakeRunner: CommandRunner = async (argv) => {
    const outFile = argv[argv.indexOf("-outFile") + 1];
    const keystore = argv[argv.indexOf("-keystoreFile") + 1];
    if (keystore) await writeFile(keystore, "fake-p12");
    if (outFile) {
      const chain = await createTestChain();
      await writeFile(outFile, argv.includes("generate-app-cert") ? chain.chainPem : chain.leafPem);
    }
    return { exitCode: 0, stdout: "success", stderr: "" };
  };

  it("runs every step, writes the profile and a manifest without the password", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hss-keygen-"));
    const result = await runKeygen({
      ...options(dir),
      bundleName: "com.demo.app",
      profileType: "release",
      runner: fakeRunner,
    });

    expect(result.ok).toBe(true);
    expect(result.steps).toHaveLength(6);

    const profile = JSON.parse(await readFile(result.paths.profileJson, "utf8")) as Record<string, unknown>;
    expect((profile["bundle-info"] as Record<string, string>)["bundle-name"]).toBe("com.demo.app");

    const manifest = await readFile(result.manifestPath, "utf8");
    expect(manifest).not.toContain(PASSWORD);
    expect(JSON.parse(manifest).files).toHaveLength(6);
  });

  it("fails fast with an actionable error when a step fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hss-keygen-"));
    const failing: CommandRunner = async (argv) =>
      argv.includes("generate-ca") && argv.includes("-issuer")
        ? { exitCode: 1, stdout: "", stderr: "ERROR: key alias password error" }
        : fakeRunner(argv, { timeoutMs: 1000 });

    await expect(
      runKeygen({
        ...options(dir),
        bundleName: "com.demo.app",
        profileType: "release",
        runner: failing,
      }),
    ).rejects.toMatchObject({ code: "KEYGEN_STEP_FAILED" });
  });
});

describe("buildGeneratedEnvironment", () => {
  it("wires the generated files with env-var secret references", () => {
    const paths = keygenPaths("C:/proj/signing");
    const env = buildGeneratedEnvironment(paths, {
      root: "r-root",
      intermediate: "r-sub",
      app: "r-app",
      profile: "r-profile",
    });
    expect(env.keyAlias).toBe("r-app");
    expect(env.profileKeyAlias).toBe("r-profile");
    expect(env.keystorePwd).toEqual({ env: "HSS_KEYSTORE_PWD" });
    expect(env.keyPwd).toEqual({ env: "HSS_KEY_PWD" });
    expect(env.profileJson).toContain("profile-local.json");
    expect(env.verify).toBe(false);
  });
});

describe("ensureSigningIgnored", () => {
  it("appends the signing rules once and is idempotent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hss-gitignore-"));

    const added = await ensureSigningIgnored(dir);
    expect(added).toContain("signing/");
    expect(added).toContain("*.p12");

    const content = await readFile(join(dir, ".gitignore"), "utf8");
    expect(content).toContain("signing/");
    expect(content).toContain("never commit signing material");

    expect(await ensureSigningIgnored(dir)).toEqual([]);
  });
});
