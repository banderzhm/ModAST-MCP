import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pruneWorkspaceCaches } from "../src/cache.js";

async function cacheEntry(root: string, name: string, contents: string, ageMs = 0): Promise<void> {
  const directory = path.join(root, name);
  const file = path.join(directory, "compile-db", "compile_commands.json");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
  const date = new Date(Date.now() - ageMs);
  await fs.utimes(file, date, date);
  await fs.utimes(directory, date, date);
}

describe("workspace cache pruning", () => {
  it("keeps the active cache and removes expired entries", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "modast-cache-"));
    try {
      await cacheEntry(root, "current", "active");
      await cacheEntry(root, "stale", "old", 10_000);
      const result = await pruneWorkspaceCaches(root, "current", { maxBytes: 1000, maxEntries: 10, ttlMs: 1_000 });
      expect(result.entriesRemoved).toBe(1);
      await expect(fs.access(path.join(root, "current"))).resolves.toBeUndefined();
      await expect(fs.access(path.join(root, "stale"))).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("enforces entry and byte limits without deleting the active key", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "modast-cache-"));
    try {
      await cacheEntry(root, "current", "active");
      await cacheEntry(root, "newest", "1234");
      await cacheEntry(root, "older", "5678", 100);
      const result = await pruneWorkspaceCaches(root, "current", { maxBytes: 4, maxEntries: 1, ttlMs: 60_000 });
      expect(result.entriesRemoved).toBe(1);
      expect(result.retainedEntries).toBe(2);
      await expect(fs.access(path.join(root, "current"))).resolves.toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
