import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ModuleIndex, parseModuleSource } from "../src/module-index.js";

describe("module parser", () => {
  it("parses interfaces, partitions, imports, and header units", () => {
    const parsed = parseModuleSource(`
      module;
      export module demo.net:tcp;
      import std;
      export import demo.net:types;
      import <vector>;
    `);
    expect(parsed.unit).toMatchObject({ kind: "partition-interface", name: "demo.net:tcp" });
    expect(parsed.imports).toEqual([
      { exported: false, headerUnit: false, line: 4, name: "std" },
      { exported: true, headerUnit: false, line: 5, name: "demo.net:types" },
      { exported: false, headerUnit: true, line: 6, name: "<vector>" },
    ]);
  });

  it("does not treat a global module fragment as a module declaration", () => {
    expect(parseModuleSource("module;\n#include <x>\n")).toMatchObject({ imports: [] });
  });
});

describe("module index", () => {
  it("can search and resolve importers", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "modast-index-"));
    try {
      await fs.writeFile(path.join(root, "address.cppm"), "export module demo.address;\nexport class address {};\n");
      await fs.writeFile(path.join(root, "main.cpp"), "import demo.address;\nint main() {}\n");
      const index = await ModuleIndex.create(root, path.join(root, "build"));
      expect(index.unitsByName.has("demo.address")).toBe(true);
      expect(index.search("demo.address")).toHaveLength(1);
      expect(index.importers("demo.address")).toEqual([path.join(root, "main.cpp")]);
      index.updateFile(path.join(root, "main.cpp"), "import demo.other;\nint main() {}\n");
      expect(index.importers("demo.address")).toEqual([]);
      expect(index.importers("demo.other")).toEqual([path.join(root, "main.cpp")]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
