import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { pruneWorkspaceCaches, type CacheCleanupResult } from "./cache.js";
import { prepareCompileDatabase, type CompileDatabaseInfo } from "./compile-database.js";
import { LspClient } from "./lsp-client.js";
import { ModuleIndex } from "./module-index.js";
import { analyzeModuleInterfaceAst } from "./module-quality.js";
import type { AstNode, ModuleUnit, Position, Range, WorkspaceOptions, WorkspaceState } from "./types.js";
import { fileUri, normalizeFsPath, uriToDisplayPath, wslToWindows } from "./util/paths.js";
import { positionOf } from "./util/text.js";
import { replaceFileIfUnchanged } from "./util/safe-write.js";

function applyTextEdits(source: string, edits: Array<{ newText: string; range: Range }>): string {
  const lineOffsets: number[] = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") lineOffsets.push(index + 1);
  }
  const offset = (position: Position): number => (lineOffsets[position.line] ?? source.length) + position.character;
  return [...edits]
    .sort((left, right) => offset(right.range.start) - offset(left.range.start))
    .reduce((text, edit) => {
      const start = offset(edit.range.start);
      const end = offset(edit.range.end);
      return text.slice(0, start) + edit.newText + text.slice(end);
    }, source);
}

interface DiagnosticState {
  diagnostics: unknown[];
  version?: number;
}

export async function detectWorkspaceMode(buildDirectory: string): Promise<"cpp" | "modules"> {
  const commands = JSON.parse(await fs.readFile(path.join(buildDirectory, "compile_commands.json"), "utf8")) as Array<{
    arguments?: string[];
    command?: string;
    file: string;
  }>;
  const moduleFlag = /(?:^|\s)(?:-x\s*c\+\+-module|-fmodule-output(?:=|\s)|-emit-module-interface|\/interface(?:\s|$)|\/ifcOutput(?:\s|$))/i;
  return commands.some((command) => {
    if ([".cppm", ".ixx", ".mpp"].includes(path.extname(command.file).toLowerCase())) return true;
    const invocation = command.arguments?.join(" ") ?? command.command ?? "";
    return moduleFlag.test(invocation);
  })
    ? "modules"
    : "cpp";
}

export interface WorkspaceStatus {
  clangdErrors: string[];
  compileDatabase?: CompileDatabaseInfo;
  diagnosticsFiles: number;
  experimentalModules?: boolean;
  importers: number;
  message?: string;
  mode?: "cpp" | "modules";
  elapsedMs: number;
  events: string[];
  phase: string;
  progressCompleted: number;
  progressTotal: number;
  modules: number;
  openFiles: number;
  root?: string;
  state: WorkspaceState;
  transport?: string;
  warmCompleted: number;
  warmTotal: number;
  watchedFiles: number;
  sourceChanges: number;
  staleModules: string[];
  lastChangeAt?: string;
  refreshes: number;
  cacheCleanup?: CacheCleanupResult;
}

export class Workspace {
  private client?: LspClient;
  private compileInfo?: CompileDatabaseInfo;
  private diagnostics = new Map<string, DiagnosticState>();
  private index?: ModuleIndex;
  private message?: string;
  private readonly events: string[] = [];
  private phase = "idle";
  private progressCompleted = 0;
  private progressTotal = 0;
  private startedAt = 0;
  private options?: WorkspaceOptions;
  private readonly openFiles = new Map<string, string>();
  private readonly documentVersions = new Map<string, number>();
  private watcher?: FSWatcher;
  private readonly watchedSources = new Set<string>();
  private readonly watchedArtifacts = new Set<string>();
  private readonly staleModules = new Set<string>();
  private modulePcms = new Map<string, string>();
  private cacheDirectory?: string;
  private refreshTimer?: NodeJS.Timeout;
  private refreshPromise?: Promise<WorkspaceStatus>;
  private sourceChanges = 0;
  private lastChangeAt?: string;
  private refreshes = 0;
  private cacheCleanup?: CacheCleanupResult;
  private closePromise?: Promise<void>;
  private closing = false;
  private state: WorkspaceState = "closed";
  private warmCompleted = 0;
  private warmTotal = 0;
  private warmPromise?: Promise<void>;

  async open(
    options: WorkspaceOptions,
    progress?: (phase: string, completed: number, total: number, message: string) => void,
  ): Promise<WorkspaceStatus> {
    await this.close();
    this.closing = false;
    this.state = "starting";
    this.startedAt = Date.now();
    this.message = undefined;
    try {
      const root = path.resolve(options.root);
      const buildDirectory = path.isAbsolute(options.buildDirectory)
        ? options.buildDirectory
        : path.resolve(root, options.buildDirectory);
      const effectiveMode = options.mode === "auto" ? await detectWorkspaceMode(buildDirectory) : options.mode;
      this.options = { ...options, buildDirectory, mode: effectiveMode, root };
      const workspaceKey = createHash("sha256").update(`${root}\0${buildDirectory}`).digest("hex").slice(0, 16);
      const cacheRoot = path.join(os.tmpdir(), "modast-mcp");
      this.cacheCleanup = await pruneWorkspaceCaches(cacheRoot, workspaceKey);
      const cacheDirectory = path.join(cacheRoot, workspaceKey, "compile-db");
      this.cacheDirectory = cacheDirectory;
      this.report("load-cdb", 0, 1, "Loading compile_commands.json", progress);
      const prepared = await prepareCompileDatabase(buildDirectory, cacheDirectory,
        (phase, completed, total) => this.report(phase, completed, total, `${phase}: ${completed}/${total}`, progress), effectiveMode);
      this.compileInfo = prepared.info;
      this.modulePcms = prepared.modulePcms;
      this.report("index-modules", 0, prepared.sourceFiles.length, "Indexing compiled source files", progress);
      this.index = await ModuleIndex.create(root, buildDirectory, prepared.sourceFiles,
        (completed, total) => this.report("index-modules", completed, total, `Indexed ${completed}/${total} source files`, progress));
      await this.recomputeStaleModules();
      this.report("start-clangd", 0, 1, "Starting persistent clangd", progress);
      this.client = new LspClient(this.options, this.compileInfo.directory);
      this.configureClient(this.client);
      await this.client.start();
      await this.startWatcher(prepared.sourceFiles, prepared.artifactFiles);
      this.state = "ready";
      this.report("ready", 1, 1, "Workspace is ready", progress);
      return this.status();
    } catch (error) {
      await this.watcher?.close().catch(() => undefined);
      this.watcher = undefined;
      await this.client?.stop().catch(() => undefined);
      this.client = undefined;
      this.state = "error";
      this.message = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.performClose().finally(() => { this.closePromise = undefined; });
    return this.closePromise;
  }

  private async performClose(): Promise<void> {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    await Promise.allSettled([this.refreshPromise, this.warmPromise].filter(Boolean) as Promise<unknown>[]);
    const watcher = this.watcher;
    const client = this.client;
    this.watcher = undefined;
    this.client = undefined;
    await Promise.allSettled([watcher?.close(), client?.stop()].filter(Boolean) as Promise<unknown>[]);
    this.compileInfo = undefined;
    this.diagnostics.clear();
    this.index = undefined;
    this.openFiles.clear();
    this.documentVersions.clear();
    this.watchedSources.clear();
    this.watchedArtifacts.clear();
    this.staleModules.clear();
    this.modulePcms.clear();
    this.cacheDirectory = undefined;
    this.options = undefined;
    this.state = "closed";
    this.warmCompleted = 0;
    this.warmTotal = 0;
    this.warmPromise = undefined;
    this.refreshPromise = undefined;
    this.sourceChanges = 0;
    this.lastChangeAt = undefined;
    this.refreshes = 0;
    this.cacheCleanup = undefined;
  }

  status(): WorkspaceStatus {
    return {
      clangdErrors: this.client?.errors() ?? [],
      compileDatabase: this.compileInfo,
      diagnosticsFiles: this.diagnostics.size,
      elapsedMs: this.startedAt ? Date.now() - this.startedAt : 0,
      events: [...this.events],
      experimentalModules: this.options?.experimentalModules,
      importers: this.index?.importsByFile.size ?? 0,
      message: this.message,
      mode: this.options?.mode === "auto" ? undefined : this.options?.mode,
      modules: this.index?.units.length ?? 0,
      openFiles: this.openFiles.size,
      phase: this.phase,
      progressCompleted: this.progressCompleted,
      progressTotal: this.progressTotal,
      root: this.options?.root,
      state: this.state,
      transport: this.options?.transport,
      warmCompleted: this.warmCompleted,
      warmTotal: this.warmTotal,
      watchedFiles: this.watchedSources.size + this.watchedArtifacts.size + (this.options ? 1 : 0),
      sourceChanges: this.sourceChanges,
      staleModules: [...this.staleModules].sort(),
      lastChangeAt: this.lastChangeAt,
      refreshes: this.refreshes,
      cacheCleanup: this.cacheCleanup,
    };
  }

  refresh(reason = "manual"): Promise<WorkspaceStatus> {
    if (this.closing) return Promise.reject(new Error("Workspace is closing"));
    if (this.refreshPromise) return this.refreshPromise;
    this.requireReady();
    this.refreshPromise = this.performRefresh(reason)
      .catch((error) => {
        this.state = "error";
        this.message = error instanceof Error ? error.message : String(error);
        throw error;
      })
      .finally(() => { this.refreshPromise = undefined; });
    return this.refreshPromise;
  }

  startWarm(files?: string[], limit = 32): WorkspaceStatus {
    this.requireReady();
    if (this.warmPromise) return this.status();
    const candidates = files?.map((file) => this.resolveFile(file))
      ?? this.defaultWarmFiles(limit);
    this.warmTotal = candidates.length;
    this.warmCompleted = 0;
    this.state = "warming";
    this.warmPromise = (async () => {
      try {
        for (const file of candidates) {
          await this.openDocument(file);
          await this.request("textDocument/documentSymbol", { textDocument: { uri: this.uri(file) } });
          this.warmCompleted += 1;
        }
        this.state = "ready";
      } catch (error) {
        this.state = "error";
        this.message = error instanceof Error ? error.message : String(error);
      } finally {
        this.warmPromise = undefined;
      }
    })();
    return this.status();
  }

  moduleSearch(query: string): unknown {
    this.requireIndex();
    return this.index!.search(query).map((unit) => ({
      ...unit,
      path: normalizeFsPath(unit.path),
      importers: this.index!.importers(unit.name).map(normalizeFsPath),
      stale: this.staleModules.has(unit.name),
    }));
  }

  moduleGraph(name: string, transitive: boolean): unknown {
    this.requireIndex();
    const units = this.index!.unitsByName.get(name) ?? [];
    return {
      dependencies: this.index!.dependencies(name, transitive),
      importers: this.index!.importers(name).map(normalizeFsPath),
      name,
      stale: this.staleModules.has(name),
      units: units.map((unit) => ({ ...unit, path: normalizeFsPath(unit.path) })),
    };
  }

  async moduleQuality(file?: string, minBodyLines = 6, minStatements = 5, concurrency = 4): Promise<unknown> {
    await this.waitForRefresh();
    const interfaces = file
      ? [this.index!.units.find((candidate) => path.resolve(candidate.path) === this.resolveFile(file))].filter(Boolean) as ModuleUnit[]
      : this.index!.units.filter((unit) => ["interface", "partition-interface"].includes(unit.kind));
    if (file && interfaces.length === 0) throw new Error(`Not a module interface unit: ${file}`);
    const results: unknown[] = [];
    for (let offset = 0; offset < interfaces.length; offset += concurrency) {
      const batch = await Promise.all(interfaces.slice(offset, offset + concurrency).map(async (unit) => {
        try {
          return await this.analyzeQualityUnit(unit, minBodyLines, minStatements);
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error), file: normalizeFsPath(unit.path), module: unit.name, warnings: [] };
        }
      }));
      results.push(...batch);
    }
    return {
      checkedInterfaces: interfaces.length,
      filesWithWarnings: results.filter((item) => ((item as { warnings?: unknown[] }).warnings?.length ?? 0) > 0).length,
      results,
      warningCount: results.reduce<number>((sum, item) => sum + ((item as { warnings?: unknown[] }).warnings?.length ?? 0), 0),
    };
  }

  async format(file: string, apply: boolean, tabSize: number, insertSpaces: boolean): Promise<unknown> {
    const absolute = await this.openDocument(this.resolveFile(file));
    const edits = await this.request("textDocument/formatting", {
      options: { insertSpaces, tabSize },
      textDocument: { uri: this.uri(absolute) },
    }) as Array<{ newText: string; range: Range }> | null;
    const original = this.openFiles.get(absolute)!;
    const formatted = edits?.length ? applyTextEdits(original, edits) : original;
    if (apply && formatted !== original) {
      await replaceFileIfUnchanged(absolute, original, formatted);
      await this.applySourceChange(absolute, formatted);
    }
    return {
      applied: apply && formatted !== original,
      changed: formatted !== original,
      edits: this.remap(edits ?? []),
      file: normalizeFsPath(absolute),
      text: apply ? undefined : formatted,
    };
  }

  async ast(file: string, range?: Range): Promise<unknown> {
    const absolute = await this.openDocument(this.resolveFile(file));
    const source = this.openFiles.get(absolute)!;
    const requestedRange = range ?? {
      start: { line: 0, character: 0 },
      end: { line: Math.max(0, source.split(/\r?\n/).length - 1), character: 100_000 },
    };
    const clangdAst = await this.request("textDocument/ast", {
      range: requestedRange,
      textDocument: { uri: this.uri(absolute) },
    });
    const unit = this.index?.units.find((candidate) => path.resolve(candidate.path) === absolute);
    const imports = this.index?.importsByFile.get(absolute) ?? [];
    return {
      clangdAst,
      moduleContext: unit || imports.length > 0 ? { imports, unit } : null,
      warnings: this.warningsForFile(absolute),
    };
  }

  async documentSymbols(file: string): Promise<unknown> {
    const absolute = await this.openDocument(this.resolveFile(file));
    return this.remap(await this.request("textDocument/documentSymbol", { textDocument: { uri: this.uri(absolute) } }));
  }

  async workspaceSymbols(query: string): Promise<unknown> {
    await this.waitForRefresh();
    const symbols = await this.request("workspace/symbol", { query });
    return {
      clangd: this.remap(symbols),
      modules: this.moduleSearch(query),
    };
  }

  async definition(file: string, position: Position, includeHover: boolean): Promise<unknown> {
    const absolute = await this.openDocument(this.resolveFile(file));
    const params = { position, textDocument: { uri: this.uri(absolute) } };
    const [definition, hover] = await Promise.all([
      this.request("textDocument/definition", params),
      includeHover ? this.request("textDocument/hover", params) : Promise.resolve(undefined),
    ]);
    return this.remap({ definition, hover, warnings: this.warningsForFile(absolute) });
  }

  async references(file: string, position: Position, includeDeclaration: boolean): Promise<unknown> {
    const absolute = await this.openDocument(this.resolveFile(file));
    const references = await this.request("textDocument/references", {
      context: { includeDeclaration },
      position,
      textDocument: { uri: this.uri(absolute) },
    });
    return this.remap({ references, warnings: this.warningsForFile(absolute) });
  }

  async diagnosticsFor(file: string): Promise<unknown> {
    const absolute = await this.openDocument(this.resolveFile(file));
    await this.request("textDocument/documentSymbol", { textDocument: { uri: this.uri(absolute) } });
    const uri = this.uri(absolute);
    return this.remap({ file: absolute, ...(this.diagnostics.get(uri) ?? { diagnostics: [] }), warnings: this.warningsForFile(absolute) });
  }

  async locate(file: string, line?: number, character?: number, needle?: string, occurrence = 1): Promise<Position> {
    await this.waitForRefresh();
    const absolute = this.resolveFile(file);
    const source = await fs.readFile(absolute, "utf8");
    if (needle !== undefined) return positionOf(source, needle, occurrence);
    if (line === undefined || character === undefined) {
      throw new Error("Provide either needle or both line and character");
    }
    if (line < 1 || character < 1) throw new Error("line and character are 1-based and must be positive");
    return { line: line - 1, character: character - 1 };
  }

  private async openDocument(absolute: string): Promise<string> {
    await this.waitForRefresh();
    const text = await fs.readFile(absolute, "utf8");
    if (this.openFiles.has(absolute)) {
      if (this.openFiles.get(absolute) !== text) {
        await this.applySourceChange(absolute, text);
      }
      return absolute;
    }
    this.index!.updateFile(absolute, text);
    await this.markUnitStaleIfNeeded(absolute);
    this.openFiles.set(absolute, text);
    this.documentVersions.set(absolute, 1);
    this.client!.notify("textDocument/didOpen", {
      textDocument: { languageId: "cpp", text, uri: this.uri(absolute), version: 1 },
    });
    return absolute;
  }

  private defaultWarmFiles(limit: number): string[] {
    const interfaces = this.index!.units
      .filter((unit) => unit.kind === "interface" || unit.kind === "partition-interface")
      .map((unit) => unit.path);
    return interfaces.slice(0, Math.max(0, limit));
  }

  private async analyzeQualityUnit(unit: ModuleUnit, minBodyLines: number, minStatements: number): Promise<unknown> {
    const absolute = path.resolve(unit.path);
    const alreadyOpen = this.openFiles.has(absolute);
    await this.openDocument(absolute);
    try {
      const source = this.openFiles.get(absolute)!;
      const ast = await this.request("textDocument/ast", {
        range: {
          start: { line: 0, character: 0 },
          end: { line: Math.max(0, source.split(/\r?\n/).length - 1), character: 100_000 },
        },
        textDocument: { uri: this.uri(absolute) },
      }) as AstNode | null;
      const hasImplementationUnit = (this.index!.unitsByName.get(unit.name) ?? []).some((candidate) =>
        ["implementation", "partition-implementation"].includes(candidate.kind)
        && [".cc", ".cpp", ".cxx"].includes(path.extname(candidate.path).toLowerCase()));
      return {
        file: normalizeFsPath(absolute),
        hasImplementationUnit,
        module: unit.name,
        warnings: analyzeModuleInterfaceAst(ast, {
          hasImplementationUnit,
          minBodyLines,
          minStatements,
          moduleName: unit.name,
        }),
      };
    } finally {
      if (!alreadyOpen) this.closeDocument(absolute);
    }
  }

  private closeDocument(file: string): void {
    if (!this.openFiles.has(file) || !this.client) return;
    this.client.notify("textDocument/didClose", { textDocument: { uri: this.uri(file) } });
    this.openFiles.delete(file);
    this.documentVersions.delete(file);
  }

  private async startWatcher(sourceFiles: string[], artifactFiles: string[]): Promise<void> {
    await this.watcher?.close();
    this.watchedSources.clear();
    this.watchedArtifacts.clear();
    sourceFiles.forEach((file) => this.watchedSources.add(path.resolve(file)));
    artifactFiles.forEach((file) => this.watchedArtifacts.add(path.resolve(file)));
    const compileDatabase = path.join(this.options!.buildDirectory, "compile_commands.json");
    const watched = [...this.watchedSources, ...this.watchedArtifacts, compileDatabase];
    this.watcher = watch(watched, {
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
      ignoreInitial: true,
      persistent: true,
    });
    this.watcher.on("change", (file) => { void this.handleWatchedChange(path.resolve(file), compileDatabase); });
    this.watcher.on("unlink", (file) => { void this.handleWatchedDelete(path.resolve(file), compileDatabase); });
    this.watcher.on("error", (error) => this.recordEvent(`Watcher error: ${String(error)}`));
    await new Promise<void>((resolve) => this.watcher!.once("ready", resolve));
    this.recordEvent(`Watching ${watched.length} development files`);
  }

  private async handleWatchedChange(file: string, compileDatabase: string): Promise<void> {
    if (this.watchedSources.has(file)) {
      const text = await fs.readFile(file, "utf8");
      if (this.openFiles.get(file) === text) return;
      await this.applySourceChange(file, text);
      return;
    }
    if (file === path.resolve(compileDatabase) || this.watchedArtifacts.has(file)) {
      this.scheduleRefresh(file === path.resolve(compileDatabase) ? "compile database changed" : "module artifacts changed");
    }
  }

  private async handleWatchedDelete(file: string, compileDatabase: string): Promise<void> {
    if (this.watchedSources.has(file)) {
      const previous = this.index!.updateFile(file);
      if (previous && ["interface", "partition-interface"].includes(previous.kind)) this.staleModules.add(previous.name);
      if (this.openFiles.has(file)) {
        this.client!.notify("textDocument/didClose", { textDocument: { uri: this.uri(file) } });
        this.openFiles.delete(file);
        this.documentVersions.delete(file);
      }
      this.sourceChanges += 1;
      this.lastChangeAt = new Date().toISOString();
      this.recordEvent(`Source removed from index: ${normalizeFsPath(file)}`);
      return;
    }
    if (file === path.resolve(compileDatabase) || this.watchedArtifacts.has(file)) this.scheduleRefresh("build artifact removed");
  }

  private scheduleRefresh(reason: string): void {
    if (this.closing) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.recordEvent(`Refresh scheduled: ${reason}`);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh(reason).catch((error) => {
        this.state = "error";
        this.message = error instanceof Error ? error.message : String(error);
      });
    }, 750);
  }

  private async performRefresh(reason: string): Promise<WorkspaceStatus> {
    this.state = "refreshing";
    this.recordEvent(`Refreshing workspace: ${reason}`);
    const prepared = await prepareCompileDatabase(this.options!.buildDirectory, this.cacheDirectory!, undefined, this.options!.mode as "cpp" | "modules");
    const nextIndex = await ModuleIndex.create(this.options!.root, this.options!.buildDirectory, prepared.sourceFiles);
    await this.watcher?.close();
    this.watcher = undefined;
    await this.client?.stop();
    this.compileInfo = prepared.info;
    this.index = nextIndex;
    this.modulePcms = prepared.modulePcms;
    await this.recomputeStaleModules();
    this.client = new LspClient(this.options!, this.compileInfo.directory);
    this.configureClient(this.client);
    await this.client.start();
    for (const [file, text] of this.openFiles) {
      const version = this.documentVersions.get(file) ?? 1;
      this.client.notify("textDocument/didOpen", {
        textDocument: { languageId: "cpp", text, uri: this.uri(file), version },
      });
    }
    await this.startWatcher(prepared.sourceFiles, prepared.artifactFiles);
    this.refreshes += 1;
    this.state = "ready";
    this.recordEvent(`Workspace refreshed: ${reason}; disk writes=${prepared.info.diskWrites}`);
    return this.status();
  }

  private async recomputeStaleModules(): Promise<void> {
    this.staleModules.clear();
    for (const unit of this.index!.units) {
      if (!["interface", "partition-interface"].includes(unit.kind)) continue;
      const pcm = this.modulePcms.get(unit.name);
      if (!pcm) {
        this.staleModules.add(unit.name);
        continue;
      }
      try {
        const [sourceStat, pcmStat] = await Promise.all([fs.stat(unit.path), fs.stat(pcm)]);
        if (sourceStat.mtimeMs > pcmStat.mtimeMs) this.staleModules.add(unit.name);
      } catch {
        this.staleModules.add(unit.name);
      }
    }
  }

  private async applySourceChange(file: string, text: string): Promise<void> {
    const previous = this.index!.updateFile(file, text);
    const current = this.index!.units.find((unit) => path.resolve(unit.path) === file);
    for (const unit of [previous, current]) {
      if (unit && ["interface", "partition-interface"].includes(unit.kind)) this.staleModules.add(unit.name);
    }
    const oldText = this.openFiles.get(file);
    if (oldText !== undefined && oldText !== text) {
      const version = (this.documentVersions.get(file) ?? 1) + 1;
      this.openFiles.set(file, text);
      this.documentVersions.set(file, version);
      this.client!.notify("textDocument/didChange", {
        contentChanges: [{ text }],
        textDocument: { uri: this.uri(file), version },
      });
    }
    this.sourceChanges += 1;
    this.lastChangeAt = new Date().toISOString();
    this.recordEvent(`Source updated in memory: ${normalizeFsPath(file)}`);
  }

  private async markUnitStaleIfNeeded(file: string): Promise<void> {
    const unit = this.index!.units.find((candidate) => path.resolve(candidate.path) === path.resolve(file));
    if (!unit || !["interface", "partition-interface"].includes(unit.kind)) return;
    const pcm = this.modulePcms.get(unit.name);
    if (!pcm) {
      this.staleModules.add(unit.name);
      return;
    }
    try {
      const [sourceStat, pcmStat] = await Promise.all([fs.stat(file), fs.stat(pcm)]);
      if (sourceStat.mtimeMs > pcmStat.mtimeMs) this.staleModules.add(unit.name);
    } catch {
      this.staleModules.add(unit.name);
    }
  }

  private warningsForFile(file: string): string[] {
    const affected = new Set<string>();
    const unit = this.index!.units.find((candidate) => path.resolve(candidate.path) === path.resolve(file));
    if (unit && this.staleModules.has(unit.name)) affected.add(unit.name);
    for (const imported of this.index!.importsByFile.get(path.resolve(file)) ?? []) {
      if (this.staleModules.has(imported.name)) affected.add(imported.name);
      for (const dependency of this.index!.dependencies(imported.name, true)) {
        if (this.staleModules.has(dependency)) affected.add(dependency);
      }
    }
    return [...affected].sort().map((name) => `Module ${name} changed after its PCM was built; rebuild before trusting cross-module results.`);
  }

  private configureClient(client: LspClient): void {
    client.on("textDocument/publishDiagnostics", (params: unknown) => {
      const value = params as { uri: string; diagnostics: unknown[]; version?: number };
      this.diagnostics.set(value.uri, { diagnostics: value.diagnostics, version: value.version });
    });
    client.on("exit", (error: Error) => {
      this.state = "error";
      this.message = error.message;
    });
  }

  private recordEvent(message: string): void {
    this.events.push(`[${new Date().toISOString()}] ${message}`);
    if (this.events.length > 20) this.events.shift();
  }

  private resolveFile(file: string): string {
    this.requireIndex();
    if (!this.options) throw new Error("Workspace is not open");
    const mapped = file.startsWith("/mnt/") ? wslToWindows(file) : file;
    const absolute = path.isAbsolute(mapped) ? path.resolve(mapped) : path.resolve(this.options!.root, mapped);
    const relative = path.relative(this.options!.root, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`File is outside workspace: ${file}`);
    return absolute;
  }

  private uri(file: string): string {
    return fileUri(file, this.options!.transport);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    return this.waitForRefresh().then(() => this.client!.request(method, params));
  }

  private remap(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => this.remap(item));
    if (value && typeof value === "object") {
      const output: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        output[key] = key === "uri" && typeof item === "string" ? uriToDisplayPath(item) : this.remap(item);
      }
      return output;
    }
    return value;
  }

  private requireReady(): void {
    if (!this.client || !this.options || !this.index || !["ready", "warming"].includes(this.state)) {
      throw new Error(`Workspace is not ready (state: ${this.state})`);
    }
  }

  private async waitForRefresh(): Promise<void> {
    const refresh = this.refreshPromise;
    if (refresh) await refresh;
    this.requireReady();
  }

  private requireIndex(): void {
    if (!this.index) throw new Error("Workspace is not open");
  }

  private report(
    phase: string,
    completed: number,
    total: number,
    message: string,
    callback?: (phase: string, completed: number, total: number, message: string) => void,
  ): void {
    this.phase = phase;
    this.progressCompleted = completed;
    this.progressTotal = total;
    const event = `[${new Date().toISOString()}] ${message}`;
    if (this.events.at(-1) !== event) {
      this.events.push(event);
      if (this.events.length > 20) this.events.shift();
    }
    callback?.(phase, completed, total, message);
  }
}
