import path from "node:path";
import { pathToFileURL } from "node:url";

export function normalizeFsPath(value: string): string {
  return path.resolve(value).replaceAll("\\", "/");
}

export function windowsToWsl(value: string): string {
  const normalized = normalizeFsPath(value);
  const match = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  if (!match) return normalized;
  return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
}

export function wslToWindows(value: string): string {
  const match = /^\/mnt\/([A-Za-z])\/(.*)$/.exec(value);
  if (!match) return value;
  return `${match[1].toUpperCase()}:/${match[2]}`;
}

export function fileUri(value: string, transport: "native" | "wsl"): string {
  if (transport === "wsl") return `file://${windowsToWsl(value)}`;
  return pathToFileURL(path.resolve(value)).href;
}

export function uriToDisplayPath(uri: string): string {
  const raw = decodeURIComponent(uri.replace(/^file:\/\//, ""));
  if (/^\/[A-Za-z]:\//.test(raw)) return raw.slice(1);
  return process.platform === "win32" ? wslToWindows(raw) : raw;
}

export function remapCommandPath(value: string, transport: "native" | "wsl"): string {
  return transport === "wsl" ? windowsToWsl(value) : path.resolve(value);
}
