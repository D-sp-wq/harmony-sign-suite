import { describe, expect, it } from "vitest";
import {
  describeCertificate,
  extractPemCertificates,
  keyTypeMatchesSignAlg,
  parsePemChain,
  pemFromBase64Certificate,
  validateChainOrder,
} from "../src/core/certs.js";
import { createTestChain } from "./helpers/certs.js";

describe("certificate chain handling", () => {
  it("splits a PEM bundle into individual certificates", async () => {
    const chain = await createTestChain();
    const pems = extractPemCertificates(chain.chainPem);
    expect(pems).toHaveLength(3);
    expect(pems[0]).toContain("BEGIN CERTIFICATE");
  });

  it("accepts a correctly ordered chain", async () => {
    const chain = await createTestChain();
    const parsed = parsePemChain(chain.chainPem);
    expect(parsed).toHaveLength(3);

    const validation = validateChainOrder(parsed);
    expect(validation.problems).toEqual([]);
    expect(validation.ok).toBe(true);
  });

  it("rejects a reversed chain", async () => {
    const chain = await createTestChain();
    const reversed = parsePemChain(`${chain.rootPem}${chain.intermediatePem}${chain.leafPem}`);
    const validation = validateChainOrder(reversed);
    expect(validation.ok).toBe(false);
    expect(validation.problems.length).toBeGreaterThan(0);
  });

  it("reports a single certificate as an incomplete chain", async () => {
    const chain = await createTestChain();
    const validation = validateChainOrder(parsePemChain(chain.leafPem));
    expect(validation.ok).toBe(false);
    expect(validation.problems[0]?.message).toMatch(/full chain/i);
  });

  it("derives the same public key fingerprint from PEM and base64 DER", async () => {
    const chain = await createTestChain();
    const fromPem = describeCertificate(chain.leafPem);
    const fromBase64 = describeCertificate(pemFromBase64Certificate(chain.leafDerBase64));
    expect(fromBase64.spkiSha256).toBe(fromPem.spkiSha256);
    expect(fromPem.keyType).toBe("ec");
    expect(fromPem.isCa).toBe(false);
  });

  it("parses unpadded base64url certificates (what hap-sign-tool expects)", async () => {
    const chain = await createTestChain();
    const unpadded = chain.leafDerBase64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(unpadded).not.toContain("=");

    const parsed = describeCertificate(pemFromBase64Certificate(unpadded));
    expect(parsed.spkiSha256).toBe(describeCertificate(chain.leafPem).spkiSha256);
  });

  it("matches key types to signature algorithms", () => {
    expect(keyTypeMatchesSignAlg("ec", "SHA256withECDSA")).toBe(true);
    expect(keyTypeMatchesSignAlg("ec", "SHA384withECDSA")).toBe(true);
    expect(keyTypeMatchesSignAlg("rsa", "SHA256withRSA")).toBe(true);
    expect(keyTypeMatchesSignAlg("ec", "SHA256withRSA")).toBe(false);
    expect(keyTypeMatchesSignAlg("rsa", "SHA256withECDSA")).toBe(false);
  });
});
