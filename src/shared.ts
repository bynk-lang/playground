// Shared types + origin config for the Bynk playground (in-browser track, slice 4).
//
// Two origins, by design (the safety boundary — ADR 0140): the **app** origin
// hosts the editor + the wasm compiler; the **sandbox** origin hosts the
// execution document (a sandboxed iframe wrapping a Web Worker). They talk only
// over `postMessage`, each validating the other.
//
// Origins are injected at build time (esbuild `define`); the defaults are the
// production hosts, overridden to localhost ports for local verification.
declare const __APP_ORIGIN__: string;
declare const __SANDBOX_ORIGIN__: string;

export const APP_ORIGIN: string =
  typeof __APP_ORIGIN__ === "string" ? __APP_ORIGIN__ : "https://playground.bynk-lang.dev";
export const SANDBOX_ORIGIN: string =
  typeof __SANDBOX_ORIGIN__ === "string" ? __SANDBOX_ORIGIN__ : "https://sandbox.bynk-lang.dev";

// The wasm files' content-hashed paths from the deploy root (build.mjs, #33).
declare const __BYNK_WASM__: string;
declare const __TS_WASM__: string;
declare const __TS_BYNK_WASM__: string;
export const BYNK_WASM: string = typeof __BYNK_WASM__ === "string" ? __BYNK_WASM__ : "bynk_wasm_bg.wasm";
export const TS_WASM: string = typeof __TS_WASM__ === "string" ? __TS_WASM__ : "tree-sitter.wasm";
export const TS_BYNK_WASM: string = typeof __TS_BYNK_WASM__ === "string" ? __TS_BYNK_WASM__ : "tree-sitter-bynk.wasm";

/// One emitted JavaScript module of a compiled program.
export interface EmittedFile {
  path: string;
  contents: string;
}

/// A diagnostic (mirrors the wasm `bynk_compile` / `bynk_analyze` JSON shape).
export interface Diagnostic {
  path: string | null;
  line: number;
  col: number;
  /// Byte offsets of the span (for the editor's inline lint range).
  from: number;
  to: number;
  severity: "error" | "warning";
  category: string;
  message: string;
}

/// The wasm `bynk_compile` result.
export interface CompileResult {
  ok: boolean;
  files: EmittedFile[];
  diagnostics: Diagnostic[];
}

/// app → sandbox: "run this module graph".
export interface RunRequest {
  kind: "bynk-run";
  /// Correlates the reply with this request.
  id: number;
  files: EmittedFile[];
  /// Wall-clock budget; the Worker is terminated past it.
  timeoutMs: number;
}

/// sandbox → app: the outcome of a run.
export interface RunReply {
  kind: "bynk-result";
  id: number;
  /// Captured `Logger` output, in order.
  logs: { level: "info" | "error"; message: string }[];
  /// The entry's returned value, JSON-ish stringified (when it completed).
  value?: string;
  /// A thrown error / unhandled rejection from the program.
  error?: string;
  /// True when the Worker hit the wall-clock budget and was terminated.
  timedOut?: boolean;
  /// True when the graph had no zero-argument entry to invoke.
  noEntry?: boolean;
  /// True when a newer run arrived first and this one's Worker was stopped.
  superseded?: boolean;
}

/// sandbox → app, once: the execution document is ready to receive runs.
export interface SandboxReady {
  kind: "bynk-sandbox-ready";
}
