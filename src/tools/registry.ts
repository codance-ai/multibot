import type { ToolSet } from "ai";
import { webFetchTool } from "./web-fetch";

const ALL_TOOLS: ToolSet = {
  web_fetch: webFetchTool,
};

export function getTools(): ToolSet {
  return { ...ALL_TOOLS };
}

export function mergeTools(...toolSets: ToolSet[]): ToolSet {
  const merged: ToolSet = {};
  for (const ts of toolSets) {
    Object.assign(merged, ts);
  }
  return merged;
}
