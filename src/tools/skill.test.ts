import { describe, it, expect, vi, afterEach } from "vitest";
import { zipSync } from "fflate";
import { createSkillTools, parseGitHubUrl } from "./skill";
import type { SandboxClient } from "./sandbox-types";

function createMockSandbox(
  files: Record<string, string> = {},
): SandboxClient & { writtenFiles: Map<string, string> } {
  const fileMap = new Map(Object.entries(files));
  const writtenFiles = new Map<string, string>();
  return {
    writtenFiles,
    exec: vi.fn(async (cmd: string) => {
      // Simulate `find <dir> -type f`
      const match = cmd.match(/^find (.+) -type f$/);
      if (match) {
        const dir = match[1].replace(/^'(.*)'$/, "$1");
        const matching = [...fileMap.keys()].filter((k) => k.startsWith(dir + "/"));
        return { success: true, stdout: matching.join("\n"), stderr: "", exitCode: 0 };
      }
      // Simulate rm -rf
      if (cmd.startsWith("rm -rf")) {
        return { success: true, stdout: "", stderr: "", exitCode: 0 };
      }
      return { success: false, stdout: "", stderr: "unknown command", exitCode: 1 };
    }),
    readFile: vi.fn(async (path: string) => {
      const content = fileMap.get(path);
      if (content === undefined) throw new Error(`File not found: ${path}`);
      return content;
    }),
    writeFile: vi.fn(async (path: string, content: string) => {
      writtenFiles.set(path, content);
    }),
    exists: vi.fn(async (path: string) => ({ exists: fileMap.has(path) })),
    mkdir: vi.fn(async () => {}),
  };
}

const ADMIN_BOT_ID = "admin-bot-123";

function createMockD1(): D1Database & { boundValues: unknown[][] } {
  const boundValues: unknown[][] = [];
  return {
    boundValues,
    prepare: vi.fn(() => ({
      bind: vi.fn((...args: unknown[]) => {
        boundValues.push(args);
        return {
          run: vi.fn(async () => ({ meta: { changes: 1 } })),
        };
      }),
    })),
  } as unknown as D1Database & { boundValues: unknown[][] };
}

function createDeps(files: Record<string, string> = {}) {
  const sandbox = createMockSandbox(files);
  const db = createMockD1();
  return {
    sandbox,
    db,
    tools: createSkillTools({
      db,
      sandbox,
      botId: ADMIN_BOT_ID,
      ownerId: "test-owner",
      getSandboxClient: () => sandbox,
    }),
  };
}

describe("createSkillTools", () => {
  describe("register_skill", () => {
    it("reads SKILL.md from sandbox, writes to target sandbox and D1", async () => {
      const { tools, sandbox, db } = createDeps({
        "/workspace/skills/my-tool/SKILL.md":
          '---\nname: my-tool\ndescription: A tool\nmetadata: {"nanobot":{"emoji":"🔧"}}\n---\n# My Tool\nDocs here',
      });
      const result = await (tools.register_skill as any).execute({
        path: "/workspace/skills/my-tool",
      });
      expect(result).toContain('"my-tool"');
      expect(result).toContain("registered successfully");
      // Files written to sandbox
      expect(sandbox.writtenFiles.has("/installed-skills/my-tool/SKILL.md")).toBe(true);
      // D1 upsert includes bot_id
      expect(db.boundValues[0][0]).toBe(ADMIN_BOT_ID);
    });

    it("writes multi-file bundle to sandbox", async () => {
      const { tools, sandbox } = createDeps({
        "/workspace/skills/my-tool/SKILL.md": "---\nname: my-tool\ndescription: A tool\n---\n# My Tool",
        "/workspace/skills/my-tool/scripts/run.py": "print('hello')",
        "/workspace/skills/my-tool/references/guide.md": "# Guide",
      });
      const result = await (tools.register_skill as any).execute({
        path: "/workspace/skills/my-tool",
      });
      expect(result).toContain("registered successfully");
      expect(result).toContain("3 files");
      expect(sandbox.writtenFiles.size).toBe(3);
    });

    it("rejects if SKILL.md not found", async () => {
      const { tools } = createDeps({});
      const result = await (tools.register_skill as any).execute({
        path: "/workspace/skills/missing",
      });
      expect(result).toContain("SKILL.md not found");
    });

    it("rejects if bundle exceeds 5MB", async () => {
      const bigContent = "x".repeat(6 * 1024 * 1024);
      const { tools } = createDeps({
        "/workspace/skills/big/SKILL.md": "---\nname: big\ndescription: Big\n---\n" + bigContent,
      });
      const result = await (tools.register_skill as any).execute({
        path: "/workspace/skills/big",
      });
      expect(result).toContain("exceeds");
    });

    it("rejects invalid path prefix", async () => {
      const { tools } = createDeps({});
      const result = await (tools.register_skill as any).execute({
        path: "/etc/evil",
      });
      expect(result).toContain("Invalid path");
    });

    it("rejects paths with traversal in relative path", async () => {
      const { tools, sandbox } = createDeps({
        "/workspace/skills/evil/SKILL.md": "---\nname: evil\ndescription: Evil\n---\n# Evil",
        "/workspace/skills/evil/../../../etc/passwd": "root:x:0:0",
      });
      const result = await (tools.register_skill as any).execute({
        path: "/workspace/skills/evil",
      });
      // Should register but skip files with traversal in relative path
      expect(result).toContain("registered successfully");
      // Only SKILL.md should be written, not the traversal file
      expect(sandbox.writtenFiles.size).toBe(1);
    });

    it("rejects if frontmatter is missing", async () => {
      const { tools } = createDeps({
        "/workspace/skills/bad/SKILL.md": "# No Frontmatter",
      });
      const result = await (tools.register_skill as any).execute({
        path: "/workspace/skills/bad",
      });
      expect(result).toContain("Failed to parse");
    });

    it("stores with plain name under installed-skills/", async () => {
      const { tools, sandbox } = createDeps({
        "/workspace/skills/my-tool/SKILL.md": '---\nname: my-tool\ndescription: A tool\n---\n# My Tool',
      });
      const result = await (tools.register_skill as any).execute({
        path: "/workspace/skills/my-tool",
      });
      expect(result).toContain('"my-tool"');
      expect(sandbox.writtenFiles.has("/installed-skills/my-tool/SKILL.md")).toBe(true);
    });

    it("rejects registering same name as bundled", async () => {
      const { tools, sandbox } = createDeps({
        "/workspace/skills/weather/SKILL.md": "---\nname: weather\ndescription: Custom weather\n---\n# Weather",
      });
      const result = await (tools.register_skill as any).execute({
        path: "/workspace/skills/weather",
      });
      expect(result).toContain("conflicts with bundled skill");
      expect(sandbox.writtenFiles.size).toBe(0);
    });

    it("accepts /skills/ prefix path", async () => {
      const { tools } = createDeps({
        "/skills/my-tool/SKILL.md": "---\nname: my-tool\ndescription: A tool\n---\n# My Tool",
      });
      const result = await (tools.register_skill as any).execute({
        path: "/skills/my-tool",
      });
      expect(result).toContain('"my-tool"');
      expect(result).toContain("registered successfully");
    });

    it("rejects darwin-only skill", async () => {
      const { tools, sandbox } = createDeps({
        "/workspace/skills/mac-only/SKILL.md":
          '---\nname: mac-only\ndescription: Mac only.\nmetadata: {"openclaw":{"os":["darwin"]}}\n---\n# Mac',
      });
      const result = await (tools.register_skill as any).execute({
        path: "/workspace/skills/mac-only",
      });
      expect(result).toContain("sandbox runs Linux");
      expect(sandbox.writtenFiles.size).toBe(0);
    });

    it("accepts skill requiring bins already in sandbox (e.g. curl)", async () => {
      const sandbox = createMockSandbox({
        "/workspace/skills/fetcher/SKILL.md":
          '---\nname: fetcher\ndescription: Fetcher.\nmetadata: {"openclaw":{"requires":{"bins":["curl"]}}}\n---\n# Fetcher',
      });
      // Override exec to make `which curl` succeed
      sandbox.exec = vi.fn(async (cmd: string) => {
        if (cmd.includes("which")) return { success: true, stdout: "/usr/bin/curl", stderr: "", exitCode: 0 };
        if (cmd.startsWith("find")) {
          return { success: true, stdout: "/workspace/skills/fetcher/SKILL.md", stderr: "", exitCode: 0 };
        }
        return { success: true, stdout: "", stderr: "", exitCode: 0 };
      });
      const db = createMockD1();
      const tools = createSkillTools({
        db,
        sandbox,
        botId: ADMIN_BOT_ID,
        ownerId: "test-owner",
        getSandboxClient: () => sandbox,
      });
      const result = await (tools.register_skill as any).execute({
        path: "/workspace/skills/fetcher",
      });
      expect(result).toContain("registered successfully");
    });

    it("rejects skill with only brew install method", async () => {
      const sandbox = createMockSandbox({
        "/workspace/skills/brew-only/SKILL.md":
          '---\nname: brew-only\ndescription: Brew only.\nmetadata: {"openclaw":{"requires":{"bins":["mytool"]},"install":[{"kind":"brew","formula":"foo/bar/mytool","bins":["mytool"]}]}}\n---\n# Brew',
      });
      // which mytool -> not found
      sandbox.exec = vi.fn(async (cmd: string) => {
        if (cmd.includes("which")) return { success: false, stdout: "", stderr: "", exitCode: 1 };
        return { success: true, stdout: "", stderr: "", exitCode: 0 };
      });
      const db = createMockD1();
      const tools = createSkillTools({
        db,
        sandbox,
        botId: ADMIN_BOT_ID,
        ownerId: "test-owner",
        getSandboxClient: () => sandbox,
      });
      const result = await (tools.register_skill as any).execute({
        path: "/workspace/skills/brew-only",
      });
      expect(result).toContain("only has brew install methods");
    });

    it("saves requires_env to D1 when skill has env requirements", async () => {
      const { tools, db } = createDeps({
        "/workspace/skills/notion/SKILL.md":
          '---\nname: notion\ndescription: Notion API\nmetadata: {"openclaw":{"emoji":"📝","requires":{"env":["NOTION_API_KEY"]}}}\n---\n# Notion',
      });
      const result = await (tools.register_skill as any).execute({
        path: "/workspace/skills/notion",
      });
      expect(result).toContain("registered successfully");
      // Check that requires_env was passed to D1 bind
      const bindArgs = db.boundValues[0];
      expect(bindArgs).toContain('["NOTION_API_KEY"]');
    });

    it("saves empty requires_env array when skill has no env requirements", async () => {
      const { tools, db } = createDeps({
        "/workspace/skills/simple/SKILL.md":
          '---\nname: simple\ndescription: Simple.\n---\n# Simple',
      });
      const result = await (tools.register_skill as any).execute({
        path: "/workspace/skills/simple",
      });
      expect(result).toContain("registered successfully");
      const bindArgs = db.boundValues[0];
      expect(bindArgs).toContain('[]');
    });

    it("passes through skill with no requires", async () => {
      const { tools } = createDeps({
        "/workspace/skills/simple/SKILL.md":
          '---\nname: simple\ndescription: Simple.\nmetadata: {"openclaw":{"emoji":"✨"}}\n---\n# Simple',
      });
      const result = await (tools.register_skill as any).execute({
        path: "/workspace/skills/simple",
      });
      expect(result).toContain("registered successfully");
    });
  });

  describe("unregister_skill", () => {
    it("rejects bundled skill name", async () => {
      const { tools } = createDeps({});
      const result = await (tools.unregister_skill as any).execute({ name: "weather" });
      expect(result).toContain("Cannot unregister bundled skill");
    });

    it("deletes from D1 and sandbox", async () => {
      const sandbox = createMockSandbox({});
      const db = {
        prepare: vi.fn(() => ({
          bind: vi.fn(() => ({
            run: vi.fn(async () => ({ meta: { changes: 1 } })),
          })),
        })),
      } as unknown as D1Database;
      const tools = createSkillTools({
        db,
        sandbox,
        botId: ADMIN_BOT_ID,
        ownerId: "test-owner",
        getSandboxClient: () => sandbox,
      });
      const result = await (tools.unregister_skill as any).execute({ name: "my-tool" });
      expect(result).toContain("unregistered");
      // rm -rf should have been called
      expect(sandbox.exec).toHaveBeenCalledWith("rm -rf /installed-skills/my-tool");
    });

    it("returns not found for non-existent skill", async () => {
      const sandbox = createMockSandbox({});
      const db = {
        prepare: vi.fn(() => ({
          bind: vi.fn(() => ({
            run: vi.fn(async () => ({ meta: { changes: 0 } })),
          })),
        })),
      } as unknown as D1Database;
      const tools = createSkillTools({
        db,
        sandbox,
        botId: ADMIN_BOT_ID,
        ownerId: "test-owner",
        getSandboxClient: () => sandbox,
      });
      const result = await (tools.unregister_skill as any).execute({ name: "nonexistent" });
      expect(result).toContain("not found");
    });

    it("handles D1 errors gracefully", async () => {
      const sandbox = createMockSandbox({});
      const db = {
        prepare: vi.fn(() => ({
          bind: vi.fn(() => ({
            run: vi.fn(async () => { throw new Error("D1 down"); }),
          })),
        })),
      } as unknown as D1Database;
      const tools = createSkillTools({
        db,
        sandbox,
        botId: ADMIN_BOT_ID,
        ownerId: "test-owner",
        getSandboxClient: () => sandbox,
      });
      const result = await (tools.unregister_skill as any).execute({ name: "my-tool" });
      expect(result).toContain("Failed to unregister");
      expect(result).toContain("D1 down");
    });
  });

  describe("install_skill", () => {
    const SKILL_MD = '---\nname: my-skill\ndescription: A cool skill\nmetadata: {"nanobot":{"emoji":"🔧"}}\n---\n# My Skill\nDocs here';

    function makeZip(files: Record<string, string>): ArrayBuffer {
      const entries: Record<string, Uint8Array> = {};
      for (const [name, content] of Object.entries(files)) {
        entries[name] = new TextEncoder().encode(content);
      }
      return zipSync(entries).buffer;
    }

    function mockFetchSuccess(zipData: ArrayBuffer) {
      vi.stubGlobal("fetch", vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "Content-Length": String(zipData.byteLength) }),
        arrayBuffer: async () => zipData,
      })));
    }

    it("downloads zip, extracts, writes to sandbox and D1", async () => {
      const zipData = makeZip({
        "SKILL.md": SKILL_MD,
        "README.md": "# Readme",
      });
      mockFetchSuccess(zipData);

      const { tools, sandbox, db } = createDeps({});

      const result = await (tools.install_skill as any).execute({ slug: "my-skill" });
      expect(result).toContain('"my-skill"');
      expect(result).toContain("installed successfully");
      expect(result).toContain("2 files");
      // Files written to sandbox
      expect(sandbox.writtenFiles.size).toBe(2);
      // D1 includes bot_id
      expect(db.boundValues[0][0]).toBe(ADMIN_BOT_ID);
    });

    it("returns error on HTTP failure", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => ({
        ok: false,
        status: 404,
        statusText: "Not Found",
        headers: new Headers(),
      })));

      const { tools, sandbox } = createDeps({});

      const result = await (tools.install_skill as any).execute({ slug: "nonexistent" });
      expect(result).toContain("Failed to download");
      expect(result).toContain("404");
      expect(sandbox.writtenFiles.size).toBe(0);
    });

    it("returns error when zip has no SKILL.md", async () => {
      const zipData = makeZip({ "README.md": "# Readme" });
      mockFetchSuccess(zipData);

      const { tools, sandbox } = createDeps({});

      const result = await (tools.install_skill as any).execute({ slug: "bad-skill" });
      expect(result).toContain("No SKILL.md found");
      expect(sandbox.writtenFiles.size).toBe(0);
    });

    it("rejects zip with invalid frontmatter", async () => {
      const zipData = makeZip({ "SKILL.md": "# No frontmatter" });
      mockFetchSuccess(zipData);

      const { tools, sandbox } = createDeps({});

      const result = await (tools.install_skill as any).execute({ slug: "bad" });
      expect(result).toContain("Failed to parse");
      expect(sandbox.writtenFiles.size).toBe(0);
    });

    it("rejects bundled skill name conflict", async () => {
      const zipData = makeZip({
        "SKILL.md": "---\nname: weather\ndescription: Custom weather\n---\n# Weather",
      });
      mockFetchSuccess(zipData);

      const { tools, sandbox } = createDeps({});

      const result = await (tools.install_skill as any).execute({ slug: "weather" });
      expect(result).toContain("conflicts with bundled skill");
      expect(sandbox.writtenFiles.size).toBe(0);
    });

    it("rejects zip exceeding 5MB", async () => {
      const bigContent = "x".repeat(6 * 1024 * 1024);
      const zipData = makeZip({
        "SKILL.md": "---\nname: big\ndescription: Big\n---\n# Big",
        "data.bin": bigContent,
      });
      mockFetchSuccess(zipData);

      const { tools, sandbox } = createDeps({});

      const result = await (tools.install_skill as any).execute({ slug: "big" });
      expect(result).toContain("exceeds");
      expect(sandbox.writtenFiles.size).toBe(0);
    });

    it("skips files with path traversal", async () => {
      const zipData = makeZip({
        "SKILL.md": SKILL_MD,
        "../../../etc/passwd": "root:x:0:0",
      });
      mockFetchSuccess(zipData);

      const { tools, sandbox } = createDeps({});

      const result = await (tools.install_skill as any).execute({ slug: "my-skill" });
      expect(result).toContain("installed successfully");
      expect(sandbox.writtenFiles.size).toBe(1);
    });

    it("rejects darwin-only skill", async () => {
      const zipData = makeZip({
        "SKILL.md": '---\nname: mac-only\ndescription: Mac only.\nmetadata: {"openclaw":{"os":["darwin"]}}\n---\n# Mac',
      });
      mockFetchSuccess(zipData);

      const { tools, sandbox } = createDeps({});

      const result = await (tools.install_skill as any).execute({ slug: "mac-only" });
      expect(result).toContain("sandbox runs Linux");
      expect(sandbox.writtenFiles.size).toBe(0);
    });

    it("saves requires_env to D1 when installing skill with env requirements", async () => {
      const skillMd = '---\nname: notion\ndescription: Notion API\nmetadata: {"openclaw":{"emoji":"📝","requires":{"env":["NOTION_API_KEY"]}}}\n---\n# Notion';
      const zipData = makeZip({ "SKILL.md": skillMd });
      mockFetchSuccess(zipData);

      const { tools, db } = createDeps({});

      const result = await (tools.install_skill as any).execute({ slug: "notion" });
      expect(result).toContain("installed successfully");
      const bindArgs = db.boundValues[0];
      expect(bindArgs).toContain('["NOTION_API_KEY"]');
    });

    it("saves empty requires_env when installing skill without env requirements", async () => {
      const zipData = makeZip({ "SKILL.md": SKILL_MD });
      mockFetchSuccess(zipData);

      const { tools, db } = createDeps({});

      const result = await (tools.install_skill as any).execute({ slug: "my-skill" });
      expect(result).toContain("installed successfully");
      const bindArgs = db.boundValues[0];
      expect(bindArgs).toContain('[]');
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });
  });

  describe("search_skills", () => {
    it("returns search results from ClawHub", async () => {
      const mockResults = {
        results: [
          { slug: "web-scraper", displayName: "Web Scraper", summary: "Scrape websites", score: 0.95 },
        ],
      };
      vi.stubGlobal("fetch", vi.fn(async () => ({
        ok: true,
        json: async () => mockResults,
      })));

      const { tools } = createDeps({});

      const result = await (tools.search_skills as any).execute({ query: "web scraping", limit: 5 });
      const parsed = JSON.parse(result);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].slug).toBe("web-scraper");
    });

    it("returns message when no results", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => ({
        ok: true,
        json: async () => ({ results: [] }),
      })));

      const { tools } = createDeps({});

      const result = await (tools.search_skills as any).execute({ query: "nonexistent", limit: 5 });
      expect(result).toContain("No skills found");
    });

    it("handles HTTP errors", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => ({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        headers: new Headers({ "Retry-After": "0" }),
      })));

      const { tools } = createDeps({});

      const result = await (tools.search_skills as any).execute({ query: "test", limit: 5 });
      expect(result).toContain("Failed to search skills");
      expect(result).toContain("500");
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });
  });

  describe("install_skill from GitHub", () => {
    const SKILL_MD = '---\nname: pdf-tool\ndescription: Convert PDFs\nmetadata: {"nanobot":{"emoji":"📄"}}\n---\n# PDF Tool\nDocs here';

    function mockGitHubFetch(files: Record<string, string>) {
      const fileList = Object.entries(files).map(([name, content]) => ({
        name: name.split("/").pop()!,
        type: "file" as const,
        path: `skills/pdf/${name}`,
        download_url: `https://raw.githubusercontent.com/owner/repo/main/skills/pdf/${name}`,
        size: new TextEncoder().encode(content).length,
      }));

      vi.stubGlobal("fetch", vi.fn(async (url: string) => {
        if (url.includes("api.github.com/repos") && url.includes("/contents/")) {
          return {
            ok: true,
            json: async () => fileList,
          };
        }
        if (url.includes("raw.githubusercontent.com")) {
          const fileName = Object.keys(files).find((f) => url.endsWith(f));
          if (fileName) {
            const content = files[fileName];
            return {
              ok: true,
              arrayBuffer: async () => new TextEncoder().encode(content).buffer,
            };
          }
        }
        return { ok: false, status: 404, statusText: "Not Found", headers: new Headers() };
      }));
    }

    it("installs skill from GitHub URL", async () => {
      mockGitHubFetch({
        "SKILL.md": SKILL_MD,
        "README.md": "# PDF Tool readme",
      });

      const { tools, sandbox, db } = createDeps({});

      const result = await (tools.install_skill as any).execute({
        github_url: "owner/repo/skills/pdf",
      });
      expect(result).toContain('"pdf-tool"');
      expect(result).toContain("installed successfully from GitHub");
      expect(result).toContain("2 files");
      expect(sandbox.writtenFiles.size).toBe(2);
    });

    it("returns error for invalid github_url", async () => {
      const { tools } = createDeps({});

      const result = await (tools.install_skill as any).execute({
        github_url: "invalid",
      });
      expect(result).toContain("Invalid github_url");
    });

    it("returns error when no SKILL.md in GitHub directory", async () => {
      vi.stubGlobal("fetch", vi.fn(async (url: string) => {
        if (url.includes("/contents/")) {
          return {
            ok: true,
            json: async () => [{
              name: "README.md",
              type: "file",
              path: "skills/test/README.md",
              download_url: "https://raw.githubusercontent.com/o/r/main/skills/test/README.md",
              size: 10,
            }],
          };
        }
        if (url.includes("raw.githubusercontent.com")) {
          return { ok: true, arrayBuffer: async () => new TextEncoder().encode("# Readme").buffer };
        }
        return { ok: false, status: 404, statusText: "Not Found", headers: new Headers() };
      }));

      const { tools } = createDeps({});

      const result = await (tools.install_skill as any).execute({
        github_url: "owner/repo/skills/test",
      });
      expect(result).toContain("No SKILL.md found");
    });

    it("returns error when neither slug nor github_url provided", async () => {
      const { tools } = createDeps({});

      const result = await (tools.install_skill as any).execute({});
      expect(result).toContain("Either slug or github_url");
    });

    it("handles GitHub API errors", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => ({
        ok: false,
        status: 404,
        statusText: "Not Found",
        headers: new Headers(),
      })));

      const { tools } = createDeps({});

      const result = await (tools.install_skill as any).execute({
        github_url: "owner/repo/nonexistent",
      });
      expect(result).toContain("Failed to install from GitHub");
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });
  });

  describe("parseGitHubUrl", () => {
    it("parses short format owner/repo/path", () => {

      const ref = parseGitHubUrl("anthropics/skills/skills/pdf");
      expect(ref).toEqual({ owner: "anthropics", repo: "skills", path: "skills/pdf" });
    });

    it("parses full tree URL", () => {

      const ref = parseGitHubUrl("https://github.com/anthropics/skills/tree/main/skills/pdf");
      expect(ref).toEqual({ owner: "anthropics", repo: "skills", ref: "main", path: "skills/pdf" });
    });

    it("parses blob URL pointing to SKILL.md", () => {

      const ref = parseGitHubUrl("https://github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md");
      expect(ref).toEqual({ owner: "anthropics", repo: "skills", ref: "main", path: "skills/pdf" });
    });

    it("parses raw.githubusercontent.com URL", () => {

      const ref = parseGitHubUrl("https://raw.githubusercontent.com/anthropics/skills/main/skills/pdf/SKILL.md");
      expect(ref).toEqual({ owner: "anthropics", repo: "skills", ref: "main", path: "skills/pdf" });
    });

    it("returns null for invalid input", () => {
      expect(parseGitHubUrl("invalid")).toBeNull();
      expect(parseGitHubUrl("owner/repo")).toBeNull();
    });

    it("returns null for owner/repo with special characters", () => {
      expect(parseGitHubUrl("owner#bad/repo/path")).toBeNull();
      expect(parseGitHubUrl("owner/repo?evil/path")).toBeNull();
    });

    it("strips trailing slashes", () => {
      const ref = parseGitHubUrl("anthropics/skills/skills/pdf/");
      expect(ref).toEqual({ owner: "anthropics", repo: "skills", path: "skills/pdf" });
    });

    it("handles blob URL to root SKILL.md with empty path", () => {
      const ref = parseGitHubUrl("https://github.com/owner/repo/blob/main/SKILL.md");
      expect(ref).toEqual({ owner: "owner", repo: "repo", ref: "main", path: "" });
    });
  });
});
