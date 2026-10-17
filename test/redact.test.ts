import { describe, expect, it } from "vitest";
import { redact, redactArgv, formatArgv } from "../src/utils/redact.js";

describe("redact", () => {
  it("masks long secrets anywhere in the text", () => {
    expect(redact("password=hunter2 ok", ["hunter2"])).toBe("password=******** ok");
  });

  it("does not mangle paths with a short secret", () => {
    const text = "C:\\dev\\hss\\examples\\demo\\signing\\release.p12";
    expect(redact(text, ["demo"])).toBe(text);
  });

  it("masks values that follow password flags", () => {
    const argv = [
      "java",
      "-jar",
      "hap-sign-tool.jar",
      "sign-app",
      "-keyPwd",
      "secret1",
      "-keystorePwd",
      "secret2",
      "-inFile",
      "app.hap",
    ];
    const masked = redactArgv(argv, []);
    expect(masked).toContain("********");
    expect(masked).not.toContain("secret1");
    expect(masked).not.toContain("secret2");
    expect(masked[masked.length - 1]).toBe("app.hap");
  });

  it("masks a short password at the flag position but keeps paths readable", () => {
    const argv = ["java", "-jar", "s.jar", "sign-app", "-keyPwd", "demo", "-inFile", "C:\\x\\demo\\a.hap"];
    const masked = redactArgv(argv, ["demo"]);
    expect(masked[5]).toBe("********");
    expect(masked[7]).toBe("C:\\x\\demo\\a.hap");
  });

  it("masks a token that exactly equals a secret", () => {
    const out = formatArgv(["echo", "abc123"], ["abc123"]);
    expect(out).toBe("echo ********");
  });

  it("quotes arguments containing spaces", () => {
    const out = formatArgv(["cmd", "C:\\Program Files\\app.hap"], []);
    expect(out).toContain('"C:\\Program Files\\app.hap"');
  });
});
