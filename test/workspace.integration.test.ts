import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { windowsToWsl } from "../src/util/paths.js";
import { Workspace } from "../src/workspace.js";

const integration = process.env.MODAST_INTEGRATION === "1" ? describe : describe.skip;

integration("live workspace updates", () => {
  it("sends didChange and reuses unchanged cache files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "modast-live-"));
    const build = path.join(root, "build");
    const source = path.join(root, "main.cpp");
    const workspace = new Workspace();
    try {
      await fs.mkdir(build, { recursive: true });
      await fs.writeFile(source, "int before_edit() { return 1; }\n");
      await fs.writeFile(path.join(build, "compile_commands.json"), JSON.stringify([{
        command: `clang++ -std=c++23 -c ${windowsToWsl(source)}`,
        directory: windowsToWsl(build),
        file: windowsToWsl(source),
        output: `${windowsToWsl(build)}/main.cpp.o`,
      }]));
      await workspace.open({
        buildDirectory: build,
        experimentalModules: false,
        mode: "cpp",
        root,
        transport: "wsl",
        wslDistro: "Arch",
      });
      expect(JSON.stringify(await workspace.documentSymbols(source))).toContain("before_edit");

      await fs.writeFile(source, "int before_edit() { return 1; }\nint after_edit() { return 2; }\n");
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(workspace.status().sourceChanges).toBeGreaterThan(0);
      expect(JSON.stringify(await workspace.documentSymbols(source))).toContain("after_edit");

      await fs.writeFile(source, "int before_edit( ){return 1;}\nint after_edit( ){return 2;}\n");
      const preview = await workspace.format(source, false, 4, true) as { changed: boolean; text: string };
      expect(preview.changed).toBe(true);
      expect(preview.text).toContain("int before_edit() { return 1; }");
      const applied = await workspace.format(source, true, 4, true) as { applied: boolean };
      expect(applied.applied).toBe(true);
      expect(await fs.readFile(source, "utf8")).toContain("int after_edit() { return 2; }");

      const refreshed = await workspace.refresh("integration test");
      expect(refreshed.compileDatabase?.diskWrites).toBe(0);
      expect(refreshed.state).toBe("ready");
    } finally {
      await workspace.close();
      await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 30_000);
});
