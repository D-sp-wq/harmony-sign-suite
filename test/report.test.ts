import { describe, expect, it } from "vitest";
import { displayWidth } from "../src/core/report.js";

describe("displayWidth", () => {
  it("counts ASCII as one cell", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("a b")).toBe(3);
  });

  it("counts CJK and full-width characters as two cells", () => {
    expect(displayWidth("中文")).toBe(4);
    expect(displayWidth("证书链")).toBe(6);
    expect(displayWidth("（大二）")).toBe(8);
  });

  it("handles mixed content", () => {
    expect(displayWidth("凭证 chain")).toBe(2 * 2 + 1 + 5);
    expect(displayWidth("A中B")).toBe(4);
  });

  it("is zero for an empty string", () => {
    expect(displayWidth("")).toBe(0);
  });
});
