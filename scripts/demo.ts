/**
 * Generate a self-contained demo project under examples/demo.
 *
 * Creates a throw-away certificate chain, a profile template and a fake HAP so
 * the CLI can be exercised end to end without DevEco Studio installed.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import AdmZip from "adm-zip";
import { stringify as toYaml } from "yaml";
import { createTestChain } from "../test/helpers/certs.js";

const root = resolve(process.cwd(), "examples", "demo");

async function main(): Promise<void> {
  await rm(root, { recursive: true, force: true });
  await mkdir(join(root, "signing"), { recursive: true });
  await mkdir(join(root, "build"), { recursive: true });

  const chain = await createTestChain();
  await writeFile(join(root, "signing", "release.p12"), "demo-keystore-placeholder");
  await writeFile(join(root, "signing", "app-release.pem"), chain.chainPem);
  await writeFile(join(root, "signing", "profile-release.pem"), chain.chainPem);

  const profile = {
    "version-code": 1,
    "version-name": "1.0.0",
    uuid: "7f3d9a52-1c4b-4f77-9e0a-demo00000001",
    type: "release",
    issuer: "HSS Demo",
    validity: {
      "not-before": Math.floor(Date.now() / 1000) - 86_400,
      "not-after": Math.floor(Date.now() / 1000) + 365 * 86_400,
    },
    "bundle-info": {
      "developer-id": "demo-developer",
      "distribution-certificate": chain.leafDerBase64,
      "bundle-name": "com.demo.moodnote",
      apl: "normal",
      "app-feature": "hos_normal_app",
    },
  };
  await writeFile(join(root, "signing", "profile-release.json"), JSON.stringify(profile, null, 2));

  const zip = new AdmZip();
  zip.addFile(
    "module.json",
    Buffer.from(
      JSON.stringify(
        { app: { bundleName: "com.demo.moodnote", versionCode: 6, versionName: "1.6.0" }, module: { name: "entry" } },
        null,
        2,
      ),
    ),
  );
  zip.writeZip(join(root, "build", "entry-default.hap"));

  await writeFile(join(root, ".gitignore"), "signing/\ndist/\n");

  const config = {
    version: 1,
    project: { name: "moodnote", bundleName: "com.demo.moodnote", hapPath: "build/entry-default.hap" },
    signing: {
      defaultEnv: "release",
      environments: {
        release: {
          keystore: "signing/release.p12",
          keyAlias: "oh-app1-key-v1",
          keystorePwd: { env: "HSS_KEYSTORE_PWD" },
          keyPwd: { env: "HSS_KEY_PWD" },
          signAlg: "SHA256withECDSA",
          appCert: "signing/app-release.pem",
          profileCert: "signing/profile-release.pem",
          profileJson: "signing/profile-release.json",
          outputDir: "dist",
        },
      },
    },
  };
  await writeFile(join(root, "hss.config.yaml"), toYaml(config));

  console.log(`demo project ready: ${root}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
