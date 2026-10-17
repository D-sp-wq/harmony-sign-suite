import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { parseLenientJson, readHapInfo } from "../src/core/hap.js";

function makeHap(bundleName: string): AdmZip {
  const zip = new AdmZip();
  const moduleJson = {
    app: { bundleName, versionCode: 6, versionName: "1.6.0" },
    module: { name: "entry", type: "entry" },
  };
  zip.addFile("module.json", Buffer.from(JSON.stringify(moduleJson), "utf8"));
  zip.addFile("pack.info", Buffer.from(JSON.stringify({ summary: { app: { bundleName, version: "6.1.6.0" } } }), "utf8"));
  return zip;
}

describe("parseLenientJson", () => {
  it("parses JSON with comments and trailing commas", () => {
    const text = `{
      // app level
      "app": { "bundleName": "com.demo.app", },
      /* module */
      "module": { "name": "entry" }
    }`;
    const parsed = parseLenientJson(text) as { app: { bundleName: string } };
    expect(parsed.app.bundleName).toBe("com.demo.app");
  });

  it("does not strip comment-like sequences inside strings", () => {
    const text = '{"url": "https://example.com//path", "n": 1}';
    const parsed = parseLenientJson(text) as { url: string };
    expect(parsed.url).toBe("https://example.com//path");
  });
});

describe("readHapInfo", () => {
  it("reads bundleName and versions from a hap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hss-hap-"));
    const hapPath = join(dir, "entry-default.hap");
    makeHap("com.demo.app").writeZip(hapPath);

    const info = readHapInfo(hapPath);
    expect(info.isZip).toBe(true);
    expect(info.hasModuleJson).toBe(true);
    expect(info.bundleName).toBe("com.demo.app");
    expect(info.versionCode).toBe("6");
    expect(info.versionName).toBe("1.6.0");
  });

  it("reports a non-zip file without throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hss-hap-"));
    const bad = join(dir, "broken.hap");
    await writeFile(bad, "not a zip");
    const info = readHapInfo(bad);
    expect(info.isZip).toBe(false);
    expect(info.bundleName).toBeUndefined();
  });
});
