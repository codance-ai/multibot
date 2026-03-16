import { describe, it, expect } from "vitest";
import { isSkipReply } from "./utils";

describe("isSkipReply", () => {
  it("returns true for empty string", () => {
    expect(isSkipReply("")).toBe(true);
  });

  it("returns true for whitespace-only", () => {
    expect(isSkipReply("  \n  ")).toBe(true);
  });

  it("returns true for [skip]", () => {
    expect(isSkipReply("[skip]")).toBe(true);
    expect(isSkipReply("[SKIP]")).toBe(true);
    expect(isSkipReply("  [skip]  ")).toBe(true);
  });

  it("returns false for regular text", () => {
    expect(isSkipReply("Hello!")).toBe(false);
    expect(isSkipReply("Here is my reply")).toBe(false);
  });
});
