import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as toYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { applyFixes, planChainRepair, planFixes, planProfileRepair } from "../src/core/fix.js";
import { parsePemChain, validateChainOrder } from "../src/core/certs.js";
import { toBase64Url } from "../src/core/profile.js";
import { loadConfig } from "../src/config/load.js";
import { createTestChain } from "./helpers/certs.js";

describe("planChainRepair", () => {
  it("reorders a reversed chain to leaf → intermediate → root", async () => {
    const chain = await createTestChain();
    const reversed = `${chain.rootPem}${chain.intermediatePem}${chain.leafPem}`;

    const result = planChainRepair(reversed);
    expect(result.status).toBe("changed");
    expect(validateChainOrder(parsePemChain(result.updated)).ok).toBe(true);

    const subjects = parsePemChain(result.updated).map((c) => c.subject);
    expect(subjects[0]).toContain("App Release");
    expect(subjects[1]).toContain("Intermediate");
    expect(subjects[2]).toContain("Root CA");
    expect(result.dropped).toHaveLength(0);
  });

  it("leaves an already ordered chain alone", async () => {
    const chain = await createTestChain();
    const result = planChainRepair(chain.chainPem);
    expect(result.status).toBe("unchanged");
    expect(result.updated).toBe(chain.chainPem);
  });

  it("reports a single certificate as not fixable by ordering", async () => {
    const chain = await createTestChain();
    const result = planChainRepair(chain.leafPem);
    expect(result.status).toBe("unfixable");
    expect(result.reason).toContain("链不完整");
  });

  it("drops certificates that cannot be linked into the chain", async () => {
    const chain = await createTestChain();
    const other = await createTestChain();
    const mixed = `${chain.leafPem}${chain.rootPem}${other.leafPem}${chain.intermediatePem}`;

    const result = planChainRepair(mixed);
    expect(result.status).toBe("changed");
    expect(result.dropped).toHaveLength(1);
    expect(validateChainOrder(parsePemChain(result.updated)).ok).toBe(true);
  });
});

describe("planProfileRepair", () => {
  it("converts a PEM certificate to base64url", async () => {
    const chain = await createTestChain();
    const profile = {
      type: "release",
      "bundle-info": { "bundle-name": "com.demo.app", "distribution-certificate": chain.leafPem },
    };
    const result = planProfileRepair(JSON.stringify(profile, null, 2));
    expect(result.status).toBe("changed");
    expect(result.before).toBe("pem");

    const updated = JSON.parse(result.updated) as { "bundle-info": Record<string, string> };
    const cert = updated["bundle-info"]["distribution-certificate"] ?? "";
    expect(cert).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cert).toBe(toBase64Url(chain.leafPem).value);
  });

  it("reports no change when the certificate is already base64url", async () => {
    const chain = await createTestChain();
    const profile = {
      type: "release",
      "bundle-info": { "distribution-certificate": toBase64Url(chain.leafPem).value },
    };
    expect(planProfileRepair(JSON.stringify(profile)).status).toBe("unchanged");
  });
});

async function createProject(appChainPem: string, profileCertPem: string, profileJson: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "hss-fix-"));
  await mkdir(join(dir, "signing"), { recursive: true });
  await writeFile(join(dir, "signing", "app.pem"), appChainPem);
  await writeFile(join(dir, "signing", "profile.pem"), profileCertPem);
  await writeFile(join(dir, "signing", "profile.json"), JSON.stringify(profileJson, null, 2));
  await writeFile(join(dir, "signing", "release.p12"), "dummy");

  await writeFile(
    join(dir, "hss.config.yaml"),
    toYaml({
      version: 1,
      project: { bundleName: "com.demo.app" },
      signing: {
        defaultEnv: "release",
        environments: {
          release: {
            keystore: "signing/release.p12",
            keyAlias: "k",
            signAlg: "SHA256withECDSA",
            appCert: "signing/app.pem",
            profileCert: "signing/profile.pem",
            profileJson: "signing/profile.json",
            outputDir: "dist",
          },
        },
      },
    }),
  );
  return dir;
}

describe("planFixes + applyFixes", () => {
  it("repairs a reversed app chain and a PEM profile, then is idempotent", async () => {
    const chain = await createTestChain();
    const reversed = `${chain.rootPem}${chain.intermediatePem}${chain.leafPem}`;
    const profile = {
      type: "release",
      "bundle-info": { "bundle-name": "com.demo.app", "distribution-certificate": chain.leafPem },
    };
    const dir = await createProject(reversed, chain.chainPem, profile);
    const loaded = await loadConfig({ cwd: dir });

    const plan = await planFixes(loaded);
    expect(plan.repairs).toHaveLength(2);
    const ids = plan.repairs.flatMap((r) => r.changes.map((c) => c.id));
    expect(ids).toContain("cert.chain-order");
    expect(ids).toContain("profile.cert-encoding");

    const applied = await applyFixes(plan, { timestamp: "test" });
    expect(applied).toHaveLength(2);
    expect(applied.every((a) => Boolean(a.backup))).toBe(true);

    // chain is now valid
    const fixedChain = await readFile(join(dir, "signing", "app.pem"), "utf8");
    expect(validateChainOrder(parsePemChain(fixedChain)).ok).toBe(true);

    // profile certificate is base64url
    const fixedProfile = JSON.parse(await readFile(join(dir, "signing", "profile.json"), "utf8")) as {
      "bundle-info": Record<string, string>;
    };
    expect(fixedProfile["bundle-info"]["distribution-certificate"]).toMatch(/^[A-Za-z0-9_-]+$/);

    // backups exist
    const files = await readdir(join(dir, "signing"));
    expect(files.some((f) => f.includes(".bak-test"))).toBe(true);

    // second run finds nothing to fix
    const second = await planFixes(loaded);
    expect(second.repairs).toHaveLength(0);
  });

  it("can skip backups", async () => {
    const chain = await createTestChain();
    const reversed = `${chain.rootPem}${chain.leafPem}${chain.intermediatePem}`;
    const dir = await createProject(reversed, chain.chainPem, {
      type: "release",
      "bundle-info": { "distribution-certificate": chain.leafPem },
    });
    const loaded = await loadConfig({ cwd: dir });
    const plan = await planFixes(loaded);

    await applyFixes(plan, { backup: false, timestamp: "nobackup" });
    const files = await readdir(join(dir, "signing"));
    expect(files.some((f) => f.includes(".bak-"))).toBe(false);
  });

  it("skips signed profiles with an explanation", async () => {
    const chain = await createTestChain();
    const dir = await mkdtemp(join(tmpdir(), "hss-fix-"));
    await mkdir(join(dir, "signing"), { recursive: true });
    await writeFile(join(dir, "signing", "app.pem"), chain.chainPem);
    await writeFile(join(dir, "signing", "profile.pem"), chain.chainPem);
    await writeFile(join(dir, "signing", "release.p7b"), "binary");
    await writeFile(
      join(dir, "hss.config.yaml"),
      toYaml({
        version: 1,
        project: { bundleName: "com.demo.app" },
        signing: {
          defaultEnv: "release",
          environments: {
            release: {
              keystore: "signing/release.p12",
              keyAlias: "k",
              signAlg: "SHA256withECDSA",
              appCert: "signing/app.pem",
              profileCert: "signing/profile.pem",
              profileP7b: "signing/release.p7b",
              outputDir: "dist",
            },
          },
        },
      }),
    );

    const loaded = await loadConfig({ cwd: dir });
    const plan = await planFixes(loaded);
    expect(plan.repairs).toHaveLength(0);
    expect(plan.skipped.some((s) => s.id === "profile.p7b")).toBe(true);
  });
});
