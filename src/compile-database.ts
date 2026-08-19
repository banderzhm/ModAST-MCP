import { promises as fs } from "node:fs";
import path from "node:path";
import type { CompileCommand } from "./types.js";
import { windowsToWsl, wslToWindows } from "./util/paths.js";

export interface CompileDatabaseInfo {
  augmentedCommands: number;
  commands: number;
  directory: string;
  missingModuleMaps: number;
  generatedModuleMaps: number;
  moduleCommands: number;
  moduleMaps: number;
  pcmFiles: number;
  unresolvedImports: number;
  cacheFilesReused: number;
  diskWrites: number;
}

export interface PreparedCompileDatabase {
  artifactFiles: string[];
  info: CompileDatabaseInfo;
  modulePcms: Map<string, string>;
  sourceFiles: string[];
}

async function exists(value: string): Promise<boolean> {
  try {
    await fs.access(value);
    return true;
  } catch {
    return false;
  }
}

interface PcmInventory {
  artifacts: Set<string>;
  modules: Map<string, string>;
}

async function collectPcmFiles(root: string): Promise<PcmInventory> {
  const files = new Map<string, string>();
  const artifacts = new Set<string>();
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile() && entry.name.endsWith(".pcm")) {
        artifacts.add(fullPath);
        const moduleName = entry.name.slice(0, -4);
        if (!files.has(moduleName)) files.set(moduleName, fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".modmap")) {
        artifacts.add(fullPath);
        const contents = await fs.readFile(fullPath, "utf8");
        const pattern = /-fmodule-file=\"?([^=\"\r\n]+)=([^\"\r\n]+)\"?/g;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(contents)) !== null) {
          const pcm = path.isAbsolute(match[2]) ? match[2] : path.resolve(root, match[2]);
          if (!files.has(match[1])) files.set(match[1], pcm);
        }
      }
    }
  };
  await visit(root);
  return { artifacts, modules: files };
}

async function writeIfChanged(file: string, contents: string): Promise<boolean> {
  try {
    if (await fs.readFile(file, "utf8") === contents) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
  return true;
}

function importedModules(source: string): string[] {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\r\n]*/g, "");
  const declaration = /^\s*(?:export\s+)?module\s+([^;]+?)\s*;/m.exec(clean)?.[1]?.trim();
  const base = declaration?.split(":")[0];
  const imports: string[] = [];
  const pattern = /^\s*(?:export\s+)?import\s+([^;]+?)\s*;/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(clean)) !== null) {
    let name = match[1].trim();
    if (name.startsWith("<") || name.startsWith('"')) continue;
    if (name.startsWith(":") && base) name = `${base}${name}`;
    imports.push(name);
  }
  return [...new Set(imports)];
}

function resolveFromCommand(command: CompileCommand, value: string): string {
  const directory = command.directory.startsWith("/mnt/") ? wslToWindows(command.directory) : command.directory;
  const candidate = value.startsWith("/mnt/") ? wslToWindows(value) : value;
  return path.isAbsolute(candidate) ? candidate : path.resolve(directory, candidate);
}

function addResponseFile(command: CompileCommand, responseFile: string): CompileCommand {
  const mapped = command.directory.startsWith("/mnt/") ? windowsToWsl(responseFile) : responseFile;
  const argument = `@${mapped.replaceAll("\\", "/")}`;
  if (command.arguments) return { ...command, arguments: [...command.arguments, argument] };
  return { ...command, command: `${command.command ?? ""} "${argument}"` };
}

export async function prepareCompileDatabase(
  buildDirectory: string,
  cacheDirectory: string,
  progress?: (phase: string, completed: number, total: number) => void,
  mode: "cpp" | "modules" = "modules",
): Promise<PreparedCompileDatabase> {
  const inputFile = path.join(buildDirectory, "compile_commands.json");
  if (!(await exists(inputFile))) throw new Error(`compile_commands.json not found in ${buildDirectory}`);
  const commands = JSON.parse(await fs.readFile(inputFile, "utf8")) as CompileCommand[];
  progress?.("load-cdb", commands.length, commands.length);
  const inventory = mode === "cpp" ? { artifacts: new Set<string>(), modules: new Map<string, string>() } : await collectPcmFiles(buildDirectory);
  const pcmFiles = inventory.modules;
  let augmentedCommands = 0;
  let missingModuleMaps = 0;
  let moduleCommands = 0;
  let moduleMaps = 0;
  let generatedModuleMaps = 0;
  let unresolvedImports = 0;
  let diskWrites = 0;
  let cacheFilesReused = 0;
  const generatedMapDirectory = path.join(cacheDirectory, "modmaps");
  await fs.mkdir(generatedMapDirectory, { recursive: true });
  const sharedMaps = new Map<"native" | "wsl", string>();
  const sharedMap = async (kind: "native" | "wsl"): Promise<string> => {
    const existing = sharedMaps.get(kind);
    if (existing) return existing;
    const responseFile = path.join(generatedMapDirectory, `all-pcms-${kind}.modmap`);
    const flags = [...pcmFiles.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([name, pcm]) => {
      const mapped = kind === "wsl" ? windowsToWsl(pcm) : pcm.replaceAll("\\", "/");
      return `-fmodule-file=\"${name}=${mapped}\"`;
    });
    if (await writeIfChanged(responseFile, `${flags.join("\n")}\n`)) diskWrites += 1;
    else cacheFilesReused += 1;
    sharedMaps.set(kind, responseFile);
    return responseFile;
  };

  const enhanced: CompileCommand[] = new Array(commands.length);
  const batchSize = 64;
  for (let offset = 0; offset < commands.length; offset += batchSize) {
    await Promise.all(commands.slice(offset, offset + batchSize).map(async (command, batchIndex) => {
    const extension = path.extname(command.file).toLowerCase();
    if ([".cppm", ".ixx", ".mpp"].includes(extension)) moduleCommands += 1;
    const output = command.output ? resolveFromCommand(command, command.output) : undefined;
    const moduleMap = output ? `${output}.modmap` : undefined;
    const hasMap = moduleMap ? await exists(moduleMap) : false;
    if (mode === "cpp") {
      enhanced[offset + batchIndex] = command;
    } else if (hasMap && !JSON.stringify(command).includes(".modmap")) {
      enhanced[offset + batchIndex] = addResponseFile(command, moduleMap!);
      augmentedCommands += 1;
      moduleMaps += 1;
    } else if (!hasMap && output) {
      const sourceFile = resolveFromCommand(command, command.file);
      let imports: string[] = [];
      try {
        imports = importedModules(await fs.readFile(sourceFile, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const resolved = imports.flatMap((name) => {
        const pcm = pcmFiles.get(name);
        if (!pcm) {
          unresolvedImports += 1;
          return [];
        }
        return [pcm];
      });
      if (resolved.length > 0) {
        const generatedMap = await sharedMap(command.directory.startsWith("/mnt/") ? "wsl" : "native");
        enhanced[offset + batchIndex] = addResponseFile(command, generatedMap);
        augmentedCommands += 1;
        generatedModuleMaps += 1;
      } else {
        enhanced[offset + batchIndex] = command;
        missingModuleMaps += 1;
      }
    } else {
      enhanced[offset + batchIndex] = command;
      if (hasMap) moduleMaps += 1;
      else if (output && ![".c", ".m", ".mm"].includes(extension)) missingModuleMaps += 1;
    }}));
    progress?.("augment-modmaps", Math.min(offset + batchSize, commands.length), commands.length);
  }

  const databaseContents = `${JSON.stringify(enhanced, null, 2)}\n`;
  if (await writeIfChanged(path.join(cacheDirectory, "compile_commands.json"), databaseContents)) diskWrites += 1;
  else cacheFilesReused += 1;
  const info = {
    augmentedCommands,
    commands: commands.length,
    directory: cacheDirectory,
    missingModuleMaps,
    generatedModuleMaps,
    moduleCommands,
    moduleMaps,
    pcmFiles: pcmFiles.size,
    unresolvedImports,
    cacheFilesReused,
    diskWrites,
  };
  const sourceFiles = commands.map((command) => {
    const value = command.file.startsWith("/mnt/") ? wslToWindows(command.file) : command.file;
    return path.isAbsolute(value) ? value : path.resolve(
      command.directory.startsWith("/mnt/") ? wslToWindows(command.directory) : command.directory,
      value,
    );
  });
  return { artifactFiles: [...inventory.artifacts], info, modulePcms: inventory.modules, sourceFiles };
}
