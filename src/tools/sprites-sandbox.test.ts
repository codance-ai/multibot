import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  validateSpritePath,
  StreamID,
  parseExecFrame,
  buildStdinFrame,
  buildStdinFrameBytes,
  buildStdinEOFFrame,
  ensureSpriteExists,
  destroySprite,
  healthPingSprite,
  ensureSpriteHealthy,
  createSpritesSandboxClient,
} from "./sprites-sandbox";

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

describe("validateSpritePath", () => {
  it("accepts valid absolute paths", () => {
    expect(validateSpritePath("/foo")).toBe(true);
    expect(validateSpritePath("/foo/bar/baz.txt")).toBe(true);
    expect(validateSpritePath("/")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(validateSpritePath("")).toBe(false);
  });

  it("rejects relative paths", () => {
    expect(validateSpritePath("foo/bar")).toBe(false);
    expect(validateSpritePath("./foo")).toBe(false);
  });

  it("rejects paths with null bytes", () => {
    expect(validateSpritePath("/foo\0bar")).toBe(false);
  });

  it("rejects path traversal", () => {
    expect(validateSpritePath("/foo/../etc/passwd")).toBe(false);
    expect(validateSpritePath("/..")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Frame parsing / building
// ---------------------------------------------------------------------------

describe("parseExecFrame", () => {
  it("parses stdout frame", () => {
    const data = new Uint8Array([StreamID.Stdout, 65, 66, 67]); // ABC
    const { stream, payload } = parseExecFrame(data);
    expect(stream).toBe(StreamID.Stdout);
    expect(payload).toEqual(new Uint8Array([65, 66, 67]));
  });

  it("parses stderr frame", () => {
    const data = new Uint8Array([StreamID.Stderr, 69, 82, 82]);
    const { stream, payload } = parseExecFrame(data);
    expect(stream).toBe(StreamID.Stderr);
    expect(payload).toEqual(new Uint8Array([69, 82, 82]));
  });

  it("parses exit frame with empty payload", () => {
    const data = new Uint8Array([StreamID.Exit]);
    const { stream, payload } = parseExecFrame(data);
    expect(stream).toBe(StreamID.Exit);
    expect(payload.length).toBe(0);
  });

  it("throws on empty data", () => {
    expect(() => parseExecFrame(new Uint8Array([]))).toThrow("Empty frame");
  });
});

describe("buildStdinFrame", () => {
  it("encodes string with Stdin prefix", () => {
    const frame = buildStdinFrame("hi");
    expect(frame[0]).toBe(StreamID.Stdin);
    const text = new TextDecoder().decode(frame.subarray(1));
    expect(text).toBe("hi");
  });

  it("handles multi-byte UTF-8", () => {
    const frame = buildStdinFrame("\u4f60\u597d"); // "你好"
    expect(frame[0]).toBe(StreamID.Stdin);
    const text = new TextDecoder().decode(frame.subarray(1));
    expect(text).toBe("\u4f60\u597d");
  });
});

describe("buildStdinFrameBytes", () => {
  it("prepends Stdin byte to raw payload", () => {
    const payload = new Uint8Array([10, 20, 30]);
    const frame = buildStdinFrameBytes(payload);
    expect(frame[0]).toBe(StreamID.Stdin);
    expect(frame.subarray(1)).toEqual(payload);
    expect(frame.length).toBe(4);
  });
});

describe("buildStdinEOFFrame", () => {
  it("returns single StdinEOF byte", () => {
    const frame = buildStdinEOFFrame();
    expect(frame.length).toBe(1);
    expect(frame[0]).toBe(StreamID.StdinEOF);
  });
});

// ---------------------------------------------------------------------------
// StreamID enum values
// ---------------------------------------------------------------------------

describe("StreamID", () => {
  it("has correct numeric values", () => {
    expect(StreamID.Stdin).toBe(0);
    expect(StreamID.Stdout).toBe(1);
    expect(StreamID.Stderr).toBe(2);
    expect(StreamID.Exit).toBe(3);
    expect(StreamID.StdinEOF).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Sprite lifecycle (ensureSpriteExists / destroySprite)
// ---------------------------------------------------------------------------

describe("ensureSpriteExists", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const config = {
    token: "test-token",
    spriteName: "my-sprite",
    baseUrl: "https://api.test.dev",
  };

  it("does nothing if sprite already exists (GET 200)", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await ensureSpriteExists(config);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.test.dev/v1/sprites/my-sprite",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("creates sprite via POST when GET returns 404", async () => {
    mockFetch
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(new Response("", { status: 201 }));

    await ensureSpriteExists(config);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      "https://api.test.dev/v1/sprites",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "my-sprite" }),
      })
    );
  });

  it("handles race condition (409 already exists)", async () => {
    mockFetch
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(
        new Response("already exists", { status: 409 })
      );

    // Should NOT throw
    await ensureSpriteExists(config);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("handles race condition (body contains 'already exists')", async () => {
    mockFetch
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(
        new Response("Sprite already exists", { status: 422 })
      );

    await ensureSpriteExists(config);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws on unexpected POST failure", async () => {
    mockFetch
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(
        new Response("internal error", { status: 500 })
      );

    await expect(ensureSpriteExists(config)).rejects.toThrow(
      "Failed to create sprite"
    );
  });

  it("uses default baseUrl when not provided", async () => {
    const configNoBase = { token: "t", spriteName: "s" };
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await ensureSpriteExists(configNoBase);

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.sprites.dev/v1/sprites/s",
      expect.anything()
    );
  });
});

describe("destroySprite", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const config = {
    token: "test-token",
    spriteName: "my-sprite",
    baseUrl: "https://api.test.dev",
  };

  it("succeeds on 200", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));
    await destroySprite(config);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.test.dev/v1/sprites/my-sprite",
      expect.objectContaining({ method: "DELETE" })
    );
  });

  it("succeeds on 404 (already gone)", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 404 }));
    await destroySprite(config);
  });

  it("throws on unexpected failure", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response("server error", { status: 500 })
    );
    await expect(destroySprite(config)).rejects.toThrow(
      "Failed to destroy sprite"
    );
  });
});

// ---------------------------------------------------------------------------
// Health ping / ensureSpriteHealthy
// ---------------------------------------------------------------------------

describe("healthPingSprite", () => {
  const mockFetch = vi.fn();
  const config = {
    token: "test-token",
    spriteName: "my-sprite",
    baseUrl: "https://api.test.dev",
  };

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns true when sprite responds with exit code 0", async () => {
    const mockWs = {
      accept: vi.fn(),
      send: vi.fn(),
      addEventListener: vi.fn((event: string, handler: (arg: unknown) => void) => {
        if (event === "message") {
          setTimeout(() => handler({ data: JSON.stringify({ exit_code: 0 }) }), 0);
        }
        if (event === "close") {
          setTimeout(() => handler({}), 5);
        }
      }),
      close: vi.fn(),
    };
    mockFetch.mockResolvedValueOnce(
      Object.assign(new Response(null, { status: 200 }), { webSocket: mockWs })
    );

    const result = await healthPingSprite(config);
    expect(result).toBe(true);
  });

  it("returns false when WebSocket upgrade fails", async () => {
    // No webSocket property on response
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));

    const result = await healthPingSprite(config);
    expect(result).toBe(false);
  });

  it("returns false when exit code is non-zero", async () => {
    const mockWs = {
      accept: vi.fn(),
      send: vi.fn(),
      addEventListener: vi.fn((event: string, handler: (arg: unknown) => void) => {
        if (event === "message") {
          setTimeout(() => handler({ data: JSON.stringify({ exit_code: 1 }) }), 0);
        }
        if (event === "close") {
          setTimeout(() => handler({}), 5);
        }
      }),
      close: vi.fn(),
    };
    mockFetch.mockResolvedValueOnce(
      Object.assign(new Response(null, { status: 200 }), { webSocket: mockWs })
    );

    const result = await healthPingSprite(config);
    expect(result).toBe(false);
  });

  it("returns false when WebSocket fires error event", async () => {
    const mockWs = {
      accept: vi.fn(),
      send: vi.fn(),
      addEventListener: vi.fn((event: string, handler: (arg: unknown) => void) => {
        if (event === "error") {
          setTimeout(() => handler(new Event("error")), 0);
        }
      }),
      close: vi.fn(),
    };
    mockFetch.mockResolvedValueOnce(
      Object.assign(new Response(null, { status: 200 }), { webSocket: mockWs })
    );

    const result = await healthPingSprite(config);
    expect(result).toBe(false);
  });

  it("returns false when fetch throws (network error)", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network error"));

    const result = await healthPingSprite(config);
    expect(result).toBe(false);
  });
});

describe("ensureSpriteHealthy", () => {
  const mockFetch = vi.fn();
  const config = {
    token: "test-token",
    spriteName: "my-sprite",
    baseUrl: "https://api.test.dev",
  };

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockWsSuccess() {
    return {
      accept: vi.fn(),
      send: vi.fn(),
      addEventListener: vi.fn((event: string, handler: (arg: unknown) => void) => {
        if (event === "message") {
          setTimeout(() => handler({ data: JSON.stringify({ exit_code: 0 }) }), 0);
        }
        if (event === "close") {
          setTimeout(() => handler({}), 5);
        }
      }),
      close: vi.fn(),
    };
  }

  it("succeeds when sprite exists and ping is healthy", async () => {
    // GET sprite (exists)
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));
    // WS health ping
    mockFetch.mockResolvedValueOnce(
      Object.assign(new Response(null, { status: 200 }), { webSocket: mockWsSuccess() })
    );

    await ensureSpriteHealthy(config); // should not throw
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("rebuilds sprite when ping fails, then succeeds", async () => {
    // 1. GET sprite (exists)
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));
    // 2. WS health ping (fails — no webSocket)
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));
    // 3. DELETE sprite (destroy)
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));
    // 4. GET sprite (doesn't exist after destroy)
    mockFetch.mockResolvedValueOnce(new Response("", { status: 404 }));
    // 5. POST create sprite
    mockFetch.mockResolvedValueOnce(new Response("", { status: 201 }));
    // 6. WS health ping (succeeds)
    mockFetch.mockResolvedValueOnce(
      Object.assign(new Response(null, { status: 200 }), { webSocket: mockWsSuccess() })
    );

    await ensureSpriteHealthy(config); // should not throw
    expect(mockFetch).toHaveBeenCalledTimes(6);
  });

  it("throws when ping fails even after rebuild", async () => {
    // 1. GET sprite (exists)
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));
    // 2. WS health ping (fails)
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));
    // 3. DELETE sprite
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));
    // 4. GET sprite (doesn't exist)
    mockFetch.mockResolvedValueOnce(new Response("", { status: 404 }));
    // 5. POST create sprite
    mockFetch.mockResolvedValueOnce(new Response("", { status: 201 }));
    // 6. WS health ping (still fails)
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));

    await expect(ensureSpriteHealthy(config)).rejects.toThrow(
      "unresponsive after rebuild"
    );
  });
});

// ---------------------------------------------------------------------------
// SandboxClient via createSpritesSandboxClient — REST-based methods
// ---------------------------------------------------------------------------

describe("createSpritesSandboxClient", () => {
  const mockFetch = vi.fn();
  const ensureReady = vi.fn(async () => {});
  const config = {
    token: "tok",
    spriteName: "test-sprite",
    baseUrl: "https://api.test.dev",
  };

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
    ensureReady.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("readFile", () => {
    it("rejects invalid paths", async () => {
      const client = createSpritesSandboxClient(config, ensureReady);
      await expect(client.readFile("relative")).rejects.toThrow("Invalid path");
      await expect(client.readFile("")).rejects.toThrow("Invalid path");
    });

    it("method exists on the client", () => {
      const client = createSpritesSandboxClient(config, ensureReady);
      expect(typeof client.readFile).toBe("function");
    });
  });

  describe("exists", () => {
    it("rejects invalid paths", async () => {
      const client = createSpritesSandboxClient(config, ensureReady);
      await expect(client.exists("relative")).rejects.toThrow("Invalid path");
    });

    it("method exists on the client", () => {
      const client = createSpritesSandboxClient(config, ensureReady);
      expect(typeof client.exists).toBe("function");
    });
  });

  describe("mkdir", () => {
    it("calls mkdir without -p by default", async () => {
      const client = createSpritesSandboxClient(config, ensureReady);
      mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

      await client.mkdir("/tmp/newdir");

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain("cmd=mkdir");
      expect(calledUrl).toContain("cmd=--");
      expect(calledUrl).not.toContain("cmd=-p");
    });

    it("calls mkdir -p when recursive is true", async () => {
      const client = createSpritesSandboxClient(config, ensureReady);
      mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

      await client.mkdir("/tmp/a/b/c", { recursive: true });

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain("cmd=mkdir");
      expect(calledUrl).toContain("cmd=-p");
    });
  });

  describe("exec", () => {
    it("method exists on the client", () => {
      const client = createSpritesSandboxClient(config, ensureReady);
      expect(typeof client.exec).toBe("function");
    });
  });

  describe("writeFile", () => {
    it("method exists on the client", () => {
      const client = createSpritesSandboxClient(config, ensureReady);
      expect(typeof client.writeFile).toBe("function");
    });

    it("rejects invalid paths", async () => {
      const client = createSpritesSandboxClient(config, ensureReady);
      await expect(
        client.writeFile("relative/path", "data")
      ).rejects.toThrow("Invalid path");
    });

    it("includes stdin=true in WebSocket exec URL", async () => {
      const client = createSpritesSandboxClient(config, ensureReady);
      const mockWs = {
        accept: vi.fn(),
        send: vi.fn(),
        addEventListener: vi.fn((_event: string, handler: (arg: unknown) => void) => {
          // Simulate immediate close with exit_code 0
          if (_event === "close") setTimeout(() => handler({}), 0);
          if (_event === "message") {
            setTimeout(() => handler({ data: JSON.stringify({ exit_code: 0 }) }), 0);
          }
        }),
        close: vi.fn(),
      };
      // First call: mkdir -p (REST), second call: WebSocket writeFile
      mockFetch
        .mockResolvedValueOnce(new Response("", { status: 200 })) // mkdir
        .mockResolvedValueOnce(Object.assign(new Response(null, { status: 200 }), { webSocket: mockWs }));

      await client.writeFile("/tmp/test.txt", "hello");

      // The second fetch call is the WebSocket exec for writeFile
      const wsUrl = mockFetch.mock.calls[1][0] as string;
      expect(wsUrl).toContain("stdin=true");
    });
  });

  describe("ensureReady integration", () => {
    it("calls ensureReady before mkdir (REST-based operation)", async () => {
      const client = createSpritesSandboxClient(config, ensureReady);
      mockFetch.mockImplementation(
        async () => new Response("ok", { status: 200 })
      );

      await client.mkdir("/test");
      expect(ensureReady).toHaveBeenCalledTimes(1);

      await client.mkdir("/test2");
      expect(ensureReady).toHaveBeenCalledTimes(2);
    });

    it("propagates ensureReady errors", async () => {
      const failReady = vi.fn(async () => {
        throw new Error("not ready");
      });
      const client = createSpritesSandboxClient(config, failReady);

      // readFile calls ensureReady first, which throws before any fetch
      await expect(client.readFile("/test")).rejects.toThrow("not ready");
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
