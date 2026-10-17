import { describe, expect, it } from "vitest";
import { redact, redactArgv, formatArgv } from "../src/utils/redact.js";

describe("redact", () => {
  it("masks known secrets anywhere in the text", () => {
    expect(redact("password=hunter2 ok", ["hunter2"])).toBe("password=******** ok");
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

  it("also masks standalone occurrences not following a flag", () => {
    const out = formatArgv(["echo", "abc123"], ["abc123"]);
    expect(out).toBe("echo ********");
  });

  it("quotes arguments containing spaces", () => {
    const out = formatArgv(["cmd", "C:\\Program Files\\app.hap"], []);
    expect(out).toContain('"C:\\Program Files\\app.hap"');
  });
});
