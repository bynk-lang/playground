// Which emitted module the sandbox runs, and how it reaches the service surface.
//
// A program that consumes a capability (`Logger`, `Random`, …) gets a composition root,
// `compose.js`, whose `composeApp()` wires the capability bindings and returns each
// context's surface. A program that consumes none gets no `compose.js` at all: the graph
// is just the context module and `runtime.js`, and the context module itself exports
// `__makeSurface(deps)`. Both must run, so the entry is chosen from what was emitted
// rather than assumed to be `compose.js` (which made a capability-free program report
// "No zero-argument service handler" while having one).

export type EntryKind = "compose" | "surface";

export interface Entry {
  /// Path of the module to import.
  path: string;
  /// `compose`: call its `composeApp()`. `surface`: call its `__makeSurface({})`.
  kind: EntryKind;
}

/// The module that runs, or null when the graph has no way in.
export function pickEntry(files: { path: string; contents: string }[]): Entry | null {
  if (files.some((f) => f.path === "compose.js")) return { path: "compose.js", kind: "compose" };
  const context = files.find((f) => f.path !== "runtime.js" && /export function __makeSurface\(/.test(f.contents));
  return context ? { path: context.path, kind: "surface" } : null;
}
