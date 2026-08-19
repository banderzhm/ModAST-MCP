# ModAST-MCP

Module-aware AST MCP server for C++20/23 projects. It uses a persistent clangd process for normal AST/LSP operations and maintains a source-level module index for entities clangd 22 does not expose as symbols (`module`, `export module`, and import edges).

## Run

```bash
npm install
npm run build
node dist/index.js
```

The server uses MCP stdio transport. In Codex/Claude Desktop, point the command at `node dist/index.js`.

## Windows + Arch WSL

```json
{
  "mcpServers": {
    "modast": {
      "command": "node",
      "args": ["D:/runtime/mcp/ModAST-MCP/dist/index.js"]
    }
  }
}
```

Open a workspace first:

```json
{
  "root": "E:/github/cnetmod",
  "buildDirectory": "E:/github/cnetmod/cmake-build-release-wsl",
  "transport": "wsl",
  "wslDistro": "Arch",
  "experimentalModules": false
}
```

`mode` accepts `auto`, `cpp`, or `modules` and defaults to `auto`. Auto mode checks module extensions and compiler flags such as `-x c++-module`, `-fmodule-output`, `/interface`, and `/ifcOutput`. Pure `cpp` mode skips PCM/modmap discovery and never enables clangd's experimental module support.

`workspace_open` creates an augmented compilation database under the operating system's temporary directory, isolated by a hash of the workspace and build paths. It reuses any `.modmap` files that CMake/Ninja generated. For consumer translation units without a generated map, it resolves source-level imports against existing PCM files and creates a cached response file containing all known transitive PCM mappings. Keep `experimentalModules` off for this fast path; enable it only when required PCM files do not exist.

`workspace_warm` is non-blocking; call `workspace_status` while it builds the persistent clangd background index. Queries are served from the same clangd session after files are opened.

## Development updates and disk writes

The workspace watches only files present in `compile_commands.json` plus known `.pcm` and `.modmap` artifacts. It does not recursively watch or rescan every file in the repository.

- Editing a watched source updates the module graph in memory. Open documents are sent to clangd through `textDocument/didChange`; no ModAST cache file is written.
- Editing a module interface marks its module as stale. AST, definition, references, and diagnostics responses include a warning until the corresponding PCM is rebuilt.
- PCM, modmap, and compilation database changes are debounced into one workspace refresh. This handles the normal edit -> Ninja/CMake build -> query loop.
- New translation units are picked up by `workspace_refresh` after the build system updates `compile_commands.json`.
- Generated compilation databases and response files use content comparison. Identical content is never rewritten. `workspace_status.compileDatabase` reports `diskWrites` and `cacheFilesReused` for the latest preparation.
- Temporary workspace caches are pruned on open using a 14-day TTL, 20 inactive-workspace limit, and 512 MB inactive-cache limit. The active workspace is retained and cleanup results are exposed as `workspace_status.cacheCleanup`.
- Semantic queries wait for an in-progress refresh, so they run against the replacement clangd process rather than a stopped client.

`workspace_status` also reports `sourceChanges`, `lastChangeAt`, `watchedFiles`, `staleModules`, and `refreshes` so an Agent can decide whether cross-module data is current.

Both long-running tools and `workspace_open` emit MCP `notifications/progress` when the client sends a progress token. Slow clangd requests emit a heartbeat every five seconds. `workspace_status` is also safe to poll: it includes `phase`, `progressCompleted`, `progressTotal`, `elapsedMs`, and the last 20 human-readable `events`.

## Tools

- `workspace_open`, `workspace_status`, `workspace_refresh`, `workspace_warm`
- `module_search`, `module_graph`
- `module_quality`, `format`
- `ast`, `document_symbols`, `workspace_symbols`
- `definition`, `references`, `diagnostics`

Line and character arguments are 1-based. For Agent use, `definition` and `references` accept a `needle` plus an `occurrence`, avoiding manual position calculations.

`format` delegates to clangd/clang-format and honors the project's `.clang-format`. It is preview-only by default and returns the formatted text plus LSP edits. `apply=true` is required to write the source. Before applying, the server verifies that the file still matches the clangd snapshot; concurrent editor changes cause a conflict error instead of being overwritten. Successful writes use a same-directory temporary file and atomic rename, then synchronize the persistent clangd document.

`module_quality` uses clangd AST nodes rather than source regexes. It reports substantial function bodies in module interface units, ignores templates and `constexpr`/`consteval` definitions, and warns when a named module has no `.cpp`, `.cc`, or `.cxx` implementation or partition implementation unit. A second non-exported `.cppm` does not satisfy this architecture check. Thresholds and scan concurrency are configurable.

## Design notes

- clangd's `textDocument/ast` is returned unchanged under `clangdAst`.
- A synthetic `moduleContext` adds module units and imports because clangd 22 returns no AST node for `export module ...` and does not index module names as workspace symbols.
- Module parsing is deliberately source-based and independent of compiler vendor. The clangd process remains the semantic authority for C++ declarations.
- When `transport` is `wsl`, Windows workspace paths are converted to `/mnt/<drive>/...` only at the process boundary; MCP responses are mapped back to Windows paths.
- Closing MCP stdio, ending stdin, or sending SIGINT/SIGTERM closes file watchers and gracefully shuts down clangd.

## Verification

`npm test` runs unit and lifecycle tests. Set `MODAST_INTEGRATION=1` to add a live clangd test; it uses Arch WSL on Windows and native clangd on Linux. GitHub Actions tests Node.js 20 and 24 on Windows and Linux, runs the live Linux clangd test, and rejects high-severity production dependency advisories.
