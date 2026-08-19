#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { Workspace } from "./workspace.js";

const workspace = new Workspace();
const server = createServer(workspace);
const transport = new StdioServerTransport();
await server.connect(transport);

let closing: Promise<void> | undefined;
const shutdown = (): Promise<void> => {
  if (closing) return closing;
  closing = (async () => {
    await Promise.allSettled([workspace.close(), server.close()]);
  })();
  return closing;
};

const transportClose = transport.onclose;
transport.onclose = () => {
  transportClose?.();
  void shutdown();
};
process.stdin.once("end", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
