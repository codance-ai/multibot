import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import {
  getMemory,
  upsertMemory,
  insertHistoryEntry,
  getHistoryEntries,
  searchHistoryEntries,
} from "../db/d1";

const MEMORY_FILES = z
  .enum(["MEMORY.md", "HISTORY.md"])
  .describe("Which memory file to access");

export function createMemoryTools(
  db: D1Database,
  botId: string
): ToolSet {
  return {
    memory_read: tool({
      description:
        "Read a memory file. MEMORY.md is already in your system prompt — only call this right before editing to get the latest version. Use for HISTORY.md to review past events.",
      inputSchema: z.object({ file: MEMORY_FILES }),
      execute: async ({ file }) => {
        if (file === "MEMORY.md") {
          const content = await getMemory(db, botId);
          return content || "(empty)";
        }
        // HISTORY.md
        const entries = await getHistoryEntries(db, botId, 100);
        if (entries.length === 0) return "(empty)";
        return entries.map((e) => e.content).join("\n\n");
      },
    }),

    memory_write: tool({
      description:
        "Overwrite a memory file completely. Only use when MEMORY.md is empty or needs a full rewrite. Prefer memory_edit for partial updates. Do NOT use on HISTORY.md (use memory_append instead). Save: user preferences, personality traits, relationships, ongoing plans, rules, or anything the user asks you to remember. Do NOT save: tool usage, skill instructions, system capabilities, or technical implementation details — these come from skills and update with deployments.",
      inputSchema: z.object({
        file: MEMORY_FILES,
        content: z.string().describe("The complete new content for the file"),
      }),
      execute: async ({ file, content }) => {
        if (file === "HISTORY.md") {
          return "Cannot overwrite HISTORY.md directly. Use memory_append to add entries.";
        }
        await upsertMemory(db, botId, content);
        return `Written ${content.length} characters to ${file}`;
      },
    }),

    memory_append: tool({
      description:
        "Append a line to a memory file. Primarily used for adding entries to HISTORY.md.",
      inputSchema: z.object({
        file: MEMORY_FILES,
        content: z.string().describe("The content to append"),
      }),
      execute: async ({ file, content }) => {
        if (file === "HISTORY.md") {
          await insertHistoryEntry(db, botId, content);
          return `Appended to HISTORY.md`;
        }
        // MEMORY.md: read-modify-write
        const existing = await getMemory(db, botId);
        const updated = existing ? `${existing}\n${content}` : content;
        await upsertMemory(db, botId, updated);
        return `Appended to ${file}`;
      },
    }),

    memory_edit: tool({
      description:
        "Edit a memory file by replacing a specific string. Preferred over memory_write — only changes the matched part, avoiding accidental data loss. Fails if old_string is not found or matches multiple places. Do NOT save: tool usage, skill instructions, system capabilities, or technical implementation details — these come from skills and update with deployments.",
      inputSchema: z.object({
        file: MEMORY_FILES,
        old_string: z.string().describe("The exact text to find and replace"),
        new_string: z.string().describe("The replacement text"),
      }),
      execute: async ({ file, old_string, new_string }) => {
        if (file === "HISTORY.md") {
          return "Cannot edit individual HISTORY.md entries. History entries are immutable log records.";
        }
        const content = await getMemory(db, botId);
        if (!content) return `Cannot edit: ${file} is empty.`;
        const count = content.split(old_string).length - 1;
        if (count === 0)
          return `old_string not found in ${file}. Use memory_read to check current content.`;
        if (count > 1)
          return `old_string found ${count} times in ${file}. Provide more surrounding context to make it unique.`;
        const updated = content.replace(old_string, new_string);
        await upsertMemory(db, botId, updated);
        return `Edited ${file}: replaced ${old_string.length} chars with ${new_string.length} chars.`;
      },
    }),

    memory_grep: tool({
      description:
        "Search a memory file for lines containing a keyword. Returns matching lines. Useful for searching HISTORY.md for past events.",
      inputSchema: z.object({
        file: MEMORY_FILES,
        query: z.string().describe("The search keyword or phrase"),
      }),
      execute: async ({ file, query }) => {
        if (file === "HISTORY.md") {
          const results = await searchHistoryEntries(db, botId, query);
          if (results.length === 0) return `No matches for "${query}"`;
          return results.map((e) => e.content).join("\n\n");
        }
        // MEMORY.md: line-by-line search
        const content = await getMemory(db, botId);
        if (!content) return "No matches (file is empty)";
        const lines = content.split("\n");
        const matches = lines.filter((line) =>
          line.toLowerCase().includes(query.toLowerCase())
        );
        if (matches.length === 0) return `No matches for "${query}"`;
        return matches.join("\n");
      },
    }),
  };
}
