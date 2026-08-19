import { describe, expect, it } from "vitest";
import { uriToDisplayPath, windowsToWsl, wslToWindows } from "../src/util/paths.js";

describe("WSL path mapping", () => {
  it("round-trips a Windows workspace path", () => {
    const windows = "E:/github/cnetmod/src/core/address.cppm";
    expect(windowsToWsl(windows)).toBe("/mnt/e/github/cnetmod/src/core/address.cppm");
    expect(wslToWindows(windowsToWsl(windows))).toBe(windows);
  });

  it("maps a clangd file URI back to Windows", () => {
    if (process.platform === "win32") {
      expect(uriToDisplayPath("file:///mnt/e/github/cnetmod/src/core/address.cppm"))
        .toBe("E:/github/cnetmod/src/core/address.cppm");
    }
  });
});
