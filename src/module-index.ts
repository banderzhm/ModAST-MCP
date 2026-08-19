import { promises as fs } from "node:fs";
import path from "node:path";
import type { ModuleImport, ModuleUnit, ModuleUnitKind } from "./types.js";

const SOURCE_EXTENSIONS = new Set([".cc", ".cpp", ".cxx", ".cppm", ".ixx", ".mpp"]);
const IGNORED_DIRECTORIES = new Set([
  ".git", ".modast", ".vs", ".vscode", "node_modules", "dist", "out",
]);

interface ParsedSource {
  imports: ModuleImport[];
  unit?: Omit<ModuleUnit, "path" | "imports">;
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (value) => value.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\r\n]*/g, "");
}

export function parseModuleSource(source: string): ParsedSource {
  const clean = stripComments(source);
  const imports: ModuleImport[] = [];
  const importPattern = /^\s*(export\s+)?import\s+([^;]+?)\s*;/gm;
  let importMatch: RegExpExecArray | null;
  while ((importMatch = importPattern.exec(clean)) !== null) {
    const target = importMatch[2].trim();
    imports.push({
      exported: Boolean(importMatch[1]),
      headerUnit: target.startsWith("<") || target.startsWith('"'),
      line: clean.slice(0, importMatch.index).split(/\r?\n/).length,
      name: target,
    });
  }

  const declarationPattern = /^\s*(export\s+)?module\s+([^;]+?)\s*;/gm;
  let declaration: RegExpExecArray | null;
  while ((declaration = declarationPattern.exec(clean)) !== null) {
    const name = declaration[2].trim();
    if (!name) continue; // Global module fragment: `module;`.
    const exported = Boolean(declaration[1]);
    const partition = name.includes(":");
    const kind: ModuleUnitKind = partition
      ? (exported ? "partition-interface" : "partition-implementation")
      : (exported ? "interface" : "implementation");
    return {
      imports,
      unit: {
        kind,
        line: clean.slice(0, declaration.index).split(/\r?\n/).length,
        name,
      },
    };
  }
  return { imports };
}

async function walk(directory: string, buildDirectory: string, output: string[]): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)
        || entry.name === "build"
        || entry.name.startsWith("cmake-build-")
        || path.resolve(fullPath) === path.resolve(buildDirectory)) continue;
      await walk(fullPath, buildDirectory, output);
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      output.push(fullPath);
    }
  }
}

export class ModuleIndex {
  readonly importsByFile = new Map<string, ModuleImport[]>();
  readonly units: ModuleUnit[] = [];
  readonly unitsByName = new Map<string, ModuleUnit[]>();

  private constructor(readonly root: string) {}

  static async create(
    root: string,
    buildDirectory: string,
    sourceFiles?: string[],
    progress?: (completed: number, total: number) => void,
  ): Promise<ModuleIndex> {
    const index = new ModuleIndex(path.resolve(root));
    const files: string[] = sourceFiles ? [...new Set(sourceFiles.map((file) => path.resolve(file)))] : [];
    if (!sourceFiles) await walk(index.root, buildDirectory, files);
    const batchSize = 64;
    for (let offset = 0; offset < files.length; offset += batchSize) {
      await Promise.all(files.slice(offset, offset + batchSize).map(async (file) => {
        let source: string;
        try {
          source = await fs.readFile(file, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
          throw error;
        }
        const parsed = parseModuleSource(source);
        if (parsed.imports.length > 0) index.importsByFile.set(path.resolve(file), parsed.imports);
        if (parsed.unit) {
          const unit: ModuleUnit = { ...parsed.unit, imports: parsed.imports, path: path.resolve(file) };
          index.units.push(unit);
          const group = index.unitsByName.get(unit.name) ?? [];
          group.push(unit);
          index.unitsByName.set(unit.name, group);
        }
      }));
      progress?.(Math.min(offset + batchSize, files.length), files.length);
    }
    index.units.sort((left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path));
    return index;
  }

  search(query: string): ModuleUnit[] {
    const normalized = query.toLowerCase();
    return this.units.filter((unit) => unit.name.toLowerCase().includes(normalized));
  }

  updateFile(file: string, source?: string): ModuleUnit | undefined {
    const absolute = path.resolve(file);
    const previous = this.units.find((unit) => path.resolve(unit.path) === absolute);
    this.removeFile(absolute);
    if (source === undefined) return previous;
    const parsed = parseModuleSource(source);
    if (parsed.imports.length > 0) this.importsByFile.set(absolute, parsed.imports);
    if (!parsed.unit) return previous;
    const unit: ModuleUnit = { ...parsed.unit, imports: parsed.imports, path: absolute };
    this.units.push(unit);
    this.units.sort((left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path));
    const group = this.unitsByName.get(unit.name) ?? [];
    group.push(unit);
    this.unitsByName.set(unit.name, group);
    return previous;
  }

  removeFile(file: string): void {
    const absolute = path.resolve(file);
    this.importsByFile.delete(absolute);
    for (let index = this.units.length - 1; index >= 0; index -= 1) {
      const unit = this.units[index];
      if (path.resolve(unit.path) !== absolute) continue;
      this.units.splice(index, 1);
      const group = (this.unitsByName.get(unit.name) ?? []).filter((candidate) => path.resolve(candidate.path) !== absolute);
      if (group.length > 0) this.unitsByName.set(unit.name, group);
      else this.unitsByName.delete(unit.name);
    }
  }

  dependencies(name: string, transitive = false): string[] {
    const seen = new Set<string>();
    const visit = (moduleName: string): void => {
      for (const unit of this.unitsByName.get(moduleName) ?? []) {
        for (const imported of unit.imports) {
          if (imported.headerUnit || seen.has(imported.name)) continue;
          seen.add(imported.name);
          if (transitive) visit(imported.name.startsWith(":")
            ? `${moduleName.split(":")[0]}${imported.name}`
            : imported.name);
        }
      }
    };
    visit(name);
    return [...seen].sort();
  }

  importers(name: string): string[] {
    const paths: string[] = [];
    for (const [file, imports] of this.importsByFile) {
      if (imports.some((item) => item.name === name)) paths.push(file);
    }
    return paths.sort();
  }
}
