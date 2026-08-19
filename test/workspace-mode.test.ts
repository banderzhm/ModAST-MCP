import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectWorkspaceMode } from "../src/workspace.js";

async function detect(command: { arguments?: string[]; command?: string; file: string }): Promise<"cpp" | "modules"> {
  const build = await fs.mkdtemp(path.join(os.tmpdir(), "modast-mode-"));
  try {
    await fs.writeFile(path.join(build, "compile_commands.json"), JSON.stringify([{ directory: build, ...command }]));
    return await detectWorkspaceMode(build);
  } finally {
    await fs.rm(build, { recursive: true, force: true });
  }
}

describe("workspace mode detection", () => {
  it("recognizes conventional module extensions", async () => {
    await expect(detect({ command: "clang++ -c net.cppm", file: "net.cppm" })).resolves.toBe("modules");
  });

  it("recognizes module interfaces stored as .cpp", async () => {
    await expect(detect({ command: "clang++ -x c++-module -c net.cpp", file: "net.cpp" })).resolves.toBe("modules");
    await expect(detect({ arguments: ["cl", "/interface", "net.cpp"], file: "net.cpp" })).resolves.toBe("modules");
  });

  it("keeps ordinary translation units in cpp mode", async () => {
    await expect(detect({ command: "clang++ -std=c++23 -c main.cpp", file: "main.cpp" })).resolves.toBe("cpp");
  });
});
