/**
 * Admin sandbox tools — access other bots' sandboxes for inspection and management.
 */

import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import * as configDb from "../../db/config";
import { guardCommand } from "../exec";
import { validateSpritePath } from "../sprites-sandbox";
import type { AdminToolDeps } from "./utils";

const MAX_OUTPUT_CHARS = 10_000;

function truncateOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  const remaining = text.length - MAX_OUTPUT_CHARS;
  return text.slice(0, MAX_OUTPUT_CHARS) + `\n... (truncated, ${remaining} more chars)`;
}

export function createSandboxAdminTools(deps: AdminToolDeps): ToolSet {
  const { db, ownerId, getSandboxClient } = deps;

  if (!getSandboxClient) return {};

  return {
    sandbox_exec: tool({
      description:
        "Execute a shell command in another bot's sandbox. Use for diagnostics, inspecting installed packages, checking logs, etc.",
      inputSchema: z.object({
        botId: z.string().describe("Target bot ID"),
        command: z.string().describe("Shell command to execute"),
        timeout: z
          .number()
          .optional()
          .describe("Timeout in seconds (default 30, max 120)"),
      }),
      execute: async ({ botId, command, timeout }) => {
        try {
          const bot = await configDb.getBot(db, ownerId, botId);
          if (!bot) return `Bot not found: ${botId}`;

          const blocked = guardCommand(command);
          if (blocked) return `Command blocked by safety filter: ${blocked}`;

          const sandbox = getSandboxClient(botId);
          const timeoutMs = Math.min((timeout ?? 30) * 1000, 120_000);
          const result = await sandbox.exec(command, { timeout: timeoutMs });

          const parts: string[] = [];
          if (result.stdout) parts.push(truncateOutput(result.stdout));
          if (result.stderr) parts.push(`STDERR:\n${truncateOutput(result.stderr)}`);
          parts.push(`Exit code: ${result.exitCode}`);
          return parts.join("\n");
        } catch (err) {
          return `Failed to exec in sandbox: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    sandbox_read_file: tool({
      description:
        "Read a file from another bot's sandbox. Returns file content as text.",
      inputSchema: z.object({
        botId: z.string().describe("Target bot ID"),
        path: z.string().describe("Absolute file path to read"),
        maxLength: z
          .number()
          .optional()
          .describe("Max characters to return (default 10000)"),
      }),
      execute: async ({ botId, path, maxLength }) => {
        try {
          const bot = await configDb.getBot(db, ownerId, botId);
          if (!bot) return `Bot not found: ${botId}`;

          if (!validateSpritePath(path)) return `Invalid path: ${path}`;

          const sandbox = getSandboxClient(botId);
          const content = await sandbox.readFile(path);

          const limit = maxLength ?? MAX_OUTPUT_CHARS;
          if (content.length > limit) {
            return content.slice(0, limit) + `\n... (truncated, total ${content.length} chars)`;
          }
          return content || "(empty file)";
        } catch (err) {
          return `Failed to read file: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    sandbox_write_file: tool({
      description:
        "Write content to a file in another bot's sandbox. Creates parent directories if needed.",
      inputSchema: z.object({
        botId: z.string().describe("Target bot ID"),
        path: z.string().describe("Absolute file path to write"),
        content: z.string().describe("File content to write"),
      }),
      execute: async ({ botId, path, content }) => {
        try {
          const bot = await configDb.getBot(db, ownerId, botId);
          if (!bot) return `Bot not found: ${botId}`;

          if (!validateSpritePath(path)) return `Invalid path: ${path}`;

          const sandbox = getSandboxClient(botId);
          await sandbox.writeFile(path, content);
          return `Written ${content.length} chars to ${path} in ${bot.name}'s sandbox.`;
        } catch (err) {
          return `Failed to write file: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    sandbox_list_files: tool({
      description:
        "List files and directories in another bot's sandbox.",
      inputSchema: z.object({
        botId: z.string().describe("Target bot ID"),
        path: z
          .string()
          .optional()
          .describe("Directory path to list (default: /home/sprite)"),
      }),
      execute: async ({ botId, path }) => {
        try {
          const bot = await configDb.getBot(db, ownerId, botId);
          if (!bot) return `Bot not found: ${botId}`;

          const dirPath = path ?? "/home/sprite";
          if (!validateSpritePath(dirPath)) return `Invalid path: ${dirPath}`;

          const sandbox = getSandboxClient(botId);
          const result = await sandbox.exec(`ls -la ${dirPath}`);

          if (!result.success) {
            return result.stderr || `Failed to list: exit code ${result.exitCode}`;
          }
          return truncateOutput(result.stdout) || "(empty directory)";
        } catch (err) {
          return `Failed to list files: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),
  };
}
