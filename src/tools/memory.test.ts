import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMemoryTools } from "./memory";

// Mock the D1 functions
vi.mock("../db/d1", () => ({
  getMemory: vi.fn(),
  upsertMemory: vi.fn(),
  insertHistoryEntry: vi.fn(),
  getHistoryEntries: vi.fn(),
  searchHistoryEntries: vi.fn(),
}));

import {
  getMemory,
  upsertMemory,
  insertHistoryEntry,
  getHistoryEntries,
  searchHistoryEntries,
} from "../db/d1";

const mockGetMemory = vi.mocked(getMemory);
const mockUpsertMemory = vi.mocked(upsertMemory);
const mockInsertHistoryEntry = vi.mocked(insertHistoryEntry);
const mockGetHistoryEntries = vi.mocked(getHistoryEntries);
const mockSearchHistoryEntries = vi.mocked(searchHistoryEntries);

describe("createMemoryTools", () => {
  const botId = "bot-001";
  const db = {} as D1Database;
  let tools: ReturnType<typeof createMemoryTools>;

  beforeEach(() => {
    vi.clearAllMocks();
    tools = createMemoryTools(db, botId);
  });

  describe("memory_read", () => {
    it("reads existing MEMORY.md", async () => {
      mockGetMemory.mockResolvedValue("Hello");
      const result = await (tools.memory_read as any).execute({ file: "MEMORY.md" });
      expect(result).toBe("Hello");
      expect(mockGetMemory).toHaveBeenCalledWith(db, botId);
    });

    it("returns (empty) for missing MEMORY.md", async () => {
      mockGetMemory.mockResolvedValue("");
      const result = await (tools.memory_read as any).execute({ file: "MEMORY.md" });
      expect(result).toBe("(empty)");
    });

    it("reads HISTORY.md entries", async () => {
      mockGetHistoryEntries.mockResolvedValue([
        { id: 1, content: "Entry 1", created_at: "2026-01-01" },
        { id: 2, content: "Entry 2", created_at: "2026-01-02" },
      ]);
      const result = await (tools.memory_read as any).execute({ file: "HISTORY.md" });
      expect(result).toBe("Entry 1\n\nEntry 2");
      expect(mockGetHistoryEntries).toHaveBeenCalledWith(db, botId, 100);
    });

    it("returns (empty) for HISTORY.md with no entries", async () => {
      mockGetHistoryEntries.mockResolvedValue([]);
      const result = await (tools.memory_read as any).execute({ file: "HISTORY.md" });
      expect(result).toBe("(empty)");
    });
  });

  describe("memory_write", () => {
    it("writes MEMORY.md content", async () => {
      const result = await (tools.memory_write as any).execute({
        file: "MEMORY.md",
        content: "New content",
      });
      expect(mockUpsertMemory).toHaveBeenCalledWith(db, botId, "New content");
      expect(result).toContain("11 characters");
    });

    it("rejects writing to HISTORY.md", async () => {
      const result = await (tools.memory_write as any).execute({
        file: "HISTORY.md",
        content: "Overwrite attempt",
      });
      expect(result).toContain("Cannot overwrite HISTORY.md");
      expect(result).toContain("memory_append");
      expect(mockUpsertMemory).not.toHaveBeenCalled();
    });
  });

  describe("memory_append", () => {
    it("appends to existing MEMORY.md content", async () => {
      mockGetMemory.mockResolvedValue("Line 1");
      await (tools.memory_append as any).execute({
        file: "MEMORY.md",
        content: "Line 2",
      });
      expect(mockUpsertMemory).toHaveBeenCalledWith(db, botId, "Line 1\nLine 2");
    });

    it("writes directly when MEMORY.md is empty", async () => {
      mockGetMemory.mockResolvedValue("");
      await (tools.memory_append as any).execute({
        file: "MEMORY.md",
        content: "First line",
      });
      expect(mockUpsertMemory).toHaveBeenCalledWith(db, botId, "First line");
    });

    it("inserts history entry for HISTORY.md", async () => {
      const result = await (tools.memory_append as any).execute({
        file: "HISTORY.md",
        content: "New event happened",
      });
      expect(mockInsertHistoryEntry).toHaveBeenCalledWith(db, botId, "New event happened");
      expect(result).toBe("Appended to HISTORY.md");
      expect(mockUpsertMemory).not.toHaveBeenCalled();
    });
  });

  describe("memory_edit", () => {
    it("replaces matching text in MEMORY.md", async () => {
      mockGetMemory.mockResolvedValue("Name: Alice\nCity: Beijing");
      const result = await (tools.memory_edit as any).execute({
        file: "MEMORY.md",
        old_string: "City: Beijing",
        new_string: "City: Shanghai",
      });
      expect(mockUpsertMemory).toHaveBeenCalledWith(
        db,
        botId,
        "Name: Alice\nCity: Shanghai"
      );
      expect(result).toContain("Edited");
    });

    it("returns error when MEMORY.md is empty", async () => {
      mockGetMemory.mockResolvedValue("");
      const result = await (tools.memory_edit as any).execute({
        file: "MEMORY.md",
        old_string: "anything",
        new_string: "new",
      });
      expect(result).toContain("empty");
      expect(mockUpsertMemory).not.toHaveBeenCalled();
    });

    it("returns error when old_string not found", async () => {
      mockGetMemory.mockResolvedValue("Name: Alice");
      const result = await (tools.memory_edit as any).execute({
        file: "MEMORY.md",
        old_string: "Name: Bob",
        new_string: "Name: Charlie",
      });
      expect(result).toContain("not found");
      expect(mockUpsertMemory).not.toHaveBeenCalled();
    });

    it("returns error when old_string matches multiple times", async () => {
      mockGetMemory.mockResolvedValue("likes cats\nlikes dogs\nlikes cats");
      const result = await (tools.memory_edit as any).execute({
        file: "MEMORY.md",
        old_string: "likes cats",
        new_string: "likes birds",
      });
      expect(result).toContain("2 times");
      expect(mockUpsertMemory).not.toHaveBeenCalled();
    });

    it("rejects editing HISTORY.md", async () => {
      const result = await (tools.memory_edit as any).execute({
        file: "HISTORY.md",
        old_string: "old text",
        new_string: "new text",
      });
      expect(result).toContain("Cannot edit");
      expect(result).toContain("immutable");
      expect(mockGetMemory).not.toHaveBeenCalled();
      expect(mockUpsertMemory).not.toHaveBeenCalled();
    });
  });

  describe("memory_grep", () => {
    it("searches HISTORY.md using searchHistoryEntries", async () => {
      mockSearchHistoryEntries.mockResolvedValue([
        { id: 2, content: "[2026-02-21] Deployed to Cloudflare", created_at: "2026-02-21" },
        { id: 3, content: "[2026-02-21] Added memory system", created_at: "2026-02-21" },
      ]);
      const result = await (tools.memory_grep as any).execute({
        file: "HISTORY.md",
        query: "2026-02-21",
      });
      expect(result).toContain("Deployed to Cloudflare");
      expect(result).toContain("Added memory system");
      expect(mockSearchHistoryEntries).toHaveBeenCalledWith(db, botId, "2026-02-21");
    });

    it("returns no matches for HISTORY.md when search finds nothing", async () => {
      mockSearchHistoryEntries.mockResolvedValue([]);
      const result = await (tools.memory_grep as any).execute({
        file: "HISTORY.md",
        query: "nonexistent",
      });
      expect(result).toContain("No matches");
    });

    it("searches MEMORY.md line-by-line (case-insensitive)", async () => {
      mockGetMemory.mockResolvedValue("Name: Alice\nCity: Beijing");
      const result = await (tools.memory_grep as any).execute({
        file: "MEMORY.md",
        query: "alice",
      });
      expect(result).toContain("Alice");
    });

    it("returns no matches message for empty MEMORY.md", async () => {
      mockGetMemory.mockResolvedValue("");
      const result = await (tools.memory_grep as any).execute({
        file: "MEMORY.md",
        query: "test",
      });
      expect(result).toContain("empty");
    });

    it("returns no matches message when nothing found in MEMORY.md", async () => {
      mockGetMemory.mockResolvedValue("Name: Alice");
      const result = await (tools.memory_grep as any).execute({
        file: "MEMORY.md",
        query: "Bob",
      });
      expect(result).toContain("No matches");
    });
  });
});
