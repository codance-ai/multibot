/**
 * Sandbox client abstraction.
 * Decouples tool implementations from the sandbox backend for testability (same pattern as CronScheduler).
 *
 * The interface closely matches the SDK's API:
 * - exec(command) returns { success, stdout, stderr, exitCode }
 * - readFile(path) returns the file content as a string
 * - writeFile(path, content, options?) writes content (supports encoding: "base64" for binary)
 * - exists(path) returns { exists: boolean }
 * - mkdir(path, options?) creates directories
 */
export interface SandboxClient {
  exec(command: string, options?: { env?: Record<string, string>; timeout?: number }): Promise<{
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
  }>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string, options?: { encoding?: string }): Promise<void>;
  exists(path: string): Promise<{ exists: boolean }>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
}

export const SANDBOX_HOME = "/home/sprite";

/** Home directory paths for the Sprites sandbox. */
export function getSandboxPaths(): { homeLocal: string; homeBin: string } {
  return {
    homeLocal: `${SANDBOX_HOME}/.local`,
    homeBin: `${SANDBOX_HOME}/.local/bin`,
  };
}
