// What the Compiled JS tab shows first (#14). A 14-line program compiles to ~2,800 lines of
// JavaScript, nearly all of it the runtime, so the tab leads with the program's own modules
// and keeps the rest one click away: the composition root (`wiring`) and the runtime and
// capability bindings (`support`). The sandbox still gets every file; this is only the view.
//
// The compiler will say which is which (bynk-lang/bynk#2425: each emitted file carries
// `kind`). Until a release does, the kind is read from the layout bynkc emits: the runtime
// and the `bynk` namespace (reserved, so no program's context can live there) are support,
// and `compose.js` is wiring when it is the composition root. A capability-free program
// has no composition root, so a context named `compose` is then the program's own module.
// Pure, so test/jsview.test.mjs runs it under plain `node --test`.

import type { EmittedFile, FileKind } from "./shared";

const SUPPORT = new Set(["runtime.js", "bynk.js", "bynk-browser.js"]);

export function kindOf(file: EmittedFile): FileKind {
  if (file.kind) return file.kind;
  if (SUPPORT.has(file.path) || file.path.startsWith("bynk/")) return "support";
  if (file.path === "compose.js" && /export function composeApp\(/.test(file.contents)) return "wiring";
  return "user";
}

export interface JsView {
  user: EmittedFile[];
  wiring: EmittedFile[];
  support: EmittedFile[];
}

/// The emitted files grouped for the view, each group in emitted order.
export function groupFiles(files: EmittedFile[]): JsView {
  const view: JsView = { user: [], wiring: [], support: [] };
  for (const f of files) view[kindOf(f)].push(f);
  return view;
}

/// Lines in `files`, not counting a final newline.
export function lineCount(files: EmittedFile[]): number {
  return files.reduce((n, f) => n + f.contents.replace(/\n$/, "").split("\n").length, 0);
}
