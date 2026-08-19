import type { Position } from "../types.js";

export function offsetAt(text: string, position: Position): number {
  const lines = text.split(/\r?\n/);
  if (position.line < 0 || position.line >= lines.length) {
    throw new Error(`Line ${position.line} is outside the document`);
  }
  return lines.slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0)
    + Math.min(position.character, lines[position.line].length);
}

export function positionOf(text: string, needle: string, occurrence = 1): Position {
  if (occurrence < 1) throw new Error("occurrence must be at least 1");
  let from = 0;
  let index = -1;
  for (let i = 0; i < occurrence; i += 1) {
    index = text.indexOf(needle, from);
    if (index < 0) throw new Error(`Text not found: ${needle}`);
    from = index + needle.length;
  }
  const prefix = text.slice(0, index);
  const lines = prefix.split(/\r?\n/);
  return { line: lines.length - 1, character: lines.at(-1)!.length };
}
