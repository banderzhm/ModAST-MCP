import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { prepareCompileDatabase } from "../src/compile-database.js";

describe("compile database augmentation", () => {
  it("adds a generated response file for an importer with a known PCM", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "modast-cdb-"));
    const build = path.join(root, "build");
    const cache = path.join(root, "cache");
    try {
      await fs.mkdir(path.join(build, "obj"), { recursive: true });
      const source = path.join(root, "main.cpp");
      await fs.writeFile(source, "import demo.core;\nint main() {}\n");
      await fs.writeFile(path.join(build, "obj", "demo.core.pcm"), "fixture");
      await fs.writeFile(path.join(build, "compile_commands.json"), JSON.stringify([{
        command: `clang++ -std=c++23 -c ${source}`,
        directory: build,
        file: source,
        output: path.join(build, "obj", "main.cpp.o"),
      }]));

      const prepared = await prepareCompileDatabase(build, cache);
      expect(prepared.info.generatedModuleMaps).toBe(1);
      expect(prepared.info.unresolvedImports).toBe(0);
      const enhanced = JSON.parse(await fs.readFile(path.join(cache, "compile_commands.json"), "utf8"));
      expect(enhanced[0].command).toContain("all-pcms-native.modmap");
      const response = await fs.readFile(path.join(cache, "modmaps", "all-pcms-native.modmap"), "utf8");
      expect(response).toContain("demo.core=");
      const second = await prepareCompileDatabase(build, cache);
      expect(second.info.diskWrites).toBe(0);
      expect(second.info.cacheFilesReused).toBe(2);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
