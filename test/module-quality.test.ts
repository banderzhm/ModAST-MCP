import { describe, expect, it } from "vitest";
import { analyzeModuleInterfaceAst } from "../src/module-quality.js";
import type { AstNode } from "../src/types.js";

function functionAst(kind: string, detail: string, arcana = "", bodyLines = 8): AstNode {
  return {
    arcana,
    children: [{
      children: [
        { kind: "Decl", role: "statement" },
        { kind: "Call", role: "expression" },
        { kind: "If", role: "statement", children: [{ kind: "Return", role: "statement" }] },
        { kind: "Return", role: "statement" },
        { kind: "Call", role: "expression" },
      ],
      kind: "Compound",
      range: { start: { line: 4, character: 0 }, end: { line: 4 + bodyLines - 1, character: 1 } },
      role: "statement",
    }],
    detail,
    kind,
    role: "declaration",
  };
}

describe("AST module quality analysis", () => {
  it("detects constructors and reports a missing implementation unit", () => {
    const warnings = analyzeModuleInterfaceAst(functionAst("CXXConstructor", "service"), {
      hasImplementationUnit: false,
      minBodyLines: 6,
      minStatements: 5,
      moduleName: "demo.service",
    });
    expect(warnings[0]).toMatchObject({ code: "missing-implementation-unit", line: 5, symbol: "service" });
  });

  it("reports business logic even when an implementation unit exists", () => {
    const warnings = analyzeModuleInterfaceAst(functionAst("CXXMethod", "process"), {
      hasImplementationUnit: true,
      minBodyLines: 6,
      minStatements: 5,
      moduleName: "demo.service",
    });
    expect(warnings[0]).toMatchObject({ code: "business-logic-in-interface", hasImplementationUnit: true });
  });

  it("does not suggest moving templates or constexpr definitions", () => {
    const ast: AstNode = {
      children: [
        { children: [functionAst("Function", "templated")], kind: "FunctionTemplate" },
        functionAst("Function", "constant", "constexpr"),
      ],
      kind: "TranslationUnit",
    };
    expect(analyzeModuleInterfaceAst(ast, {
      hasImplementationUnit: false,
      minBodyLines: 6,
      minStatements: 5,
      moduleName: "demo.header_only",
    })).toEqual([]);
  });
});
