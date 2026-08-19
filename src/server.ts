import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Range, WorkspaceOptions } from "./types.js";
import { Workspace } from "./workspace.js";

interface ProgressExtra {
  _meta?: { progressToken?: string | number };
  sendNotification: (notification: {
    method: "notifications/progress";
    params: { message?: string; progress: number; progressToken: string | number; total?: number };
  }) => Promise<void>;
}

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error: unknown) {
  return {
    content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  };
}

async function notifyProgress(
  extra: ProgressExtra,
  progress: number,
  total: number,
  message: string,
): Promise<void> {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return;
  await extra.sendNotification({
    method: "notifications/progress",
    params: { message, progress, progressToken, total },
  });
}

async function withHeartbeat<T>(promise: Promise<T>, extra: ProgressExtra, operation: string): Promise<T> {
  const started = Date.now();
  await notifyProgress(extra, 0, 120, `${operation}: starting`);
  const timer = setInterval(() => {
    const seconds = Math.floor((Date.now() - started) / 1000);
    void notifyProgress(extra, Math.min(seconds, 119), 120, `${operation}: waiting for clangd (${seconds}s)`);
  }, 5_000);
  try {
    const value = await promise;
    const seconds = Math.floor((Date.now() - started) / 1000);
    await notifyProgress(extra, 120, 120, `${operation}: complete (${seconds}s)`);
    return value;
  } finally {
    clearInterval(timer);
  }
}

export function createServer(workspace = new Workspace()): McpServer {
  const server = new McpServer({ name: "modast-mcp", version: "0.1.0" });
  const execute = <T>(handler: () => Promise<T> | T) => async () => {
    try { return result(await handler()); } catch (error) { return errorResult(error); }
  };

  server.registerTool("workspace_open", {
    description: "Open a C++ workspace and start one persistent module-aware clangd process.",
    inputSchema: {
      buildDirectory: z.string().describe("Absolute build directory or path relative to root containing compile_commands.json"),
      clangdPath: z.string().optional().describe("clangd executable inside the selected transport"),
      experimentalModules: z.boolean().default(false).describe("Enable slow clangd dependency discovery when prebuilt PCM files are unavailable"),
      mode: z.enum(["auto", "cpp", "modules"]).default("auto").describe("cpp skips module BMI augmentation; modules enables module-aware indexing"),
      root: z.string().describe("Absolute C++ workspace root"),
      transport: z.enum(["native", "wsl"]).default(process.platform === "win32" ? "wsl" : "native"),
      wslDistro: z.string().default("Arch").describe("WSL distribution when transport is wsl"),
    },
  }, async (input, extra) => {
    try {
      let lastPhase = "";
      let lastNotificationAt = 0;
      return result(await workspace.open(input as WorkspaceOptions, (phase, completed, total, message) => {
        const now = Date.now();
        if (phase === lastPhase && completed < total && now - lastNotificationAt < 500) return;
        lastPhase = phase;
        lastNotificationAt = now;
        void notifyProgress(extra, completed, total, `${phase}: ${message}`).catch(() => undefined);
      }));
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("workspace_status", {
    description: "Return clangd readiness, warmup progress, module counts, PCM/modmap coverage, and recent errors.",
  }, execute(() => workspace.status()));

  server.registerTool("workspace_refresh", {
    description: "Reload compile commands and rebuilt PCM/modmap artifacts, restarting clangd without rewriting unchanged cache files.",
    inputSchema: { reason: z.string().default("manual MCP refresh") },
  }, async ({ reason }, extra) => {
    try { return result(await withHeartbeat(workspace.refresh(reason), extra, "Workspace refresh")); }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("workspace_warm", {
    description: "Start non-blocking AST warmup. Poll workspace_status; other MCP tools remain available.",
    inputSchema: {
      files: z.array(z.string()).optional().describe("Files to warm; defaults to module interfaces"),
      limit: z.number().int().min(0).max(1000).default(32),
    },
  }, async ({ files, limit }) => {
    try { return result(workspace.startWarm(files, limit)); } catch (error) { return errorResult(error); }
  });

  server.registerTool("module_search", {
    description: "Search named C++ modules and partitions, including entities clangd does not expose as symbols.",
    inputSchema: { query: z.string() },
  }, async ({ query }) => result(workspace.moduleSearch(query)));

  server.registerTool("module_graph", {
    description: "Resolve a module to interface units, imports, dependencies, and importing translation units.",
    inputSchema: { name: z.string(), transitive: z.boolean().default(false) },
  }, async ({ name, transitive }) => result(workspace.moduleGraph(name, transitive)));

  server.registerTool("module_quality", {
    description: "Warn when a module interface contains long function bodies that should move to a .cpp implementation unit.",
    inputSchema: { file: z.string().optional() },
  }, async ({ file }) => {
    try { return result(workspace.moduleQuality(file)); } catch (error) { return errorResult(error); }
  });

  server.registerTool("format", {
    description: "Format C++/module source with clangd. Preview is the default; apply=true explicitly writes the file and updates clangd.",
    inputSchema: {
      apply: z.boolean().default(false),
      file: z.string(),
      insertSpaces: z.boolean().default(true),
      tabSize: z.number().int().min(1).max(16).default(4),
    },
  }, async ({ file, apply, tabSize, insertSpaces }, extra) => {
    try { return result(await withHeartbeat(workspace.format(file, apply, tabSize, insertSpaces), extra, `Format ${file}`)); }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("ast", {
    description: "Return clangd's detailed AST plus synthetic module context for module declarations/imports.",
    inputSchema: {
      endCharacter: z.number().int().min(1).optional(),
      endLine: z.number().int().min(1).optional(),
      file: z.string(),
      startCharacter: z.number().int().min(1).optional(),
      startLine: z.number().int().min(1).optional(),
    },
  }, async ({ file, startLine, startCharacter, endLine, endCharacter }, extra) => {
    try {
      let range: Range | undefined;
      if ([startLine, startCharacter, endLine, endCharacter].some((value) => value !== undefined)) {
        if ([startLine, startCharacter, endLine, endCharacter].some((value) => value === undefined)) {
          throw new Error("AST range requires all four start/end line and character values");
        }
        range = {
          start: { line: startLine! - 1, character: startCharacter! - 1 },
          end: { line: endLine! - 1, character: endCharacter! - 1 },
        };
      }
      return result(await withHeartbeat(workspace.ast(file, range), extra, `AST ${file}`));
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("document_symbols", {
    description: "List declarations in a C++ source or module unit using clangd's hierarchical symbol view.",
    inputSchema: { file: z.string() },
  }, async ({ file }, extra) => {
    try { return result(await withHeartbeat(workspace.documentSymbols(file), extra, `Symbols ${file}`)); } catch (error) { return errorResult(error); }
  });

  server.registerTool("workspace_symbols", {
    description: "Search clangd symbols and named C++ modules in one request.",
    inputSchema: { query: z.string() },
  }, async ({ query }, extra) => {
    try { return result(await withHeartbeat(workspace.workspaceSymbols(query), extra, `Workspace symbols ${query}`)); } catch (error) { return errorResult(error); }
  });

  const locationSchema = {
    character: z.number().int().min(1).optional().describe("1-based UTF-16 character"),
    file: z.string(),
    line: z.number().int().min(1).optional().describe("1-based line"),
    needle: z.string().optional().describe("Text to locate instead of line/character"),
    occurrence: z.number().int().min(1).default(1),
  };

  server.registerTool("definition", {
    description: "Find a declaration/definition across module BMIs. Position values are 1-based; needle is often easier for agents.",
    inputSchema: { ...locationSchema, includeHover: z.boolean().default(true) },
  }, async ({ file, line, character, needle, occurrence, includeHover }, extra) => {
    try {
      const position = await workspace.locate(file, line, character, needle, occurrence);
      return result(await withHeartbeat(workspace.definition(file, position, includeHover), extra, `Definition ${file}`));
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("references", {
    description: "Find indexed references to a declaration across module units and translation units.",
    inputSchema: { ...locationSchema, includeDeclaration: z.boolean().default(true) },
  }, async ({ file, line, character, needle, occurrence, includeDeclaration }, extra) => {
    try {
      const position = await workspace.locate(file, line, character, needle, occurrence);
      return result(await withHeartbeat(workspace.references(file, position, includeDeclaration), extra, `References ${file}`));
    } catch (error) { return errorResult(error); }
  });

  server.registerTool("diagnostics", {
    description: "Parse a file and return clangd diagnostics after module resolution.",
    inputSchema: { file: z.string() },
  }, async ({ file }, extra) => {
    try { return result(await withHeartbeat(workspace.diagnosticsFor(file), extra, `Diagnostics ${file}`)); } catch (error) { return errorResult(error); }
  });

  return server;
}
