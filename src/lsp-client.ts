import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type { WorkspaceOptions } from "./types.js";
import { fileUri, windowsToWsl } from "./util/paths.js";

interface PendingRequest {
  reject: (reason: Error) => void;
  resolve: (value: unknown) => void;
  timer: NodeJS.Timeout;
}

interface RpcMessage {
  error?: { code: number; message: string; data?: unknown };
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
}

export class LspClient extends EventEmitter {
  private buffer = Buffer.alloc(0);
  private nextId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private process?: ChildProcessWithoutNullStreams;
  private readonly recentErrors: string[] = [];
  private expectedStop = false;

  constructor(private readonly options: WorkspaceOptions, private readonly compileDatabaseDirectory: string) {
    super();
  }

  async start(): Promise<void> {
    if (this.process) return;
    this.expectedStop = false;
    const compileDirectory = this.options.transport === "wsl"
      ? windowsToWsl(this.compileDatabaseDirectory)
      : this.compileDatabaseDirectory;
    const clangdArguments = [
      `--compile-commands-dir=${compileDirectory}`,
      "--background-index",
      "--background-index-priority=normal",
      "--log=error",
    ];
    if (this.options.mode === "modules" && this.options.experimentalModules) clangdArguments.push("--experimental-modules-support");

    const executable = this.options.transport === "wsl" ? "wsl.exe" : (this.options.clangdPath ?? "clangd");
    const args = this.options.transport === "wsl"
      ? ["-d", this.options.wslDistro ?? "Arch", "--", this.options.clangdPath ?? "clangd", ...clangdArguments]
      : clangdArguments;
    this.process = spawn(executable, args, { cwd: this.options.root, stdio: "pipe", windowsHide: true });
    this.process.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") this.recentErrors.push(error.message);
    });
    this.process.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    this.process.stderr.on("data", (chunk: Buffer) => {
      const utf8 = chunk.toString("utf8");
      const message = (utf8.includes("\u0000") ? chunk.toString("utf16le") : utf8).trim();
      if (/^wsl:.*localhost/i.test(message)) return;
      if (message) {
        this.recentErrors.push(message);
        if (this.recentErrors.length > 20) this.recentErrors.shift();
      }
    });
    this.process.on("exit", (code) => {
      const error = new Error(`clangd exited with code ${code}: ${this.recentErrors.at(-1) ?? "no stderr"}`);
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(error);
      }
      this.pending.clear();
      this.process = undefined;
      if (!this.expectedStop) this.emit("exit", error);
    });

    await this.request("initialize", {
      capabilities: {
        textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true } },
        workspace: { symbol: {} },
      },
      processId: process.pid,
      rootUri: fileUri(this.options.root, this.options.transport),
      workspaceFolders: [{ name: "workspace", uri: fileUri(this.options.root, this.options.transport) }],
    }, 30_000);
    this.notify("initialized", {});
  }

  async stop(): Promise<void> {
    if (!this.process) return;
    this.expectedStop = true;
    const child = this.process;
    try {
      await this.request("shutdown", null, 5_000);
    } catch {
      // Continue with process termination if clangd cannot answer shutdown.
    }
    const exited = new Promise<boolean>((resolve) => child.once("exit", () => resolve(true)));
    try { this.notify("exit", null); } catch { /* Process may already have exited. */ }
    const graceful = await Promise.race([
      exited,
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000)),
    ]);
    if (!graceful && child.exitCode === null) {
      child.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1_000))]);
    }
    if (this.process === child) this.process = undefined;
  }

  request(method: string, params: unknown, timeoutMs = 120_000): Promise<unknown> {
    if (!this.process) return Promise.reject(new Error("clangd is not running"));
    const id = ++this.nextId;
    this.write({ id, jsonrpc: "2.0", method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { reject, resolve, timer });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  errors(): string[] {
    return [...this.recentErrors];
  }

  private write(message: object): void {
    if (!this.process) throw new Error("clangd is not running");
    const body = Buffer.from(JSON.stringify(message));
    this.process.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.process.stdin.write(body);
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) throw new Error(`Invalid clangd response header: ${header}`);
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      this.handle(JSON.parse(body) as RpcMessage);
    }
  }

  private handle(message: RpcMessage): void {
    if (typeof message.id === "number") {
      const request = this.pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(message.id);
      if (message.error) request.reject(new Error(`${message.error.message} (${message.error.code})`));
      else request.resolve(message.result);
      return;
    }
    if (message.method) this.emit(message.method, message.params);
  }
}
