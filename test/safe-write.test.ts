import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileConflictError, replaceFileIfUnchanged } from "../src/util/safe-write.js";

describe("conflict-safe writes", () => {
  it("atomically replaces unchanged content", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "modast-write-"));
    const file = path.join(root, "sample.cpp");
    try {
      await fs.writeFile(file, "old\n");
      await replaceFileIfUnchanged(file, "old\n", "new\n");
      expect(await fs.readFile(file, "utf8")).toBe("new\n");
      expect((await fs.readdir(root)).filter((name) => name.includes(".modast-"))).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite a concurrent edit", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "modast-write-"));
    const file = path.join(root, "sample.cpp");
    try {
      await fs.writeFile(file, "newer editor content\n");
      await expect(replaceFileIfUnchanged(file, "stale snapshot\n", "formatted stale snapshot\n"))
        .rejects.toBeInstanceOf(FileConflictError);
      expect(await fs.readFile(file, "utf8")).toBe("newer editor content\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
