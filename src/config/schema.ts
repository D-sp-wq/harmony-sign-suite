import { z } from "zod";

/** A secret may be inline, or a reference to an env var / file. */
export const secretRefSchema = z.union([
  z.string().min(1, "secret must not be empty"),
  z.object({ env: z.string().min(1) }).strict(),
  z.object({ file: z.string().min(1) }).strict(),
]);

export type SecretRef = z.infer<typeof secretRefSchema>;

export const signAlgSchema = z.enum([
  "SHA256withECDSA",
  "SHA384withECDSA",
  "SHA256withRSA",
  "SHA384withRSA",
]);

export type SignAlg = z.infer<typeof signAlgSchema>;

export const environmentSchema = z
  .object({
    /** PKCS#12 / JKS keystore holding the signing key. */
    keystore: z.string().min(1),
    /** Key alias for signing the HAP (app certificate). */
    keyAlias: z.string().min(1),
    keyPwd: secretRefSchema.optional(),
    /** Key alias for signing the profile; defaults to keyAlias. */
    profileKeyAlias: z.string().min(1).optional(),
    /** Key password for the profile key; defaults to keyPwd. */
    profileKeyPwd: secretRefSchema.optional(),
    keystorePwd: secretRefSchema.optional(),
    signAlg: signAlgSchema.default("SHA256withECDSA"),
    /** Application signing certificate chain (leaf → intermediate → root). */
    appCert: z.string().min(1),
    /** Profile signing certificate chain. */
    profileCert: z.string().min(1),
    /** Unsigned HarmonyAppProvision JSON template (signed by `hss sign`). */
    profileJson: z.string().optional(),
    /** Already-signed .p7b profile, used when profileJson is absent. */
    profileP7b: z.string().optional(),
    /** Per-environment HAP override; falls back to project.hapPath. */
    hapPath: z.string().optional(),
    /** Run the official verify-app step after signing (default true). */
    verify: z.boolean().default(true),
    outputDir: z.string().default("dist"),
    outputName: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.profileJson && !value.profileP7b) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["profileJson"],
        message: "either profileJson (unsigned template) or profileP7b (signed) is required",
      });
    }
  });

export type EnvironmentConfig = z.infer<typeof environmentSchema>;

export const projectSchema = z
  .object({
    /** Bundle name; when omitted it is read from the HAP. */
    bundleName: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/, "must look like com.example.app")
      .optional(),
    name: z.string().optional(),
    /** Default HAP to sign. */
    hapPath: z.string().optional(),
  })
  .default({});

export const configSchema = z.object({
  version: z.literal(1).default(1),
  project: projectSchema,
  signing: z.object({
    /** Java executable; defaults to `java` on PATH. */
    javaPath: z.string().optional(),
    /** Path to hap-sign-tool.jar; auto-discovered when omitted. */
    toolchain: z.string().optional(),
    defaultEnv: z.string().default("release"),
    environments: z.record(z.string(), environmentSchema),
  }),
  checks: z
    .object({
      /** Check ids to skip, e.g. ["cert.expiry"]. */
      ignore: z.array(z.string()).default([]),
    })
    .default({ ignore: [] }),
});

export type HssConfig = z.infer<typeof configSchema>;

export interface ResolvedEnvironment {
  name: string;
  keystore: string;
  keyAlias: string;
  keyPwd?: string;
  profileKeyAlias?: string;
  profileKeyPwd?: string;
  keystorePwd?: string;
  signAlg: SignAlg;
  appCert: string;
  profileCert: string;
  profileJson?: string;
  profileP7b?: string;
  hapPath?: string;
  outputDir: string;
  outputName?: string;
  verify: boolean;
}

export interface LoadedConfig {
  configPath: string;
  configDir: string;
  config: HssConfig;
  envName: string;
  env: ResolvedEnvironment;
  /** Resolved secrets, kept only for redaction. */
  secrets: string[];
}

/** Pretty-print zod issues as `path: message` lines. */
export function formatConfigIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
    return `${path}: ${issue.message}`;
  });
}
