import { spawn } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("stdio lifecycle", () => {
  it("exits promptly when the client closes stdin", async () => {
    const cli = path.resolve("node_modules/tsx/dist/cli.mjs");
    const child = spawn(process.execPath, [cli, "src/index.ts"], {
      cwd: path.resolve("."),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.stdin.end();
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`MCP server did not exit after stdin closed: ${Buffer.concat(stderr).toString("utf8")}`));
      }, 5_000);
      child.once("error", reject);
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    expect(exitCode).toBe(0);
  });
});
