import { describe, it, expect, vi } from "vitest";
import {
  parseSkillFrontmatter,
  stripFrontmatter,
  listSkills,
  loadSkillContent,
  buildSkillsSummary,
  listAllSkills,
  buildSkillsSummaryWithD1,
  buildSkillsSummaryXml,
  type SkillEntry,
} from "./loader";
import { BUILTIN_SKILLS, BUNDLED_SKILL_META } from "./builtin";

function createMockD1(
  rows: Array<{ name: string; description: string; emoji: string | null; path: string; requires_env?: string | null }> = [],
): D1Database {
  // Ensure requires_env defaults to null for backward compat
  const normalizedRows = rows.map((r) => ({ requires_env: null, ...r }));
  return {
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn(() => ({
        all: vi.fn(async () => ({
          results: sql.includes("WHERE bot_id")
            ? normalizedRows  // bot_id filtered query returns all rows (mock)
            : normalizedRows,
        })),
      })),
      all: vi.fn(async () => ({ results: normalizedRows })),
    })),
  } as unknown as D1Database;
}

describe("parseSkillFrontmatter", () => {
  it("parses basic frontmatter", () => {
    const content = `---
name: test
description: A test skill.
---

# Body`;

    const meta = parseSkillFrontmatter(content);
    expect(meta).toEqual({
      name: "test",
      description: "A test skill.",
    });
  });

  it("parses homepage", () => {
    const content = `---
name: weather
description: Weather info.
homepage: https://wttr.in
---

# Body`;

    const meta = parseSkillFrontmatter(content);
    expect(meta?.homepage).toBe("https://wttr.in");
  });

  it("parses metadata JSON with nanobot subobject", () => {
    const content = `---
name: weather
description: Weather.
metadata: {"nanobot":{"emoji":"🌤️","requires":{"bins":["curl"]}}}
---

# Body`;

    const meta = parseSkillFrontmatter(content);
    expect(meta?.metadata?.emoji).toBe("🌤️");
    expect(meta?.metadata?.requires?.bins).toEqual(["curl"]);
  });

  it("parses quoted description", () => {
    const content = `---
name: github
description: "Use gh CLI for GitHub."
---

# Body`;

    const meta = parseSkillFrontmatter(content);
    expect(meta?.description).toBe("Use gh CLI for GitHub.");
  });

  it("returns null for missing frontmatter", () => {
    expect(parseSkillFrontmatter("# No frontmatter")).toBeNull();
  });

  it("returns null for incomplete frontmatter", () => {
    const content = `---
name: test
---

# Body`;

    expect(parseSkillFrontmatter(content)).toBeNull();
  });

  it("parses metadata JSON with openclaw namespace", () => {
    const content = `---
name: summarize
description: Summarize URLs.
metadata: {"openclaw":{"emoji":"🧾","requires":{"bins":["summarize"]},"install":[{"id":"brew","kind":"brew","formula":"steipete/tap/summarize","bins":["summarize"]}]}}
---

# Body`;

    const meta = parseSkillFrontmatter(content);
    expect(meta?.metadata?.emoji).toBe("🧾");
    expect(meta?.metadata?.requires?.bins).toEqual(["summarize"]);
    expect(meta?.metadata?.install).toHaveLength(1);
    expect(meta?.metadata?.install?.[0]).toMatchObject({
      kind: "brew",
      formula: "steipete/tap/summarize",
    });
  });

  it("parses metadata JSON with clawdbot namespace", () => {
    const content = `---
name: test
description: Test.
metadata: {"clawdbot":{"emoji":"🔧","requires":{"bins":["mytool"]}}}
---

# Body`;

    const meta = parseSkillFrontmatter(content);
    expect(meta?.metadata?.emoji).toBe("🔧");
    expect(meta?.metadata?.requires?.bins).toEqual(["mytool"]);
  });

  it("parses unnamespaced metadata (backward compat)", () => {
    const content = `---
name: simple
description: Simple skill.
metadata: {"emoji":"🔧"}
---

# Body`;

    const meta = parseSkillFrontmatter(content);
    expect(meta?.metadata?.emoji).toBe("🔧");
  });

  it("parses os field from metadata", () => {
    const content = `---
name: mac-only
description: Mac only.
metadata: {"openclaw":{"emoji":"🍎","os":["darwin"]}}
---

# Body`;

    const meta = parseSkillFrontmatter(content);
    expect(meta?.metadata?.os).toEqual(["darwin"]);
  });

  it("parses literal block scalar (|) description", () => {
    const content = `---
name: humanize
description: |
  Remove signs of AI-generated writing from text. Use when editing or reviewing
  text to make it sound more natural and human-written.
---

# Body`;

    const meta = parseSkillFrontmatter(content);
    expect(meta?.description).toBe(
      "Remove signs of AI-generated writing from text. Use when editing or reviewing\ntext to make it sound more natural and human-written.",
    );
  });

  it("parses folded block scalar (>) description", () => {
    const content = `---
name: humanize
description: >
  Remove signs of AI-generated writing from text. Use when editing or reviewing
  text to make it sound more natural and human-written.
---

# Body`;

    const meta = parseSkillFrontmatter(content);
    expect(meta?.description).toBe(
      "Remove signs of AI-generated writing from text. Use when editing or reviewing text to make it sound more natural and human-written.",
    );
  });

  it("parses strip block scalar (|-) description", () => {
    const content = `---
name: test
description: |-
  Multi-line
  description here.
---

# Body`;

    const meta = parseSkillFrontmatter(content);
    expect(meta?.description).toBe("Multi-line\ndescription here.");
  });

  it("handles block scalar with empty lines", () => {
    const content = `---
name: test
description: |
  First paragraph.

  Second paragraph.
---

# Body`;

    const meta = parseSkillFrontmatter(content);
    expect(meta?.description).toBe("First paragraph.\n\nSecond paragraph.");
  });

  it("handles block scalar followed by another key", () => {
    const content = `---
name: humanize
description: |
  Multi-line description.
homepage: https://example.com
---

# Body`;

    const meta = parseSkillFrontmatter(content);
    expect(meta?.description).toBe("Multi-line description.");
    expect(meta?.homepage).toBe("https://example.com");
  });

  it("handles indented content with colons inside block scalar", () => {
    const content = `---
name: test
description: |
  Usage: run the command.
  Note: this is important.
---

# Body`;

    const meta = parseSkillFrontmatter(content);
    expect(meta?.description).toBe(
      "Usage: run the command.\nNote: this is important.",
    );
  });

  it("preserves nested indentation in block scalar", () => {
    const content = `---
name: test
description: |
  Run like this:
    code --flag
    more code
---

# Body`;

    const meta = parseSkillFrontmatter(content);
    expect(meta?.description).toBe(
      "Run like this:\n  code --flag\n  more code",
    );
  });

  it("handles block scalar starting with empty lines before content", () => {
    const content = `---
name: test
description: |

  Actual content after empty line.
homepage: https://example.com
---

# Body`;

    const meta = parseSkillFrontmatter(content);
    expect(meta?.description).toBe("Actual content after empty line.");
    expect(meta?.homepage).toBe("https://example.com");
  });

  it("handles empty block scalar followed by another key", () => {
    const content = `---
name: test
description: |
homepage: https://example.com
---

# Body`;

    // description is empty after trim -> returns null (missing required field)
    expect(parseSkillFrontmatter(content)).toBeNull();
  });

  it("parses download install spec with url", () => {
    const content = `---
name: dl-tool
description: Download tool.
metadata: {"openclaw":{"requires":{"bins":["mytool"]},"install":[{"kind":"download","url":"https://example.com/mytool","bins":["mytool"]}]}}
---

# Body`;

    const meta = parseSkillFrontmatter(content);
    expect(meta?.metadata?.install?.[0]).toMatchObject({
      kind: "download",
      url: "https://example.com/mytool",
    });
  });

  it("parses node install spec with package", () => {
    const content = `---
name: oracle
description: Oracle.
metadata: {"openclaw":{"requires":{"bins":["oracle"]},"install":[{"kind":"node","package":"@steipete/oracle","bins":["oracle"]}]}}
---

# Body`;

    const meta = parseSkillFrontmatter(content);
    expect(meta?.metadata?.install?.[0]).toMatchObject({
      kind: "node",
      package: "@steipete/oracle",
    });
  });

  it("should parse requires.env from metadata", () => {
    const content = `---
name: notion
description: Notion API
metadata: {"openclaw": {"emoji": "📝", "requires": {"env": ["NOTION_API_KEY"]}, "primaryEnv": "NOTION_API_KEY"}}
---
# notion`;
    const meta = parseSkillFrontmatter(content);
    expect(meta?.metadata?.requires?.env).toEqual(["NOTION_API_KEY"]);
  });

  it("should parse requires with both bins and env", () => {
    const content = `---
name: test-skill
description: Test
metadata: {"openclaw":{"requires":{"bins":["curl"],"env":["API_KEY","API_SECRET"]}}}
---
# test`;
    const meta = parseSkillFrontmatter(content);
    expect(meta?.metadata?.requires?.bins).toEqual(["curl"]);
    expect(meta?.metadata?.requires?.env).toEqual(["API_KEY", "API_SECRET"]);
  });

  it("parses nested YAML metadata (clawdbot namespace)", () => {
    const content = `---
name: notion
description: Work with Notion pages and databases via the official Notion API.
homepage: https://developers.notion.com
metadata:
  clawdbot:
    emoji: 🧠
    requires:
      env:
        - NOTION_API_KEY
    install:
      - id: node
        kind: note
        label: "Requires notion-cli"
---

# Notion`;
    const meta = parseSkillFrontmatter(content);
    expect(meta?.name).toBe("notion");
    expect(meta?.homepage).toBe("https://developers.notion.com");
    expect(meta?.metadata?.emoji).toBe("🧠");
    expect(meta?.metadata?.requires?.env).toEqual(["NOTION_API_KEY"]);
    expect(meta?.metadata?.install).toHaveLength(1);
    expect(meta?.metadata?.install?.[0]).toMatchObject({
      kind: "note",
      id: "node",
    });
  });

  it("parses nested YAML metadata with multiple env vars", () => {
    const content = `---
name: multi-env
description: Needs multiple env vars.
metadata:
  openclaw:
    emoji: 🔑
    requires:
      bins:
        - curl
      env:
        - API_KEY
        - API_SECRET
---
# test`;
    const meta = parseSkillFrontmatter(content);
    expect(meta?.metadata?.emoji).toBe("🔑");
    expect(meta?.metadata?.requires?.bins).toEqual(["curl"]);
    expect(meta?.metadata?.requires?.env).toEqual(["API_KEY", "API_SECRET"]);
  });

  it("parses YAML flow mapping metadata (ClawHub format)", () => {
    const content = `---
name: pdf-extract
description: "Extract text from PDF files for LLM processing"
metadata:
  {
    "openclaw":
      {
        "emoji": "📄",
        "requires": { "bins": ["pdftotext"] },
        "install":
          [
            {
              "id": "dnf",
              "kind": "dnf",
              "package": "poppler-utils",
              "bins": ["pdftotext"],
              "label": "Install via dnf",
            },
          ],
      },
  }
---
# PDF Extract`;
    const meta = parseSkillFrontmatter(content);
    expect(meta?.name).toBe("pdf-extract");
    expect(meta?.metadata?.emoji).toBe("📄");
    expect(meta?.metadata?.requires?.bins).toEqual(["pdftotext"]);
    expect(meta?.metadata?.install).toHaveLength(1);
    expect(meta?.metadata?.install?.[0]).toMatchObject({
      kind: "dnf",
      package: "poppler-utils",
      bins: ["pdftotext"],
    });
  });

  it("parses nested YAML metadata with no namespace (unnamespaced)", () => {
    const content = `---
name: simple
description: Simple.
metadata:
  emoji: 🔧
  requires:
    env:
      - TOKEN
---
# test`;
    const meta = parseSkillFrontmatter(content);
    expect(meta?.metadata?.emoji).toBe("🔧");
    expect(meta?.metadata?.requires?.env).toEqual(["TOKEN"]);
  });
});

describe("stripFrontmatter", () => {
  it("removes frontmatter and returns body", () => {
    const content = `---
name: test
description: Test.
---

# Body content here`;

    expect(stripFrontmatter(content)).toBe("# Body content here");
  });

  it("returns original content if no frontmatter", () => {
    expect(stripFrontmatter("# Just markdown")).toBe("# Just markdown");
  });
});

describe("listSkills", () => {
  it("returns all builtin skills", () => {
    const skills = listSkills();
    expect(skills.length).toBe(5);
    const names = skills.map((s) => s.name);
    expect(names).toContain("weather");
    expect(names).toContain("github");
    expect(names).toContain("image");
    expect(names).toContain("selfie");
    expect(names).toContain("system-reference");
  });

  it("marks weather as available (curl has replacement)", () => {
    const weather = listSkills().find((s) => s.name === "weather");
    expect(weather?.available).toBe(true);
  });

  it("marks github as available (gh is in sandbox)", () => {
    const github = listSkills().find((s) => s.name === "github");
    expect(github?.available).toBe(true);
  });

});

describe("loadSkillContent", () => {
  it("returns content for existing skill", () => {
    const content = loadSkillContent("weather");
    expect(content).toContain("name: weather");
  });

  it("returns null for unknown skill", () => {
    expect(loadSkillContent("nonexistent")).toBeNull();
  });

  it("returns null for memory (no longer a builtin skill)", () => {
    expect(loadSkillContent("memory")).toBeNull();
  });
});

describe("buildSkillsSummary", () => {
  it("returns XML format", () => {
    const summary = buildSkillsSummary();
    expect(summary).toContain("<skills>");
    expect(summary).toContain("</skills>");
  });

  it("includes all skills", () => {
    const summary = buildSkillsSummary();
    expect(summary).not.toContain("<name>memory");
    expect(summary).toContain("weather");
  });

  it("marks available skills correctly", () => {
    const summary = buildSkillsSummary();
    expect(summary).toContain('available="true"');
    expect(summary).toContain("weather");
  });

  it("all remaining skills are available", () => {
    const summary = buildSkillsSummary();
    expect(summary).not.toContain('available="false"');
  });

  it("includes selfie skill in summary", () => {
    const summary = buildSkillsSummary();
    expect(summary).toContain("selfie");
    expect(summary).toContain("📸");
  });
});

// --
// D1-based skill discovery
// --

describe("listAllSkills", () => {
  it("returns all bundled skills when D1 is empty", async () => {
    const db = createMockD1();
    const skills = await listAllSkills(db);
    const names = skills.map((s) => s.name);
    expect(names).not.toContain("memory");
    expect(names).toContain("weather");
    expect(names).toContain("selfie");
    expect(skills.every((s) => s.source === "bundled")).toBe(true);
  });

  it("includes installed skills from D1", async () => {
    const db = createMockD1([
      { name: "my-tool", description: "Custom tool.", emoji: null, path: "/installed-skills/my-tool/SKILL.md" },
    ]);
    const skills = await listAllSkills(db);
    const myTool = skills.find((s) => s.name === "my-tool");
    expect(myTool).toBeDefined();
    expect(myTool!.source).toBe("installed");
    expect(myTool!.available).toBe(true);
  });

  it("installed skill with same name as bundled is skipped", async () => {
    const db = createMockD1([
      { name: "weather", description: "Custom weather.", emoji: "🌧️", path: "/installed-skills/weather/SKILL.md" },
    ]);
    const skills = await listAllSkills(db);
    const weathers = skills.filter((s) => s.name === "weather");
    expect(weathers).toHaveLength(1);
    expect(weathers[0].source).toBe("bundled");
  });

  it("gracefully falls back when D1 fails", async () => {
    const db = {
      prepare: vi.fn(() => ({
        all: vi.fn(async () => { throw new Error("D1 unavailable"); }),
      })),
    } as unknown as D1Database;
    const skills = await listAllSkills(db);
    // Should return bundled skills only
    expect(skills.length).toBeGreaterThan(0);
    expect(skills.every((s) => s.source === "bundled")).toBe(true);
  });

  it("filters bundled skills by enabledSkills", async () => {
    const db = createMockD1();
    const skills = await listAllSkills(db, undefined, ["selfie", "weather"]);
    const names = skills.map((s) => s.name);
    expect(names).toContain("selfie");
    expect(names).toContain("weather");
    expect(names).not.toContain("github");
  });

  it("empty enabledSkills returns no bundled skills", async () => {
    const db = createMockD1();
    const skills = await listAllSkills(db, undefined, []);
    expect(skills).toHaveLength(0);
  });

  it("admin bots with empty enabledSkills get no builtin skills", async () => {
    const db = createMockD1();
    const skills = await listAllSkills(db, undefined, [], true);
    const names = skills.map((s) => s.name);
    // No adminOnly builtins anymore -- empty enabledSkills means no builtins
    expect(names).not.toContain("weather");
  });

  it("non-admin bots with empty enabledSkills get no builtin skills", async () => {
    const db = createMockD1();
    const skills = await listAllSkills(db, undefined, []);
    const names = skills.map((s) => s.name);
    expect(names).not.toContain("weather");
  });

  it("installed skills are filtered by enabledSkills like bundled skills", async () => {
    const db = createMockD1([
      { name: "my-tool", description: "Custom tool.", emoji: null, path: "/installed-skills/my-tool/SKILL.md" },
    ]);
    // enabledSkills only lists "selfie" — installed skill not in list should be filtered out
    const skills = await listAllSkills(db, "bot-1", ["selfie"]);
    const names = skills.map((s) => s.name);
    expect(names).toContain("selfie");
    expect(names).not.toContain("my-tool");
    expect(names).not.toContain("weather");
  });

  it("installed skills appear when included in enabledSkills", async () => {
    const db = createMockD1([
      { name: "my-tool", description: "Custom tool.", emoji: null, path: "/installed-skills/my-tool/SKILL.md" },
    ]);
    const skills = await listAllSkills(db, "bot-1", ["selfie", "my-tool"]);
    const names = skills.map((s) => s.name);
    expect(names).toContain("selfie");
    expect(names).toContain("my-tool");
  });

  it("should include requiresEnv from D1 skills table", async () => {
    const db = createMockD1([
      { name: "notion", description: "Notion API", emoji: "📝", path: "/installed-skills/notion/SKILL.md", requires_env: '["NOTION_API_KEY"]' },
    ]);
    const skills = await listAllSkills(db);
    const notion = skills.find((s) => s.name === "notion");
    expect(notion).toBeDefined();
    expect(notion!.requiresEnv).toEqual(["NOTION_API_KEY"]);
  });

  it("should not set requiresEnv when requires_env is empty array", async () => {
    const db = createMockD1([
      { name: "simple", description: "Simple skill", emoji: null, path: "/installed-skills/simple/SKILL.md", requires_env: '[]' },
    ]);
    const skills = await listAllSkills(db);
    const simple = skills.find((s) => s.name === "simple");
    expect(simple).toBeDefined();
    expect(simple!.requiresEnv).toBeUndefined();
  });

});

describe("buildSkillsSummaryXml", () => {
  it("includes name attribute and description", () => {
    const xml = buildSkillsSummaryXml([
      { name: "selfie", description: "Take selfies.", emoji: "📸", path: "/skills/selfie/SKILL.md", source: "bundled", available: true },
    ]);
    expect(xml).toContain('<skill name="selfie" available="true">');
    expect(xml).not.toContain("<path>");
    expect(xml).toContain("Take selfies. 📸");
  });

  it("should include env configured status in XML", () => {
    const skills: SkillEntry[] = [{
      name: "notion",
      description: "Notion API",
      path: "/installed-skills/notion/SKILL.md",
      source: "installed",
      available: true,
      requiresEnv: ["NOTION_API_KEY"],
    }];
    const xml = buildSkillsSummaryXml(skills, { notion: { NOTION_API_KEY: "ntn_xxx" } });
    expect(xml).toContain('configured="true"');
  });

  it("should show configured=false when secret missing", () => {
    const skills: SkillEntry[] = [{
      name: "notion",
      description: "Notion API",
      path: "/installed-skills/notion/SKILL.md",
      source: "installed",
      available: true,
      requiresEnv: ["NOTION_API_KEY"],
    }];
    const xml = buildSkillsSummaryXml(skills, {});
    expect(xml).toContain('configured="false"');
  });

  it("should not include env tags for skills without requiresEnv and no secrets", () => {
    const skills: SkillEntry[] = [{
      name: "weather",
      description: "Weather",
      path: "/skills/weather/SKILL.md",
      source: "bundled",
      available: true,
    }];
    const xml = buildSkillsSummaryXml(skills);
    expect(xml).not.toContain("<env");
  });

  it("should show env tags from configured secrets even when requiresEnv is empty", () => {
    const skills: SkillEntry[] = [{
      name: "firecrawl",
      description: "Web scraping",
      path: "/installed-skills/firecrawl/SKILL.md",
      source: "installed",
      available: true,
      // requiresEnv is undefined (SKILL.md didn't declare it)
    }];
    const xml = buildSkillsSummaryXml(skills, { firecrawl: { FIRECRAWL_API_KEY: "fc-xxx" } });
    expect(xml).toContain('name="FIRECRAWL_API_KEY"');
    expect(xml).toContain('configured="true"');
  });

  it("escapes XML special characters in description and emoji", () => {
    const skills: SkillEntry[] = [
      {
        name: "test",
        description: 'Has <tags> & "quotes"',
        emoji: undefined,
        path: "/skills/test/SKILL.md",
        source: "installed",
        available: true,
      },
    ];
    const xml = buildSkillsSummaryXml(skills);
    expect(xml).toContain("&lt;tags&gt;");
    expect(xml).toContain("&amp;");
    expect(xml).toContain("&quot;quotes&quot;");
    expect(xml).not.toContain("<tags>");
  });
});

describe("BUNDLED_SKILL_META sync", () => {
  it("has the same skill names as BUILTIN_SKILLS", () => {
    const builtinNames = Object.keys(BUILTIN_SKILLS).sort();
    const metaNames = BUNDLED_SKILL_META.map((m) => m.name).sort();
    expect(metaNames).toEqual(builtinNames);
  });
});

describe("buildSkillsSummaryWithD1", () => {
  it("returns XML summary with bundled and installed skills", async () => {
    const db = createMockD1([
      { name: "my-tool", description: "Custom tool.", emoji: "🔧", path: "/installed-skills/my-tool/SKILL.md" },
    ]);
    const summary = await buildSkillsSummaryWithD1(db);
    expect(summary).toContain("<skills>");
    expect(summary).toContain("my-tool");
    expect(summary).toContain("Custom tool.");
    expect(summary).toContain("selfie");
  });

  it("filters by enabledSkills", async () => {
    const db = createMockD1();
    const summary = await buildSkillsSummaryWithD1(db, undefined, ["selfie"]);
    expect(summary).toContain("selfie");
    expect(summary).not.toContain("weather");
  });
});
