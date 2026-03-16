import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import type { SandboxClient } from "./sandbox-types";
import type { MaterializationEngine } from "../skills/materialize";
import { contentHash } from "../skills/materialize";

/**
 * Build a helpful message when edit_file's old_text is not found.
 * Uses multi-line sliding window matching and unified diff output.
 * Aligned with nanobot's edit_file diff hint behavior.
 */
export function buildNotFoundMessage(
  oldText: string,
  content: string,
  path: string
): string {
  const contentLines = content.split("\n");
  const oldLines = oldText.split("\n");
  const window = oldLines.length;

  // Sliding window: compare old_text block against each position in file
  let bestRatio = 0;
  let bestStart = 0;

  for (let i = 0; i <= Math.max(0, contentLines.length - window); i++) {
    const candidate = contentLines.slice(i, i + window);
    const ratio = sequenceRatio(oldLines, candidate);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      bestStart = i;
    }
  }

  if (bestRatio > 0.5) {
    const actualLines = contentLines.slice(bestStart, bestStart + window);
    const diff = unifiedDiff(oldLines, actualLines, "old_text (provided)", `${path} (actual, line ${bestStart + 1})`);
    return `Error: old_text not found in ${path}.\nBest match (${Math.round(bestRatio * 100)}% similar) at line ${bestStart + 1}:\n${diff}`;
  }

  return `Error: old_text not found in ${path}. No similar text found. Verify the file content.`;
}

/**
 * Approximate SequenceMatcher.ratio() — compares two string arrays.
 * Uses character-level similarity per line pair, then averages.
 * Returns a ratio 0-1 of how similar they are.
 */
function sequenceRatio(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const maxLen = Math.max(a.length, b.length);
  let totalSim = 0;
  for (let i = 0; i < maxLen; i++) {
    const lineA = i < a.length ? a[i] : "";
    const lineB = i < b.length ? b[i] : "";
    totalSim += charSimilarity(lineA, lineB);
  }
  return totalSim / maxLen;
}

/**
 * Character-level similarity ratio (0-1) between two strings.
 */
function charSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const longer = a.length >= b.length ? a : b;
  const shorter = a.length < b.length ? a : b;

  let matches = 0;
  const used = new Set<number>();
  for (const ch of shorter) {
    for (let j = 0; j < longer.length; j++) {
      if (!used.has(j) && longer[j] === ch) {
        matches++;
        used.add(j);
        break;
      }
    }
  }
  return (2 * matches) / (a.length + b.length);
}

/**
 * Simple unified diff output for two string arrays.
 */
function unifiedDiff(
  expected: string[],
  actual: string[],
  fromLabel: string,
  toLabel: string
): string {
  const lines: string[] = [];
  lines.push(`--- ${fromLabel}`);
  lines.push(`+++ ${toLabel}`);

  // Simple line-by-line diff (not full LCS, but good enough for LLM hints)
  const maxLen = Math.max(expected.length, actual.length);
  for (let i = 0; i < maxLen; i++) {
    const exp = i < expected.length ? expected[i] : undefined;
    const act = i < actual.length ? actual[i] : undefined;

    if (exp === act) {
      lines.push(` ${exp}`);
    } else {
      if (exp !== undefined) lines.push(`-${exp}`);
      if (act !== undefined) lines.push(`+${act}`);
    }
  }
  return lines.join("\n");
}

function parentDir(path: string): string {
  const parts = path.split("/");
  parts.pop();
  return parts.join("/") || "/";
}

export function createFilesystemTools(
  sandbox: SandboxClient,
  materialize?: MaterializationEngine,
  builtinAssets?: Record<string, string>,
): ToolSet {
  async function ensureBuiltinAssets(path: string): Promise<void> {
    if (!materialize || !builtinAssets) return;
    for (const [assetPath, assetContent] of Object.entries(builtinAssets)) {
      if (path.startsWith(assetPath.split("/").slice(0, -1).join("/") + "/") || path === assetPath) {
        try {
          const hash = contentHash(assetContent);
          await materialize.ensure(`builtin:${assetPath}`, hash, async () => {
            const dir = assetPath.split("/").slice(0, -1).join("/");
            await sandbox.mkdir(dir, { recursive: true });
            await sandbox.writeFile(assetPath, assetContent);
          });
        } catch (err) {
          console.warn(`[filesystem] builtin asset materialization failed:`, err);
        }
      }
    }
  }

  return {
    read_file: tool({
      description: "Read the contents of a file in the sandbox.",
      inputSchema: z.object({
        path: z.string().describe("Absolute path to the file to read"),
      }),
      execute: async ({ path }) => {
        try {
          await ensureBuiltinAssets(path);
          const check = await sandbox.exists(path);
          if (!check.exists) {
            return `Error: File not found: ${path}`;
          }
          return await sandbox.readFile(path);
        } catch (error: any) {
          throw new Error(`Error reading file: ${error?.message ?? String(error)}`);
        }
      },
    }),

    write_file: tool({
      description:
        "Write content to a file in the sandbox. Creates parent directories automatically.",
      inputSchema: z.object({
        path: z.string().describe("Absolute path to the file to write"),
        content: z.string().describe("Content to write to the file"),
      }),
      execute: async ({ path, content }) => {
        try {
          // Ensure parent directory exists
          const parent = parentDir(path);
          if (parent && parent !== "/") {
            await sandbox.mkdir(parent, { recursive: true });
          }
          await sandbox.writeFile(path, content);
          const bytes = new TextEncoder().encode(content).length;
          return `Successfully wrote ${bytes} bytes to ${path}`;
        } catch (error: any) {
          throw new Error(`Error writing file: ${error?.message ?? String(error)}`);
        }
      },
    }),

    edit_file: tool({
      description:
        "Edit a file by replacing exact text. Provide the exact text to find and what to replace it with.",
      inputSchema: z.object({
        path: z.string().describe("Absolute path to the file to edit"),
        old_text: z.string().describe("Exact text to find in the file"),
        new_text: z.string().describe("Text to replace old_text with"),
      }),
      execute: async ({ path, old_text, new_text }) => {
        try {
          const check = await sandbox.exists(path);
          if (!check.exists) {
            return `Error: File not found: ${path}`;
          }

          const content = await sandbox.readFile(path);

          // Count occurrences
          const occurrences = content.split(old_text).length - 1;

          if (occurrences === 0) {
            return buildNotFoundMessage(old_text, content, path);
          }

          if (occurrences > 1) {
            return `Error: old_text found ${occurrences} times in ${path}. Please provide more context to make the match unique.`;
          }

          // Exactly one match — replace
          const newContent = content.replace(old_text, new_text);
          await sandbox.writeFile(path, newContent);
          return `Successfully edited ${path}`;
        } catch (error: any) {
          throw new Error(`Error editing file: ${error?.message ?? String(error)}`);
        }
      },
    }),

    list_dir: tool({
      description: "List files and directories in a sandbox path.",
      inputSchema: z.object({
        path: z
          .string()
          .default("/workspace")
          .describe(
            "Absolute path to the directory to list (default: /workspace)"
          ),
      }),
      execute: async ({ path }) => {
        try {
          await ensureBuiltinAssets(path);
          const result = await sandbox.exec(`ls -la ${path}`);
          if (!result.success) {
            throw new Error(`Error listing directory: ${result.stderr || `Exit code ${result.exitCode}`}`);
          }
          return result.stdout || "(empty directory)";
        } catch (error: any) {
          if (error?.message?.startsWith("Error listing directory")) throw error;
          throw new Error(`Error listing directory: ${error?.message ?? String(error)}`);
        }
      },
    }),
  };
}
