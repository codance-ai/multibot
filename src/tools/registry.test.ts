import { describe, it, expect } from "vitest";
import { getTools, mergeTools } from "./registry";

describe("getTools", () => {
  it("returns all built-in tools including web_fetch", () => {
    const tools = getTools();
    expect(tools).toHaveProperty("web_fetch");
  });
});

describe("mergeTools", () => {
  it("merges multiple tool sets", () => {
    const a = { tool_a: {} as any };
    const b = { tool_b: {} as any };
    const merged = mergeTools(a, b);
    expect(merged).toHaveProperty("tool_a");
    expect(merged).toHaveProperty("tool_b");
  });

  it("later sets override earlier ones", () => {
    const a = { tool: { name: "old" } as any };
    const b = { tool: { name: "new" } as any };
    const merged = mergeTools(a, b);
    expect((merged.tool as any).name).toBe("new");
  });

  it("handles empty input", () => {
    expect(Object.keys(mergeTools())).toHaveLength(0);
  });
});
