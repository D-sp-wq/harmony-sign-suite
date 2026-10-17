import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeProfileFile, normalizeProfileObject, toBase64Url } from "../src/core/profile.js";
import { pemFromBase64Certificate } from "../src/core/certs.js";
import { createTestChain } from "./helpers/certs.js";

describe("toBase64Url", () => {
  it("converts a PEM block to unpadded base64url", async () => {
    const chain = await createTestChain();
    const result = toBase64Url(chain.leafPem);
    expect(result.encoding).toBe("pem");
    expect(result.value).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("converts standard base64 to base64url", () => {
    const result = toBase64Url("ab+c/d==");
    expect(result.encoding).toBe("base64");
    expect(result.value).toBe("ab-c_d");
  });

  it("leaves base64url untouched", () => {
    const result = toBase64Url("ab-c_d");
    expect(result.encoding).toBe("base64url");
    expect(result.value).toBe("ab-c_d");
  });
});

describe("normalizeProfileObject", () => {
  it("rewrites certificate fields but keeps everything else", () => {
    const input = {
      type: "release",
      "bundle-info": {
        "bundle-name": "com.demo.app",
        "distribution-certificate": "-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n",
      },
    };
    const result = normalizeProfileObject(input);
    expect(result.changed).toBe(true);
    expect(result.encodings).toEqual(["pem"]);
    const info = (result.json as { "bundle-info": Record<string, string> })["bundle-info"];
    expect(info["distribution-certificate"]).toBe("QUJD");
    expect(info["bundle-name"]).toBe("com.demo.app");
    // input is not mutated
    expect(input["bundle-info"]["distribution-certificate"]).toContain("BEGIN CERTIFICATE");
  });

  it("reports no change for an already normalised profile", () => {
    const input = { "bundle-info": { "distribution-certificate": "QUJD" } };
    const result = normalizeProfileObject(input);
    expect(result.changed).toBe(false);
  });
});

describe("normalizeProfileFile", () => {
  it("writes a normalised copy next to the original and leaves the source intact", async () => {
    const chain = await createTestChain();
    const dir = await mkdtemp(join(tmpdir(), "hss-norm-"));
    const src = join(dir, "profile.json");
    const dst = join(dir, "out", "normalized.json");
    const profile = {
      type: "release",
      "bundle-info": {
        "bundle-name": "com.demo.app",
        "distribution-certificate": chain.leafPem,
      },
    };
    await writeFile(src, JSON.stringify(profile));

    const result = await normalizeProfileFile(src, dst);
    expect(result.changed).toBe(true);
    expect(result.path).toBe(dst);

    const written = JSON.parse(await readFile(dst, "utf8")) as {
      "bundle-info": Record<string, string>;
    };
    const b64url = written["bundle-info"]["distribution-certificate"];
    expect(b64url).toMatch(/^[A-Za-z0-9_-]+$/);

    // The normalised value must still decode to the same certificate.
    expect(pemFromBase64Certificate(b64url ?? "")).toContain("BEGIN CERTIFICATE");

    const source = JSON.parse(await readFile(src, "utf8")) as {
      "bundle-info": Record<string, string>;
    };
    expect(source["bundle-info"]["distribution-certificate"]).toContain("BEGIN CERTIFICATE");
  });
});
