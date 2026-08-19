export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Location {
  uri: string;
  range: Range;
}

export interface AstNode {
  arcana?: string;
  children?: AstNode[];
  detail?: string;
  kind?: string;
  range?: Range;
  role?: string;
}

export type ModuleUnitKind =
  | "interface"
  | "implementation"
  | "partition-interface"
  | "partition-implementation";

export interface ModuleImport {
  exported: boolean;
  headerUnit: boolean;
  line: number;
  name: string;
}

export interface ModuleUnit {
  imports: ModuleImport[];
  kind: ModuleUnitKind;
  line: number;
  name: string;
  path: string;
}

export interface ModuleQualityWarning {
  bodyLines: number;
  code: "business-logic-in-interface" | "missing-implementation-unit";
  controlFlowCount: number;
  hasImplementationUnit: boolean;
  line: number;
  message: string;
  severity: "warning";
  statementCount: number;
  symbol?: string;
}

export interface CompileCommand {
  arguments?: string[];
  command?: string;
  directory: string;
  file: string;
  output?: string;
}

export interface WorkspaceOptions {
  buildDirectory: string;
  mode: "auto" | "cpp" | "modules";
  clangdPath?: string;
  experimentalModules: boolean;
  root: string;
  transport: "native" | "wsl";
  wslDistro?: string;
}

export type WorkspaceState = "closed" | "starting" | "refreshing" | "warming" | "ready" | "error";
