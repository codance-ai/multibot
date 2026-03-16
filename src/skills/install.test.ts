import { describe, it, expect } from "vitest";
import {
  validateNpmPackage,
  validateDownloadUrl,
  validatePipPackage,
  validateBinName,
  SUPPORTED_INSTALL_KINDS,
  findCompatibleSpecs,
} from "./install";

describe("validateNpmPackage", () => {
  it("accepts simple package name", () => {
    expect(validateNpmPackage("summarize")).toBe(true);
  });
  it("accepts scoped package", () => {
    expect(validateNpmPackage("@steipete/oracle")).toBe(true);
  });
  it("accepts package with version", () => {
    expect(validateNpmPackage("clawhub@1.0.0")).toBe(true);
  });
  it("rejects empty", () => {
    expect(validateNpmPackage("")).toBe(false);
  });
  it("rejects shell injection", () => {
    expect(validateNpmPackage("pkg; rm -rf /")).toBe(false);
  });
  it("rejects flags", () => {
    expect(validateNpmPackage("--global")).toBe(false);
  });
  it("rejects version with shell chars", () => {
    expect(validateNpmPackage("pkg@1';id;'")).toBe(false);
  });
  it("rejects version with backtick", () => {
    expect(validateNpmPackage("pkg@`whoami`")).toBe(false);
  });
});

describe("validateDownloadUrl", () => {
  it("accepts https URL", () => {
    expect(validateDownloadUrl("https://example.com/bin")).toBe(true);
  });
  it("rejects http URL", () => {
    expect(validateDownloadUrl("http://example.com/bin")).toBe(false);
  });
  it("rejects non-URL", () => {
    expect(validateDownloadUrl("not a url")).toBe(false);
  });
  it("rejects file protocol", () => {
    expect(validateDownloadUrl("file:///etc/passwd")).toBe(false);
  });
  it("rejects URL with single quote", () => {
    expect(validateDownloadUrl("https://example.com/a'b")).toBe(false);
  });
});

describe("validatePipPackage", () => {
  it("accepts simple package name", () => {
    expect(validatePipPackage("requests")).toBe(true);
  });
  it("accepts hyphenated name", () => {
    expect(validatePipPackage("youtube-transcript-api")).toBe(true);
  });
  it("accepts package with extras", () => {
    expect(validatePipPackage("requests[security]")).toBe(true);
  });
  it("rejects empty", () => {
    expect(validatePipPackage("")).toBe(false);
  });
  it("rejects shell injection", () => {
    expect(validatePipPackage("pkg; rm -rf /")).toBe(false);
  });
  it("rejects flags", () => {
    expect(validatePipPackage("--user")).toBe(false);
  });
  it("rejects oversized name", () => {
    expect(validatePipPackage("a".repeat(129))).toBe(false);
  });
});

describe("validateBinName", () => {
  it("accepts simple name", () => {
    expect(validateBinName("summarize")).toBe(true);
  });
  it("accepts hyphenated name", () => {
    expect(validateBinName("my-tool")).toBe(true);
  });
  it("accepts underscore name", () => {
    expect(validateBinName("my_tool")).toBe(true);
  });
  it("rejects path traversal", () => {
    expect(validateBinName("../../../etc/passwd")).toBe(false);
  });
  it("rejects shell chars", () => {
    expect(validateBinName("tool; rm -rf /")).toBe(false);
  });
  it("rejects empty", () => {
    expect(validateBinName("")).toBe(false);
  });
  it("rejects leading hyphen (option injection)", () => {
    expect(validateBinName("-v")).toBe(false);
  });
});

describe("SUPPORTED_INSTALL_KINDS", () => {
  it("includes node, download, pip, and uv", () => {
    expect(SUPPORTED_INSTALL_KINDS.has("node")).toBe(true);
    expect(SUPPORTED_INSTALL_KINDS.has("download")).toBe(true);
    expect(SUPPORTED_INSTALL_KINDS.has("pip")).toBe(true);
    expect(SUPPORTED_INSTALL_KINDS.has("uv")).toBe(true);
  });
  it("excludes brew and go", () => {
    expect(SUPPORTED_INSTALL_KINDS.has("brew")).toBe(false);
    expect(SUPPORTED_INSTALL_KINDS.has("go")).toBe(false);
  });
});

describe("findCompatibleSpecs", () => {
  it("returns well-formed node spec", () => {
    const specs = findCompatibleSpecs([{ kind: "node", package: "@steipete/oracle" }]);
    expect(specs).toHaveLength(1);
  });
  it("rejects node spec without package", () => {
    const specs = findCompatibleSpecs([{ kind: "node" }]);
    expect(specs).toHaveLength(0);
  });
  it("returns well-formed download spec", () => {
    const specs = findCompatibleSpecs([
      { kind: "download", url: "https://example.com/bin", bins: ["mytool"] },
    ]);
    expect(specs).toHaveLength(1);
  });
  it("rejects download spec without url", () => {
    const specs = findCompatibleSpecs([{ kind: "download", bins: ["mytool"] }]);
    expect(specs).toHaveLength(0);
  });
  it("rejects download spec without bins", () => {
    const specs = findCompatibleSpecs([{ kind: "download", url: "https://example.com/bin" }]);
    expect(specs).toHaveLength(0);
  });
  it("returns well-formed pip spec", () => {
    const specs = findCompatibleSpecs([{ kind: "pip", package: "youtube-transcript-api" }]);
    expect(specs).toHaveLength(1);
  });
  it("rejects pip spec without package", () => {
    const specs = findCompatibleSpecs([{ kind: "pip" }]);
    expect(specs).toHaveLength(0);
  });
  it("returns well-formed uv spec (mapped to pip)", () => {
    const specs = findCompatibleSpecs([{ kind: "uv", package: "youtube-transcript-api" }]);
    expect(specs).toHaveLength(1);
  });
  it("rejects uv spec without package", () => {
    const specs = findCompatibleSpecs([{ kind: "uv" }]);
    expect(specs).toHaveLength(0);
  });
  it("filters out unsupported kinds", () => {
    const specs = findCompatibleSpecs([
      { kind: "brew", formula: "foo" },
      { kind: "node", package: "bar" },
    ]);
    expect(specs).toHaveLength(1);
    expect(specs[0].kind).toBe("node");
  });
});
