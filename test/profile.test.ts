import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractProfileJsonFromP7b, loadProfile, parseProfileObject } from "../src/core/profile.js";

const profileJson = {
  "version-code": 1,
  "version-name": "1.0.0",
  uuid: "11111111-2222-3333-4444-555555555555",
  type: "release",
  issuer: "HSS Test",
  validity: { "not-before": 1700000000, "not-after": 2000000000 },
  "bundle-info": {
    "developer-id": "dev-1",
    "distribution-certificate": "QUJD",
    "bundle-name": "com.demo.app",
    apl: "normal",
    "app-feature": "hos_normal_app",
  },
  acls: { "allowed-acls": ["ohos.permission.INTERNET"] },
  permissions: { "restricted-permissions": ["ohos.permission.READ_CALENDAR"] },
};

describe("parseProfileObject", () => {
  it("normalizes hyphenated profile fields", () => {
    const info = parseProfileObject(profileJson);
    expect(info.type).toBe("release");
    expect(info.bundleName).toBe("com.demo.app");
    expect(info.uuid).toBe("11111111-2222-3333-4444-555555555555");
    expect(info.allowedAcls).toEqual(["ohos.permission.INTERNET"]);
    expect(info.restrictedPermissions).toEqual(["ohos.permission.READ_CALENDAR"]);
    expect(info.notAfter?.toISOString()).toBe(new Date(2000000000 * 1000).toISOString());
  });

  it("tolerates missing sections", () => {
    const info = parseProfileObject({ type: "debug" });
    expect(info.type).toBe("debug");
    expect(info.allowedAcls).toEqual([]);
    expect(info.bundleName).toBeUndefined();
  });
});

describe("extractProfileJsonFromP7b", () => {
  it("finds the JSON payload inside a binary CMS wrapper", () => {
    // Simulate a DER framed SignedData: header bytes, then the JSON, then trailer.
    const json = Buffer.from(JSON.stringify(profileJson), "utf8");
    const header = Buffer.from([0x30, 0x82, 0x01, 0x00, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02]);
    const trailer = Buffer.from([0x00, 0x00, 0xa0, 0x82]);
    const p7b = Buffer.concat([header, json, trailer]);

    const extracted = extractProfileJsonFromP7b(p7b);
    expect(extracted).not.toBeNull();
    expect(JSON.parse(extracted ?? "{}")).toMatchObject({ type: "release", "bundle-info": { "bundle-name": "com.demo.app" } });
  });

  it("returns null when there is no JSON", () => {
    expect(extractProfileJsonFromP7b(Buffer.from([0x30, 0x03, 0x02, 0x01, 0x01]))).toBeNull();
  });

  it("loads a .p7b file from disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hss-p7b-"));
    const path = join(dir, "release.p7b");
    await writeFile(path, Buffer.concat([Buffer.from([0x30, 0x80]), Buffer.from(JSON.stringify(profileJson), "utf8")]));

    const loaded = await loadProfile(path);
    expect(loaded.source).toBe("p7b");
    expect(loaded.info.bundleName).toBe("com.demo.app");
  });
});
