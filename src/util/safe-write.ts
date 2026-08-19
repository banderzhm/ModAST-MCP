import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export class FileConflictError extends Error {
  constructor(readonly file: string) {
    super(`File changed while the operation was running: ${file}. Refusing to overwrite newer content.`);
    this.name = "FileConflictError";
  }
}

export async function replaceFileIfUnchanged(file: string, expected: string, replacement: string): Promise<void> {
  const current = await fs.readFile(file, "utf8");
  if (current !== expected) throw new FileConflictError(file);
  const stat = await fs.stat(file);
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.modast-${process.pid}-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, replacement, { mode: stat.mode });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
