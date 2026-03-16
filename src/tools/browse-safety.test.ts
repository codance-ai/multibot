import { describe, it, expect } from "vitest";
import { assertSafeUrl } from "./browse-safety";

describe("assertSafeUrl", () => {
  // --- Allowed URLs ---
  it("allows normal https URLs", () => {
    expect(() => assertSafeUrl("https://example.com")).not.toThrow();
    expect(() => assertSafeUrl("https://youtube.com/@user/videos")).not.toThrow();
  });

  it("allows normal http URLs", () => {
    expect(() => assertSafeUrl("http://example.com/page")).not.toThrow();
  });

  // --- Blocked schemes ---
  it("blocks non-http schemes", () => {
    expect(() => assertSafeUrl("ftp://example.com")).toThrow("Only http/https");
    expect(() => assertSafeUrl("file:///etc/passwd")).toThrow("Only http/https");
    expect(() => assertSafeUrl("javascript:alert(1)")).toThrow();
  });

  // --- Blocked IPv4 private/reserved ---
  it("blocks localhost", () => {
    expect(() => assertSafeUrl("http://localhost")).toThrow("internal");
    expect(() => assertSafeUrl("http://127.0.0.1")).toThrow("internal");
    expect(() => assertSafeUrl("http://127.0.0.1:8080/admin")).toThrow("internal");
  });

  it("blocks private IPv4 ranges", () => {
    expect(() => assertSafeUrl("http://10.0.0.1")).toThrow("internal");
    expect(() => assertSafeUrl("http://172.16.0.1")).toThrow("internal");
    expect(() => assertSafeUrl("http://172.31.255.255")).toThrow("internal");
    expect(() => assertSafeUrl("http://192.168.1.1")).toThrow("internal");
  });

  it("allows non-private 172.x addresses", () => {
    expect(() => assertSafeUrl("http://172.15.0.1")).not.toThrow();
    expect(() => assertSafeUrl("http://172.32.0.1")).not.toThrow();
  });

  it("blocks link-local and metadata endpoints", () => {
    expect(() => assertSafeUrl("http://169.254.169.254/latest/meta-data")).toThrow("internal");
    expect(() => assertSafeUrl("http://169.254.0.1")).toThrow("internal");
  });

  // --- Blocked IPv6 ---
  it("blocks IPv6 loopback and private", () => {
    expect(() => assertSafeUrl("http://[::1]")).toThrow("internal");
    expect(() => assertSafeUrl("http://[fe80::1]")).toThrow("internal");
    expect(() => assertSafeUrl("http://[fc00::1]")).toThrow("internal");
    expect(() => assertSafeUrl("http://[fd12::1]")).toThrow("internal");
    expect(() => assertSafeUrl("http://[fdaa::1]")).toThrow("internal");
  });

  // --- Blocked special hostnames ---
  it("blocks metadata hostnames", () => {
    expect(() => assertSafeUrl("http://metadata.google.internal")).toThrow("internal");
  });

  it("blocks .internal TLD", () => {
    expect(() => assertSafeUrl("http://service.internal")).toThrow("internal");
  });

  // --- Invalid URLs ---
  it("throws on invalid URL strings", () => {
    expect(() => assertSafeUrl("not-a-url")).toThrow();
  });
});
