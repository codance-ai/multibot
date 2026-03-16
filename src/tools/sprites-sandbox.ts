/**
 * Sprites (Fly.io) sandbox client implementation.
 *
 * Uses Sprites REST exec (argv mode) for simple operations (readFile, exists, mkdir)
 * and WebSocket exec for interactive commands with stdout/stderr separation.
 * File writes use WebSocket stdin piping via `cat > /path`.
 */
import type { SandboxClient } from "./sandbox-types";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SpritesClientConfig {
  token: string;
  spriteName: string;
  baseUrl?: string; // default: "https://api.sprites.dev"
}

function resolveBase(config: SpritesClientConfig): string {
  return (config.baseUrl ?? "https://api.sprites.dev").replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

export function validateSpritePath(path: string): boolean {
  if (!path || path.length === 0) return false;
  if (!path.startsWith("/")) return false;
  if (path.includes("\0")) return false;
  if (path.includes("..")) return false;
  return true;
}

/** Shell-safe single-quote a value: wrap in '' and escape embedded quotes. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function assertValidPath(path: string): void {
  if (!validateSpritePath(path)) {
    throw new Error(`Invalid path: ${JSON.stringify(path)}`);
  }
}

// ---------------------------------------------------------------------------
// Binary frame helpers
// ---------------------------------------------------------------------------

export enum StreamID {
  Stdin = 0,
  Stdout = 1,
  Stderr = 2,
  Exit = 3,
  StdinEOF = 4,
}

/**
 * Parse a binary exec frame: `[StreamID(1 byte)][payload]`.
 * Returns raw bytes to avoid cross-frame UTF-8 corruption.
 */
export function parseExecFrame(data: Uint8Array): {
  stream: StreamID;
  payload: Uint8Array;
} {
  if (data.length === 0) {
    throw new Error("Empty frame");
  }
  const stream = data[0] as StreamID;
  const payload = data.subarray(1);
  return { stream, payload };
}

/** Encode string to UTF-8 and prepend StreamID.Stdin byte. */
export function buildStdinFrame(content: string): Uint8Array {
  const encoded = new TextEncoder().encode(content);
  return buildStdinFrameBytes(encoded);
}

/** Prepend StreamID.Stdin byte to raw bytes. */
export function buildStdinFrameBytes(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(1 + payload.length);
  frame[0] = StreamID.Stdin;
  frame.set(payload, 1);
  return frame;
}

/** Returns a single-byte StdinEOF frame. */
export function buildStdinEOFFrame(): Uint8Array {
  return new Uint8Array([StreamID.StdinEOF]);
}

// ---------------------------------------------------------------------------
// Sprite lifecycle
// ---------------------------------------------------------------------------

/** Check if sprite exists via GET, create via POST if not. Race-safe. */
export async function ensureSpriteExists(
  config: SpritesClientConfig
): Promise<void> {
  const base = resolveBase(config);
  const url = `${base}/v1/sprites/${config.spriteName}`;

  const getResp = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${config.token}` },
  });
  if (getResp.ok) return; // already exists

  const postResp = await fetch(`${base}/v1/sprites`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: config.spriteName }),
  });

  if (postResp.ok) return;

  // Handle "already exists" race condition
  const body = await postResp.text();
  if (postResp.status === 409 || body.toLowerCase().includes("already exists")) {
    return;
  }

  throw new Error(
    `Failed to create sprite ${config.spriteName}: ${postResp.status} ${body}`
  );
}

/** DELETE sprite. 404 is OK (already gone). */
export async function destroySprite(
  config: SpritesClientConfig
): Promise<void> {
  const base = resolveBase(config);
  const url = `${base}/v1/sprites/${config.spriteName}`;

  const resp = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${config.token}` },
  });

  if (resp.ok || resp.status === 404) return;

  const body = await resp.text();
  throw new Error(
    `Failed to destroy sprite ${config.spriteName}: ${resp.status} ${body}`
  );
}

const HEALTH_PING_TIMEOUT = 10_000; // 10 seconds

/**
 * Lightweight health probe — run `true` via WebSocket exec to verify the
 * sprite can actually execute commands (not just "exist" in the API).
 */
export async function healthPingSprite(
  config: SpritesClientConfig,
  timeoutMs = HEALTH_PING_TIMEOUT
): Promise<boolean> {
  try {
    const result = await wsExec(config, "true", timeoutMs);
    return result.exitCode === 0;
  } catch (err) {
    console.warn(`[sprites] health ping failed for ${config.spriteName}:`, err);
    return false;
  }
}

/**
 * Ensure sprite exists AND is responsive.
 * 1. ensureSpriteExists (create if needed)
 * 2. Health ping (run `true` via WS exec)
 * 3. If ping fails → destroy → recreate → re-ping
 * 4. If re-ping fails → throw
 */
export async function ensureSpriteHealthy(
  config: SpritesClientConfig
): Promise<void> {
  await ensureSpriteExists(config);

  if (await healthPingSprite(config)) return;

  console.warn(`[sprites] ${config.spriteName} is unresponsive, rebuilding...`);
  await destroySprite(config);
  await ensureSpriteExists(config);

  if (await healthPingSprite(config)) return;

  throw new Error(
    `Sprite ${config.spriteName} is unresponsive after rebuild`
  );
}

// ---------------------------------------------------------------------------
// REST exec (argv mode) — simple commands without stdout/stderr separation
// ---------------------------------------------------------------------------

async function restExecArgv(
  config: SpritesClientConfig,
  argv: string[]
): Promise<string> {
  const base = resolveBase(config);
  const params = new URLSearchParams();
  for (const arg of argv) {
    params.append("cmd", arg);
  }
  const url = `${base}/v1/sprites/${config.spriteName}/exec?${params.toString()}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.token}` },
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`REST exec failed (${resp.status}): ${body}`);
  }

  return resp.text();
}

// ---------------------------------------------------------------------------
// WebSocket exec — full command with stdout/stderr/exitCode
// ---------------------------------------------------------------------------

const WS_CHUNK_SIZE = 64 * 1024; // 64 KB

async function wsExec(
  config: SpritesClientConfig,
  command: string,
  timeoutMs: number
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const base = resolveBase(config);
  const params = new URLSearchParams();
  params.append("cmd", "bash");
  params.append("cmd", "-lc");
  params.append("cmd", command);
  // Workers need http(s) URL with Upgrade header
  const url = `${base}/v1/sprites/${config.spriteName}/exec?${params.toString()}`;

  const resp = await fetch(url, {
    headers: {
      Upgrade: "websocket",
      Authorization: `Bearer ${config.token}`,
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ws = (resp as any).webSocket;
  if (!ws) {
    throw new Error("WebSocket upgrade failed — no webSocket on response");
  }
  ws.accept();

  return new Promise<{ stdout: string; stderr: string; exitCode: number }>(
    (resolve, reject) => {
      // Streaming decoders to handle multi-byte chars split across frames
      const stdoutDecoder = new TextDecoder("utf-8");
      const stderrDecoder = new TextDecoder("utf-8");
      let stdout = "";
      let stderr = "";
      let exitCode = -1;

      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch (e) {
          console.warn("[sprites-ws] failed to close WebSocket on timeout:", e);
        }
        reject(new Error(`WebSocket exec timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      ws.addEventListener("message", (event: MessageEvent) => {
        const data = event.data;
        if (typeof data === "string") {
          // Text frame: JSON with exit_code
          try {
            const parsed = JSON.parse(data);
            if (parsed.exit_code !== undefined) {
              exitCode = parsed.exit_code;
            }
          } catch {
            console.warn("[sprites-ws] non-JSON text frame:", data);
          }
        } else if (data instanceof ArrayBuffer) {
          const frame = parseExecFrame(new Uint8Array(data));
          if (frame.stream === StreamID.Stdout) {
            stdout += stdoutDecoder.decode(frame.payload, { stream: true });
          } else if (frame.stream === StreamID.Stderr) {
            stderr += stderrDecoder.decode(frame.payload, { stream: true });
          }
        }
      });

      ws.addEventListener("close", () => {
        // Flush remaining bytes in streaming decoders
        stdout += stdoutDecoder.decode(undefined, { stream: false });
        stderr += stderrDecoder.decode(undefined, { stream: false });
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode });
      });

      ws.addEventListener("error", (err: Event) => {
        clearTimeout(timer);
        reject(new Error(`WebSocket error: ${err}`));
      });
    }
  );
}

// ---------------------------------------------------------------------------
// WebSocket writeFile via stdin pipe
// ---------------------------------------------------------------------------

async function wsWriteFile(
  config: SpritesClientConfig,
  path: string,
  content: string,
  encoding?: string
): Promise<void> {
  // Ensure parent directory exists
  const parentDir = path.substring(0, path.lastIndexOf("/")) || "/";
  if (parentDir !== "/") {
    await restExecArgv(config, ["mkdir", "-p", "--", parentDir]);
  }

  const escapedPath = shellQuote(path);

  // Always use `cat >` — content bytes are already decoded on the Worker side.
  // (When encoding=base64, atob() runs before WebSocket send.)
  const shellCmd = `cat > ${escapedPath}`;

  const base = resolveBase(config);
  const params = new URLSearchParams();
  params.append("cmd", "bash");
  params.append("cmd", "-lc");
  params.append("cmd", shellCmd);
  params.append("stdin", "true");
  const url = `${base}/v1/sprites/${config.spriteName}/exec?${params.toString()}`;

  const resp = await fetch(url, {
    headers: {
      Upgrade: "websocket",
      Authorization: `Bearer ${config.token}`,
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ws = (resp as any).webSocket;
  if (!ws) {
    throw new Error("WebSocket upgrade failed for writeFile");
  }
  ws.accept();

  // Convert content to bytes FIRST, then chunk by bytes (not string chars)
  const useBase64 = encoding === "base64";
  let contentBytes: Uint8Array;
  if (useBase64) {
    // base64 string -> raw bytes via atob
    const raw = atob(content);
    contentBytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
      contentBytes[i] = raw.charCodeAt(i);
    }
  } else {
    contentBytes = new TextEncoder().encode(content);
  }

  // Send data IMMEDIATELY after accept — Workers WebSocket doesn't fire "open" event
  for (let offset = 0; offset < contentBytes.length; offset += WS_CHUNK_SIZE) {
    const chunk = contentBytes.subarray(
      offset,
      Math.min(offset + WS_CHUNK_SIZE, contentBytes.length)
    );
    ws.send(buildStdinFrameBytes(chunk));
  }

  // Signal end of stdin
  ws.send(buildStdinEOFFrame());

  // Wait for close & check exit code
  return new Promise<void>((resolve, reject) => {
    let exitCode = -1;

    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch (e) {
        console.warn("[sprites-ws] failed to close WebSocket on writeFile timeout:", e);
      }
      reject(new Error(`writeFile timed out after ${DEFAULT_EXEC_TIMEOUT}ms`));
    }, DEFAULT_EXEC_TIMEOUT);

    ws.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data === "string") {
        try {
          const parsed = JSON.parse(event.data);
          if (parsed.exit_code !== undefined) {
            exitCode = parsed.exit_code;
          }
        } catch (e) {
          console.warn("[sprites-ws] non-JSON text frame in writeFile:", e);
        }
      }
    });

    ws.addEventListener("close", () => {
      clearTimeout(timer);
      if (exitCode !== 0 && exitCode !== -1) {
        reject(new Error(`writeFile failed with exit code ${exitCode}`));
      } else {
        resolve();
      }
    });

    ws.addEventListener("error", (err: Event) => {
      clearTimeout(timer);
      reject(new Error(`writeFile WebSocket error: ${err}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const DEFAULT_EXEC_TIMEOUT = 30_000; // 30 seconds

/**
 * Create a SandboxClient backed by Sprites (Fly.io).
 *
 * @param config - Sprites API configuration
 * @param ensureReady - DO-level lock callback, called before every operation
 */
export function createSpritesSandboxClient(
  config: SpritesClientConfig,
  ensureReady: () => Promise<void>
): SandboxClient {
  return {
    async exec(command, options) {
      await ensureReady();
      const timeout = options?.timeout ?? DEFAULT_EXEC_TIMEOUT;
      // Prepend env vars as export declarations if provided
      let fullCommand = command;
      if (options?.env && Object.keys(options.env).length > 0) {
        const exports = Object.entries(options.env)
          .map(([k, v]) => {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
              throw new Error(`Invalid env key: ${k}`);
            }
            return `export ${k}=${shellQuote(v)}`;
          })
          .join("; ");
        fullCommand = `${exports}; ${command}`;
      }
      const result = await wsExec(config, fullCommand, timeout);
      return {
        success: result.exitCode === 0,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    },

    async readFile(path) {
      assertValidPath(path);
      await ensureReady();
      const result = await wsExec(
        config,
        `cat -- ${shellQuote(path)}`,
        DEFAULT_EXEC_TIMEOUT,
      );
      if (result.exitCode !== 0) {
        throw new Error(`File not found: ${path}`);
      }
      return result.stdout;
    },

    async writeFile(path, content, options) {
      assertValidPath(path);
      await ensureReady();
      await wsWriteFile(config, path, content, options?.encoding);
    },

    async exists(path) {
      assertValidPath(path);
      await ensureReady();
      const result = await wsExec(
        config,
        `test -e ${shellQuote(path)}`,
        DEFAULT_EXEC_TIMEOUT,
      );
      return { exists: result.exitCode === 0 };
    },

    async mkdir(path, options) {
      assertValidPath(path);
      await ensureReady();
      const argv = ["mkdir"];
      if (options?.recursive) argv.push("-p");
      argv.push("--", path);
      await restExecArgv(config, argv);
    },
  };
}
