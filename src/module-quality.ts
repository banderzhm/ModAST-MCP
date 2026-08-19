import type { AstNode, ModuleQualityWarning } from "./types.js";

const FUNCTION_KINDS = new Set([
  "Function", "CXXMethod", "CXXConstructor", "CXXDestructor", "CXXConversion",
]);
const CONTROL_FLOW_KINDS = new Set([
  "If", "For", "CXXForRange", "While", "Do", "Switch", "CXXTry", "ConditionalOperator",
]);

export interface ModuleQualityOptions {
  hasImplementationUnit: boolean;
  minBodyLines: number;
  minStatements: number;
  moduleName: string;
}

function descendants(node: AstNode): AstNode[] {
  const result: AstNode[] = [];
  const visit = (candidate: AstNode): void => {
    for (const child of candidate.children ?? []) {
      result.push(child);
      visit(child);
    }
  };
  visit(node);
  return result;
}

export function analyzeModuleInterfaceAst(ast: AstNode | null, options: ModuleQualityOptions): ModuleQualityWarning[] {
  if (!ast) return [];
  const warnings: ModuleQualityWarning[] = [];
  const visit = (node: AstNode, inTemplate: boolean, inFunction: boolean): void => {
    const template = inTemplate || node.kind === "FunctionTemplate";
    const functionNode = FUNCTION_KINDS.has(node.kind ?? "");
    if (functionNode && !inFunction && !template && !/\b(?:constexpr|consteval)\b/.test(node.arcana ?? "")) {
      const body = node.children?.find((child) => child.kind === "Compound" && child.role === "statement");
      if (body?.range) {
        const nested = descendants(body);
        const statementCount = (body.children ?? []).filter((child) =>
          child.kind !== "Compound" && ["statement", "declaration", "expression"].includes(child.role ?? "")).length;
        const controlFlowCount = nested.filter((child) => CONTROL_FLOW_KINDS.has(child.kind ?? "")).length;
        const bodyLines = body.range.end.line - body.range.start.line + 1;
        const nonTrivial = bodyLines >= options.minBodyLines
          || statementCount >= options.minStatements
          || controlFlowCount >= 2
          || (controlFlowCount >= 1 && bodyLines >= 4);
        if (nonTrivial) {
          const symbol = node.detail || node.kind;
          const missing = !options.hasImplementationUnit;
          warnings.push({
            bodyLines,
            code: missing ? "missing-implementation-unit" : "business-logic-in-interface",
            controlFlowCount,
            hasImplementationUnit: options.hasImplementationUnit,
            line: body.range.start.line + 1,
            message: missing
              ? `Non-trivial definition ${symbol} is in module interface ${options.moduleName}, and no matching implementation unit was indexed. Add a .cpp containing 'module ${options.moduleName};' and move the business logic there.`
              : `Non-trivial definition ${symbol} remains in module interface ${options.moduleName}. Move the business logic to its indexed implementation unit unless visibility is required.`,
            severity: "warning",
            statementCount,
            symbol,
          });
        }
      }
    }
    for (const child of node.children ?? []) visit(child, template, inFunction || functionNode);
  };
  visit(ast, false, false);
  return warnings;
}
