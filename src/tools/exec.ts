import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import { getSandboxPaths, type SandboxClient } from "./sandbox-types";
import type { EnsureSkillReady } from "../skills/ensure-ready";
import { extractSkillNameFromCommand } from "../skills/ensure-ready";
import type { MaterializationEngine } from "../skills/materialize";
import { contentHash } from "../skills/materialize";
import { parseImageReferences } from "../utils/media";

const MAX_OUTPUT_CHARS = 10_000;
const DEFAULT_TIMEOUT = 60;

/**
 * Dangerous command patterns (from nanobot).
 * Case-insensitive regex matching against the full command string.
 */
const DENY_PATTERNS: RegExp[] = [
  /\brm\s+-[rf]{1,2}\b/i,
  /\bdel\s+\/[fq]\b/i,
  /\brmdir\s+\/s\b/i,
  /(?:^|[;&|]\s*)format\b/i,
  /\b(mkfs|diskpart)\b/i,
  /\bdd\s+if=/i,
  />\s*\/dev\/sd/i,
  /\b(shutdown|reboot|poweroff)\b/i,
  /:\(\)\s*\{.*\};\s*:/i,
];

/**
 * Check a command against deny patterns.
 * Returns the matched pattern description if blocked, or null if safe.
 */
export function guardCommand(command: string): string | null {
  for (const pattern of DENY_PATTERNS) {
    if (pattern.test(command)) {
      return pattern.source;
    }
  }
  return null;
}

function truncateOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  const remaining = text.length - MAX_OUTPUT_CHARS;
  return text.slice(0, MAX_OUTPUT_CHARS) + `\n... (truncated, ${remaining} more chars)`;
}

function redactSecrets(text: string, secrets: Record<string, string>): string {
  let result = text;
  for (const value of Object.values(secrets)) {
    if (value.length >= 4) {  // Only redact non-trivial values
      result = result.replaceAll(value, "[REDACTED]");
    }
  }
  return result;
}

export function createExecTools(
  sandbox: SandboxClient,
  skillSecrets?: Record<string, string>,
  ensureSkillReady?: EnsureSkillReady,
  materialize?: MaterializationEngine,
  builtinAssets?: Record<string, string>,
  onOutput?: (rawOutput: string) => Promise<string>,
): ToolSet {
  return {
    exec: tool({
      description:
        "Execute a shell command in a sandboxed environment. Use for running scripts, installing packages, git operations, and other CLI tasks.",
      inputSchema: z.object({
        command: z.string().describe("The shell command to execute"),
        working_dir: z
          .string()
          .optional()
          .describe("Working directory for the command (default: /workspace)"),
        env: z
          .record(z.string())
          .optional()
          .describe("Environment variables to set for the command"),
        stdin: z
          .string()
          .optional()
          .describe(
            "Text to pipe to the command via standard input. Use this to pass large text data (e.g. prompts, file contents) to scripts safely."
          ),
      }),
      execute: async ({ command, working_dir, env, stdin }) => {
        const execStart = Date.now();
        const shortCmd = command.length > 80 ? command.slice(0, 80) + "..." : command;
        console.log(`[exec] start: ${shortCmd}`);

        // Safety guard
        const blocked = guardCommand(command);
        if (blocked) {
          console.log(`[exec] blocked (${Date.now() - execStart}ms): ${shortCmd}`);
          return "Error: Command blocked by safety guard (dangerous pattern detected).";
        }

        // Materialize builtin skill scripts if command references them
        if (materialize && builtinAssets) {
          for (const [assetPath, assetContent] of Object.entries(builtinAssets)) {
            if (command.includes(assetPath) || (working_dir ?? "").includes(assetPath.split("/").slice(0, -1).join("/"))) {
              try {
                const hash = contentHash(assetContent);
                await materialize.ensure(`builtin:${assetPath}`, hash, async () => {
                  const dir = assetPath.split("/").slice(0, -1).join("/");
                  await sandbox.mkdir(dir, { recursive: true });
                  await sandbox.writeFile(assetPath, assetContent);
                });
              } catch (err) {
                console.warn(`[exec] builtin asset materialization failed for ${assetPath}:`, err);
              }
            }
          }
        }

        // Trigger lazy hydration if command references installed skills
        if (ensureSkillReady) {
          const skillName = extractSkillNameFromCommand(working_dir ?? "")
            ?? extractSkillNameFromCommand(command);
          if (skillName) {
            try {
              await ensureSkillReady(skillName);
            } catch (err) {
              console.log(`[exec] skill hydration failed (${Date.now() - execStart}ms): ${shortCmd}`);
              return `Error: Skill "${skillName}" is not available: ${err instanceof Error ? err.message : String(err)}`;
            }
          }
        }

        try {
          // Build command with optional stdin pipe and working_dir
          let fullCommand = command;
          const execEnv: Record<string, string> = { ...skillSecrets, ...env };

          if (stdin != null && stdin !== "") {
            // Pipe stdin via env var + printenv (safe, no shell expansion)
            execEnv.__EXEC_STDIN__ = stdin;
            fullCommand = `printenv __EXEC_STDIN__ | ${fullCommand}`;
          }

          if (working_dir) {
            const safePath = working_dir.replace(/'/g, "'\\''");
            fullCommand = `cd '${safePath}' && ${fullCommand}`;
          }

          // Set up persistent install environment so all package installs
          // land under homeLocal and survive sandbox restarts.
          const paths = getSandboxPaths();
          fullCommand = [
            `export PATH=${paths.homeBin}:$PATH`,
            `export NPM_CONFIG_PREFIX=${paths.homeLocal}`,
            `export PYTHONUSERBASE=${paths.homeLocal}`,
            "export PIP_USER=1",
            "export PIP_CACHE_DIR=/tmp/cache/pip",
            "export npm_config_cache=/tmp/cache/npm",
            `export NODE_PATH=${paths.homeLocal}/lib/node_modules:\${NODE_PATH:-}`,
            fullCommand,
          ].join("; ");

          const execOpts: { env?: Record<string, string>; timeout?: number } = {
            timeout: DEFAULT_TIMEOUT * 1000,
          };
          if (Object.keys(execEnv).length > 0) execOpts.env = execEnv;

          const result = await sandbox.exec(fullCommand, execOpts);

          // Build output matching nanobot format
          let output = result.stdout;
          if (result.stderr) {
            output += (output ? "\n" : "") + `STDERR:\n${result.stderr}`;
          }
          if (result.exitCode !== 0) {
            output += (output ? "\n" : "") + `Exit code: ${result.exitCode}`;
          }

          if (!output) {
            console.log(`[exec] done (${Date.now() - execStart}ms): ${shortCmd}`);
            return result.exitCode === 0
              ? "(no output)"
              : `Exit code: ${result.exitCode}`;
          }

          if (skillSecrets && Object.keys(skillSecrets).length > 0) {
            output = redactSecrets(output, skillSecrets);
          }

          // Resolve workspace images while sprite is still warm
          let resolvedImageRefs: string[] = [];
          if (onOutput) {
            try {
              output = await onOutput(output);
            } catch (e) {
              console.warn("[exec] onOutput interceptor failed:", e);
            }

            // Extract resolved image refs before truncation (to re-append if lost)
            resolvedImageRefs = parseImageReferences(output)
              .filter(r => r.path.startsWith("/media/"))
              .map(r => r.fullMatch);
          }

          console.log(`[exec] done (${Date.now() - execStart}ms): ${shortCmd}`);
          output = truncateOutput(output);

          // Re-append image refs lost to truncation
          if (resolvedImageRefs.length > 0) {
            const lostRefs = resolvedImageRefs.filter(ref => !output.includes(ref));
            if (lostRefs.length > 0) {
              output += "\n" + lostRefs.join("\n");
            }
          }

          return output;
        } catch (error: any) {
          console.log(`[exec] error (${Date.now() - execStart}ms): ${shortCmd}`);
          if (
            error?.message?.includes("timeout") ||
            error?.message?.includes("timed out")
          ) {
            throw new Error(`Command timed out after ${DEFAULT_TIMEOUT} seconds`);
          }
          throw new Error(`Error executing command: ${error?.message ?? String(error)}`);
        }
      },
    }),
  };
}
