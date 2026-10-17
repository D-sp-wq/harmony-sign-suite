import { webcrypto } from "node:crypto";
import * as x509 from "@peculiar/x509";

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

const ALG = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };

export interface TestChain {
  rootPem: string;
  intermediatePem: string;
  leafPem: string;
  /** leaf + intermediate + root, correct order. */
  chainPem: string;
  /** Base64 DER of the leaf certificate (as embedded in a profile). */
  leafDerBase64: string;
  leafKeyPair: CryptoKeyPair;
}

export interface ChainOptions {
  /** Shift validity into the past to simulate an expired chain. */
  expired?: boolean;
}

/** Build a three level ECDSA P-256 certificate chain for tests. */
export async function createTestChain(options: ChainOptions = {}): Promise<TestChain> {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const notBefore = new Date(options.expired ? now - 400 * day : now - day);
  const notAfter = new Date(options.expired ? now - 10 * day : now + 365 * day);

  const rootKeys = (await webcrypto.subtle.generateKey(ALG, true, ["sign", "verify"])) as CryptoKeyPair;
  const intermediateKeys = (await webcrypto.subtle.generateKey(ALG, true, ["sign", "verify"])) as CryptoKeyPair;
  const leafKeys = (await webcrypto.subtle.generateKey(ALG, true, ["sign", "verify"])) as CryptoKeyPair;

  const root = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=HSS Test Root CA,O=HSS,C=CN",
    notBefore,
    notAfter,
    signingAlgorithm: ALG,
    keys: rootKeys,
    extensions: [new x509.BasicConstraintsExtension(true, 2, true)],
  });

  const intermediate = await x509.X509CertificateGenerator.create({
    serialNumber: "02",
    subject: "CN=HSS Test Intermediate CA,O=HSS,C=CN",
    issuer: root.subject,
    notBefore,
    notAfter,
    signingAlgorithm: ALG,
    publicKey: intermediateKeys.publicKey,
    signingKey: rootKeys.privateKey,
    extensions: [new x509.BasicConstraintsExtension(true, 0, true)],
  });

  const leaf = await x509.X509CertificateGenerator.create({
    serialNumber: "03",
    subject: "CN=HSS Test App Release,O=HSS,C=CN",
    issuer: intermediate.subject,
    notBefore,
    notAfter,
    signingAlgorithm: ALG,
    publicKey: leafKeys.publicKey,
    signingKey: intermediateKeys.privateKey,
    extensions: [new x509.BasicConstraintsExtension(false, undefined, true)],
  });

  const rootPem = root.toString("pem");
  const intermediatePem = intermediate.toString("pem");
  const leafPem = leaf.toString("pem");

  return {
    rootPem,
    intermediatePem,
    leafPem,
    chainPem: `${leafPem}${intermediatePem}${rootPem}`,
    leafDerBase64: Buffer.from(leaf.rawData).toString("base64"),
    leafKeyPair: leafKeys,
  };
}
