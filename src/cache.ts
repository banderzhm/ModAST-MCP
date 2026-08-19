import { promises as fs } from "node:fs";
import path from "node:path";

export interface CacheCleanupResult {
  bytesRemoved: number;
  entriesRemoved: number;
  errors: string[];
  retainedEntries: number;
}

export interface CachePolicy {
  maxBytes: number;
  maxEntries: number;
  ttlMs: number;
}

interface CacheEntry {
  bytes: number;
  modifiedAt: number;
  path: string;
}

async function inspectDirectory(directory: string): Promise<CacheEntry> {
  let bytes = 0;
  let modifiedAt = (await fs.stat(directory)).mtimeMs;
  const visit = async (current: string): Promise<void> => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile()) {
        const stat = await fs.stat(fullPath);
        bytes += stat.size;
        modifiedAt = Math.max(modifiedAt, stat.mtimeMs);
      }
    }
  };
  await visit(directory);
  return { bytes, modifiedAt, path: directory };
}

export async function pruneWorkspaceCaches(
  cacheRoot: string,
  currentKey: string,
  policy: CachePolicy = { maxBytes: 512 * 1024 * 1024, maxEntries: 20, ttlMs: 14 * 24 * 60 * 60 * 1000 },
): Promise<CacheCleanupResult> {
  const result: CacheCleanupResult = { bytesRemoved: 0, entriesRemoved: 0, errors: [], retainedEntries: 0 };
  await fs.mkdir(cacheRoot, { recursive: true });
  const entries = await fs.readdir(cacheRoot, { withFileTypes: true });
  const candidates: CacheEntry[] = [];
  for (const entry of entries.filter((candidate) => candidate.isDirectory() && candidate.name !== currentKey)) {
    try {
      candidates.push(await inspectDirectory(path.join(cacheRoot, entry.name)));
    } catch (error) {
      result.errors.push(`Could not inspect cache ${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  candidates.sort((left, right) => right.modifiedAt - left.modifiedAt);
  const now = Date.now();
  let retainedBytes = 0;
  let retainedEntries = 0;
  for (const entry of candidates) {
    const expired = now - entry.modifiedAt > policy.ttlMs;
    const overEntries = retainedEntries >= policy.maxEntries;
    const overBytes = retainedBytes + entry.bytes > policy.maxBytes;
    if (expired || overEntries || overBytes) {
      const resolved = path.resolve(entry.path);
      const root = `${path.resolve(cacheRoot)}${path.sep}`;
      if (!resolved.startsWith(root)) {
        result.errors.push(`Refused unsafe cache path: ${resolved}`);
        continue;
      }
      try {
        await fs.rm(resolved, { force: true, maxRetries: 3, recursive: true, retryDelay: 100 });
        result.bytesRemoved += entry.bytes;
        result.entriesRemoved += 1;
      } catch (error) {
        result.errors.push(error instanceof Error ? error.message : String(error));
      }
    } else {
      retainedBytes += entry.bytes;
      retainedEntries += 1;
    }
  }
  result.retainedEntries = retainedEntries + (entries.some((entry) => entry.isDirectory() && entry.name === currentKey) ? 1 : 0);
  return result;
}
