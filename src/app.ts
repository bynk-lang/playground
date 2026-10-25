// The Bynk playground app (in-browser track, slice 4). Runs on the **app origin**:
// edits Bynk, compiles it to JS in wasm (`bynk_compile`), shows diagnostics, and
// dispatches a successful compile to the cross-origin **sandbox** iframe to run.

import { Compartment, EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  hoverTooltip,
} from "@codemirror/view";
import type { Tooltip } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { linter, lintGutter, forceLinting } from "@codemirror/lint";
import type { Diagnostic as CmDiagnostic } from "@codemirror/lint";
import { autocompletion } from "@codemirror/autocomplete";
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { bynkHighlighting } from "./highlight";
import { bynkTreeSitterHighlighting } from "./tshighlight";
import { encodeSnippet, decodeSnippet } from "./deeplink";
import { BYNK_WASM, SANDBOX_ORIGIN } from "./shared";
import type { CompileResult, Diagnostic, EmittedFile, RunReply, SandboxConnect } from "./shared";
import { EXAMPLES } from "./examples";
import type { Example } from "./examples";
import { mountGallery } from "./gallery";
import { clearDraft, loadDraft, loadRecent, loadTourDone, markTourDone, rememberRun, resetTourDone, saveDraft } from "./store";
import { TOUR, nextIncomplete } from "./tour";
import type { TourOutcome, TourStep } from "./tour";
import { byteToUtf16Offset, utf16ToByteOffset } from "./positions";
import init, { bynk_compile, bynk_analyze, bynk_hover, bynk_complete } from "./vendor/bynk_wasm.js";

// The default program when there is no shared snippet in the URL: the first gallery
// example (Hello, world).
const DEFAULT_SOURCE = EXAMPLES[0].source;

// `?embed=1`: the compact view for an <iframe> in someone else's page (see the share
// sheet). It runs the snippet but never reads or writes this browser's draft, recents,
// tour progress or coachmark: a visitor's embed must not disturb their own playground.
const EMBED = new URLSearchParams(location.search).get("embed") === "1";
if (EMBED) document.documentElement.dataset.embed = "1";

const RUN_TIMEOUT_MS = 3000;

// Apple devices write the Run shortcut ⌘↵ (#37); Ctrl+Enter works there too, but ⌘ is what
// their users expect. Either platform signal will do: both say so on a real Mac.
const IS_APPLE = [(navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform, navigator.platform]
  .some((p) => p && /mac|iphone|ipad/i.test(p));
const PLATFORM_LOCK = new Set(["bynk.target.vendor_required", "bynk.target.browser_bundle_only"]);

const $ = (id: string) => document.getElementById(id)!;

let view: EditorView;
// Highlighting starts on the synchronous stream highlighter and swaps to
// web-tree-sitter once its wasm has loaded (slice 5b).
const highlightCompartment = new Compartment();
let sandboxReady = false;
// The code runner (the sandbox iframe) never said it was ready: its origin is down,
// blocked by an extension or a network filter, or very slow (#31).
let sandboxFailed = false;
// The linter no-ops until the wasm compiler has loaded (slice 5d).
let wasmReady = false;

// A CodeMirror lint source: on each (debounced) change, ask the wasm analyser for
// diagnostics and render them inline (squiggles + gutter). Non-bailing, so type
// errors in a context show up live — not only on Run.
const bynkLinter = linter(
  (view): CmDiagnostic[] => {
    if (!wasmReady) return [];
    const text = view.state.doc.toString();
    let diags: Diagnostic[];
    try {
      diags = (JSON.parse(bynk_analyze(text)) as { diagnostics: Diagnostic[] }).diagnostics;
    } catch {
      return [];
    }
    setDiagSummary(diags);
    // `from`/`to` are UTF-8 byte offsets; CodeMirror ranges are UTF-16 (#2126).
    // The conversion clamps to the document, so no further clamping is needed.
    return diags
      .map((d) => ({
        from: byteToUtf16Offset(text, d.from),
        to: byteToUtf16Offset(text, Math.max(d.to, d.from)),
        severity: d.severity === "error" ? ("error" as const) : ("warning" as const),
        message: d.message,
      }))
      .filter((d) => d.from <= d.to);
  },
  { delay: 300 },
);

// A CodeMirror hover tooltip: ask the wasm analyser for the inferred type at
// the cursor position and show it, if any (#397). `null` — no tooltip — when
// the wasm compiler isn't loaded yet, the position has no recorded expression,
// or the buffer doesn't currently check clean (the analyser's "clean-file
// ceiling", ADR 0063).
const bynkHover = hoverTooltip((view, pos): Tooltip | null => {
  if (!wasmReady) return null;
  let result: { ty: string | null };
  try {
    // `pos` is a UTF-16 offset; `bynk_hover` takes a UTF-8 byte offset (#2126).
    const text = view.state.doc.toString();
    result = JSON.parse(bynk_hover(text, utf16ToByteOffset(text, pos))) as { ty: string | null };
  } catch {
    return null;
  }
  if (!result.ty) return null;
  const ty = result.ty;
  return {
    pos,
    end: pos,
    above: true,
    create: () => {
      const dom = document.createElement("div");
      dom.className = "cm-tooltip-bynk-hover";
      dom.textContent = ty;
      return { dom };
    },
  };
});

interface CompletionCandidate {
  label: string;
  kind: string;
  detail: string | null;
  insert_text: string | null;
}

// `bynk_complete`'s `CompletionKind` strings mapped to CodeMirror's own
// completion `type`, which drives the icon in the completion list. `insert_text`
// is not used yet — it only carries LSP snippet syntax (`${1:label}`) for
// `Snippet` items, a different placeholder grammar from CodeMirror's own
// `snippet()` syntax, so every candidate inserts its bare label for now.
const KIND_TO_CM_TYPE: Record<string, string> = {
  unit: "namespace",
  capability: "interface",
  type: "type",
  keyword: "keyword",
  snippet: "text",
  variant: "enum",
  member: "method",
  field: "property",
  constructor: "function",
  function: "function",
  constant: "constant",
  local: "variable",
};

// A CodeMirror completion source: ask the wasm analyser for context-aware
// candidates (capability methods, types, keywords, in-scope locals, value-receiver
// members) at the cursor position (#808). `null` when the wasm compiler isn't
// loaded yet or there is nothing to offer.
const bynkCompletions = (context: CompletionContext): CompletionResult | null => {
  if (!wasmReady) return null;
  const word = context.matchBefore(/[\w.]*/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  let items: CompletionCandidate[];
  try {
    // `context.pos` is a UTF-16 offset; `bynk_complete` takes a UTF-8 byte
    // offset (#2126). The returned range is `word.from` — already UTF-16.
    const text = context.state.doc.toString();
    items = (
      JSON.parse(bynk_complete(text, utf16ToByteOffset(text, context.pos))) as { items: CompletionCandidate[] }
    ).items;
  } catch {
    return null;
  }
  if (items.length === 0) return null;
  return {
    from: word.from,
    options: items.map((c) => ({
      label: c.label,
      type: KIND_TO_CM_TYPE[c.kind] ?? "text",
      detail: c.detail ?? undefined,
      apply: c.label,
    })),
    validFor: /^[\w.]*$/,
  };
};

// Every compile takes the next number; only the newest one may show its outcome, so a
// slow run that finishes (or times out) after a later one never overwrites it (#22).
let runSeq = 0;
const pending = new Map<number, (r: RunReply) => void>();
// The private channel to the code runner, handed over when it first says it is ready.
// Runs and results travel only over it, never as window messages (#30).
let sandboxPort: MessagePort | null = null;
// Whether the channel has been handed over. Only once: after the runner is lost, a
// "ready" from whatever now holds the frame must not get a new one.
let channelOffered = false;

function source(): string {
  return view.state.doc.toString();
}

function setStatus(text: string, kind: "idle" | "busy" | "ok" | "error" = "idle"): void {
  const el = $("status");
  el.textContent = text;
  el.dataset.kind = kind;
}

function renderDiagnostics(diags: Diagnostic[]): void {
  const panel = $("diagnostics");
  panel.innerHTML = "";
  if (diags.length === 0) {
    panel.classList.add("empty");
    return;
  }
  panel.classList.remove("empty");
  for (const d of diags) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `diag diag-${d.severity}`;
    const loc = d.line ? `${d.line}:${d.col}` : "—";
    // Click a row to jump the cursor to the offending span.
    row.addEventListener("click", () => jumpTo(d));
    // `category` is a fixed compiler constant today; escape it too so this stays
    // injection-proof if a future diagnostic ever derives a category from source.
    row.innerHTML = `<span class="diag-sev">${d.severity === "error" ? "✕ error" : "▲ warning"}</span> <span class="diag-loc">${loc}</span> ${escapeHtml(d.message)} <span class="diag-cat">${escapeHtml(d.category)}</span>`;
    panel.appendChild(row);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string);
}

type Tab = "result" | "logs" | "js";
let activeTab: Tab = "result";
// What the Results pane shows: the last run's reply and compiled files, or a
// transient note ("compiling…") before a run has produced either.
let lastReply: RunReply | undefined;
let lastFiles: EmittedFile[] = [];
let lastNote = "";

function jumpTo(d: Diagnostic): void {
  const text = source();
  const pos = Math.min(byteToUtf16Offset(text, d.from), view.state.doc.length);
  view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
  view.focus();
}

function setDiagSummary(diags: Diagnostic[]): void {
  const el = $("diag-summary");
  const errors = diags.filter((d) => d.severity === "error").length;
  const warnings = diags.length - errors;
  if (errors > 0) {
    el.textContent = `✕ ${errors} error${errors === 1 ? "" : "s"}`;
    el.dataset.kind = "error";
  } else if (warnings > 0) {
    el.textContent = `▲ ${warnings} warning${warnings === 1 ? "" : "s"}`;
    el.dataset.kind = "warning";
  } else {
    el.textContent = "✓ No errors";
    el.dataset.kind = "ok";
  }
}

function selectTab(tab: Tab): void {
  activeTab = tab;
  for (const t of document.querySelectorAll<HTMLElement>("[role=tab]")) {
    const on = t.dataset.tab === tab;
    t.setAttribute("aria-selected", String(on));
    // Roving tabindex: one stop in the tab order, arrow keys move within the list.
    t.tabIndex = on ? 0 : -1;
  }
  $("output").setAttribute("aria-labelledby", `tab-${tab}`);
  renderOutput();
}

function renderOutput(): void {
  const out = $("output");
  out.innerHTML = "";
  const add = (cls: string, text: string) => {
    const line = document.createElement("div");
    line.className = cls;
    line.textContent = text;
    out.appendChild(line);
  };
  const logs = lastReply?.logs ?? [];
  const badge = $("logs-badge");
  badge.hidden = logs.length === 0;
  badge.textContent = String(logs.length);

  if (activeTab === "js") {
    if (lastFiles.length === 0) {
      add("out-empty", "Nothing compiled yet. Press Run to see the JavaScript Bynk emits.");
      return;
    }
    for (const f of lastFiles) {
      add("out-file", `// ${f.path}`);
      add("out-code", f.contents);
    }
    return;
  }

  const reply = lastReply;
  if (!reply && sandboxFailed) {
    add("out-error", "✕ The code runner hasn't loaded, so programs can't run.");
    add("out-note", `It runs from ${new URL(SANDBOX_ORIGIN).host}: check that an extension, network filter or firewall isn't blocking it.`);
    const retry = document.createElement("button");
    retry.type = "button";
    retry.id = "sandbox-retry";
    retry.textContent = "Try again";
    retry.addEventListener("click", retrySandbox);
    out.appendChild(retry);
    return;
  }
  if (!reply) {
    add("out-empty", lastNote || "Press Run to see the result here.");
    return;
  }
  if (activeTab === "logs") {
    if (logs.length === 0) add("out-empty", "This run logged nothing.");
    for (const log of logs) {
      if (log.level === "error") add("out-error", `✕ ${log.message}`);
      else add("out-log", log.message);
    }
    return;
  }
  // Result tab.
  if (reply.timedOut) {
    add("out-error", `✕ Execution exceeded ${RUN_TIMEOUT_MS} ms and was terminated.`);
    add("out-note", "Check for a loop that never returns.");
    if (logs.length > 0) add("out-note", `It logged ${logs.length} line${logs.length === 1 ? "" : "s"} first: see the Logs tab.`);
    return;
  }
  if (reply.noEntry) {
    add("out-note", "Compiled. No zero-argument service handler to run: add `on call() -> …` to see output.");
    return;
  }
  if (reply.error) {
    add("out-error", `✕ ${reply.error}`);
  } else if (reply.value !== undefined) {
    add("out-value", `⇒ ${reply.value}`);
  } else {
    add("out-note", "Ran with no return value.");
  }
  if (logs.length > 0) add("out-note", `${logs.length} log line${logs.length === 1 ? "" : "s"}: see the Logs tab.`);
}

function showUnsupported(diags: Diagnostic[]): void {
  const lock = diags.find((d) => PLATFORM_LOCK.has(d.category));
  const banner = $("unsupported");
  if (lock) {
    banner.textContent = `Not runnable in-browser: ${lock.message}`;
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
}

// `remember`: the user asked for this run, so it is worth listing under Recent (not an
// automatic first run, an example or a tour starter).
async function compileAndRun(remember = false): Promise<TourOutcome> {
  const id = ++runSeq;
  setStatus("compiling…", "busy");
  lastReply = undefined;
  lastNote = "Compiling…";
  renderOutput();
  let result: CompileResult;
  try {
    result = JSON.parse(bynk_compile(source())) as CompileResult;
  } catch (e) {
    setStatus("compiler error", "error");
    renderDiagnostics([
      { path: null, line: 0, col: 0, from: 0, to: 0, severity: "error", category: "bynk.wasm", message: String(e) },
    ]);
    return { compiled: false };
  }
  renderDiagnostics(result.diagnostics);
  showUnsupported(result.diagnostics);
  setDiagSummary(result.diagnostics);
  lastFiles = result.ok ? result.files : [];

  if (!result.ok) {
    const n = result.diagnostics.filter((d) => d.severity === "error").length;
    lastNote = `Fix the ${n} error${n === 1 ? "" : "s"} above, then run again.`;
    renderOutput();
    selectTab("result");
    setStatus(`${n} error${n === 1 ? "" : "s"}`, "error");
    return { compiled: false };
  }
  if (!sandboxReady) {
    // Compiled, but there is nothing to run it in: not yet (#31), or no longer, because the
    // frame was taken over after the channel was handed out (#30) and only a reload helps.
    const lost = channelOffered;
    lastNote = lost
      ? "The code runner was replaced. Reload the page to run again."
      : "Compiled. The code runner is still loading: press Run again in a moment.";
    renderOutput();
    setStatus(lost ? "code runner lost" : sandboxFailed ? "code runner not loaded" : "code runner loading…", "error");
    return { compiled: true, error: "sandbox not ready" };
  }

  if (remember && !EMBED) rememberRun(source());
  setStatus("running…", "busy");
  const reply = await new Promise<RunReply>((resolve) => {
    pending.set(id, resolve);
    sandboxPort!.postMessage({ kind: "bynk-run", id, files: result.files, timeoutMs: RUN_TIMEOUT_MS });
  });
  // A later Run has started since: its outcome is the one to show.
  if (id !== runSeq) return { compiled: true, superseded: true };
  lastReply = reply;
  renderOutput();
  dismissCoach();
  setStatus(reply.error || reply.timedOut ? "run failed" : "ran", reply.error || reply.timedOut ? "error" : "ok");
  return {
    compiled: true,
    value: reply.value,
    error: reply.error ?? (reply.timedOut ? "timed out" : undefined),
  };
}

// The first-run coachmark, shown until the first Run.
function dismissCoach(): void {
  $("coach").hidden = true;
  try {
    localStorage.setItem("bynk-coach", "1");
  } catch {
    // storage unavailable: the hint just reappears next visit
  }
}

function showCoach(): void {
  if (EMBED) return;
  try {
    if (localStorage.getItem("bynk-coach")) return;
  } catch {
    // fall through and show it
  }
  $("coach").hidden = false;
}

// Run the opening program once both the sandbox and the compiler are ready, so the
// page greets a newcomer with output rather than an empty pane.
let autoRan = false;
function maybeFirstRun(): void {
  if (autoRan || !sandboxReady || !wasmReady) return;
  autoRan = true;
  void compileAndRun();
}

function mountTheme(): void {
  $("theme").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("bynk-theme", next);
    } catch {
      // not persisted
    }
  });
}

// --- Share sheet -----------------------------------------------------------------
// The sheet offers a short `?s=<id>` link from the share service when it is up, and
// always the self-contained `#hash` link (no server, never expires).
interface ShareLinks {
  short?: string;
  hash: string;
}
let shareLinks: ShareLinks | null = null;

function setShareStatus(text: string, kind: "idle" | "ok" | "error" = "idle"): void {
  const el = $("share-status");
  el.textContent = text;
  el.dataset.kind = kind;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// Show `url` in the sheet, put it in the address bar, and copy it.
// The HTML to paste into a page: the same snippet, in the compact `?embed=1` view.
function embedCode(shareUrl: string): string {
  const u = new URL(shareUrl);
  u.searchParams.set("embed", "1");
  const src = u.toString().replace(/&/g, "&amp;");
  return `<iframe src="${src}" title="Bynk playground" width="100%" height="480" loading="lazy" style="border:1px solid #888;border-radius:8px"></iframe>`;
}

async function presentShareLink(url: string, kind: "short" | "hash"): Promise<void> {
  const input = $("share-url") as HTMLInputElement;
  input.value = url;
  window.history.replaceState(null, "", url);
  ($("share-copy") as HTMLButtonElement).disabled = false;
  $("share-note").textContent =
    kind === "short"
      ? "Short links expire after 30 days. The self-contained link never expires."
      : "Self-contained link: the whole program is in the URL, so it needs no server and never expires.";
  $("share-hash").hidden = !(kind === "short" && shareLinks?.hash);
  ($("embed-code") as HTMLTextAreaElement).value = embedCode(url);
  // Clipboard access can be denied (insecure context, permissions): then leave the
  // link selected in the box so Ctrl/Cmd+C works.
  if (await copyText(url)) {
    setShareStatus("✓ Link copied", "ok");
  } else {
    setShareStatus("Copy the link from the box.");
    input.select();
  }
}

async function share(): Promise<void> {
  const src = source();
  const dialog = $("share-sheet") as HTMLDialogElement;
  shareLinks = null;
  ($("share-url") as HTMLInputElement).value = "";
  ($("share-copy") as HTMLButtonElement).disabled = true;
  $("share-note").textContent = "";
  $("share-hash").hidden = true;
  setShareStatus("Creating link…");
  dialog.showModal();

  const hash = `${location.origin}${location.pathname}#${await encodeSnippet(src)}`;
  let short: string | undefined;
  // Prefer a short link via the same-origin share service; the hash link is the
  // fallback, so the playground works without the service.
  try {
    const res = await fetch("/api/snippets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: src }),
    });
    if (res.ok) {
      const { id } = (await res.json()) as { id: string };
      short = `${location.origin}${location.pathname}?s=${encodeURIComponent(id)}`;
    }
  } catch {
    // network/Worker error: use the hash link
  }
  shareLinks = { short, hash };
  hideSharedNote();
  await presentShareLink(short ?? hash, short ? "short" : "hash");
}

function mountShareSheet(): void {
  const dialog = $("share-sheet") as HTMLDialogElement;
  $("share-copy").addEventListener("click", async () => {
    const input = $("share-url") as HTMLInputElement;
    setShareStatus((await copyText(input.value)) ? "✓ Link copied" : "Copy it from the box.", "ok");
    input.select();
  });
  $("embed-copy").addEventListener("click", async () => {
    const box = $("embed-code") as HTMLTextAreaElement;
    setShareStatus((await copyText(box.value)) ? "✓ Embed code copied" : "Copy the code from the box.", "ok");
    box.select();
  });
  $("share-hash").addEventListener("click", () => {
    if (shareLinks) void presentShareLink(shareLinks.hash, "hash");
  });
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => $("share").focus());
}

// --- Shared snippets --------------------------------------------------------------
// A snippet opened from a link is the author's, and links never change. Fork drops
// the share URL so the editor is plainly the reader's own copy.
let openedShared = false;
let restoredDraft = false;
// Why a `?s=` link could not be opened, if it could not (#26): `missing` when the service
// has no such snippet (expired after 30 days, or never existed), `unreachable` when the
// service did not answer.
let linkProblem: "missing" | "unreachable" | null = null;
let draftTimer: number | undefined;

function hideSharedNote(): void {
  $("shared-note").hidden = true;
}

// Save the editor's contents shortly after the last keystroke. Skipped during the
// tour (its starters are not the learner's own work).
function scheduleDraftSave(): void {
  if (EMBED) return;
  window.clearTimeout(draftTimer);
  draftTimer = window.setTimeout(() => {
    if (tourIndex < 0) saveDraft(source());
  }, 400);
}

function mountRestoredNote(): void {
  const note = $("restored-note");
  if (restoredDraft) note.hidden = false;
  $("restored-dismiss").addEventListener("click", () => (note.hidden = true));
  $("start-fresh").addEventListener("click", () => {
    clearDraft();
    note.hidden = true;
    currentExampleId = EXAMPLES[0].id;
    loadSnippet(DEFAULT_SOURCE);
  });
}

// Say why a share link did not open, and what the editor shows instead. It takes the
// place of the "restored" bar, which would otherwise read as if the link had worked.
function mountLinkNote(): void {
  const note = $("link-note");
  $("link-dismiss").addEventListener("click", () => (note.hidden = true));
  if (!linkProblem) return;
  const text = $("link-note-text");
  const strong = document.createElement("strong");
  strong.textContent =
    linkProblem === "missing" ? "This share link has expired or doesn't exist." : "Couldn't open this share link.";
  const why =
    linkProblem === "missing"
      ? " Short links last 30 days; the self-contained link never expires."
      : " The share service didn't answer; reload to try again.";
  const instead = openedShared ? "" : restoredDraft ? " Showing your last snippet." : " Showing the starter program.";
  text.replaceChildren(strong, why + instead);
  note.hidden = false;
  $("restored-note").hidden = true;
}

function mountSharedNote(): void {
  if (openedShared && !EMBED) $("shared-note").hidden = false;
  $("shared-dismiss").addEventListener("click", hideSharedNote);
  $("fork").addEventListener("click", () => {
    window.history.replaceState(null, "", location.pathname);
    hideSharedNote();
    setStatus("forked: this is your copy", "ok");
    view.focus();
  });
}

// A shared link replaces the editor, and the first edit would then replace the saved
// draft: keep that draft under Recent first.
function keepStoredDraft(): void {
  if (EMBED) return;
  const draft = loadDraft();
  if (draft && draft.trim() !== "" && draft !== DEFAULT_SOURCE) rememberRun(draft);
}

// The initial program: a `?s=<id>` shared snippet (via the service), else a `#hash`
// snippet, else the default example.
async function loadInitialSource(): Promise<string> {
  const t = initialTourIndex();
  if (t >= 0) return TOUR[t].starter;
  const id = new URLSearchParams(location.search).get("s");
  if (id) {
    try {
      const res = await fetch(`/api/snippets/${encodeURIComponent(id)}`);
      if (res.ok) {
        openedShared = true;
        keepStoredDraft();
        return ((await res.json()) as { source: string }).source;
      }
      // 404: no such snippet. 400: not a valid id, so there never was one.
      linkProblem = res.status === 404 || res.status === 400 ? "missing" : "unreachable";
    } catch {
      linkProblem = "unreachable";
    }
    // A missing snippet will not come back, so drop the dead link; an unreachable
    // service may, so keep it for a reload. Either way, fall through to the hash / default.
    if (linkProblem === "missing") window.history.replaceState(null, "", location.pathname + location.hash);
  }
  const fromHash = await decodeSnippet(location.hash);
  if (fromHash !== null && fromHash !== undefined) {
    openedShared = true;
    keepStoredDraft();
    return fromHash;
  }
  // No link: pick up where the last visit left off.
  const draft = EMBED ? null : loadDraft();
  if (draft && draft.trim() !== "" && draft !== DEFAULT_SOURCE) {
    restoredDraft = true;
    currentExampleId = null;
    return draft;
  }
  return DEFAULT_SOURCE;
}

// What the app last put in the editor itself: an example, a Recent entry, a tour step, a
// shared snippet or the default program. Anything else there is the user's own work.
let pristine: string | null = null;

// Keep the user's own work under Recent before the editor is replaced, so loading an
// example, a Recent entry, Start fresh or the tour never loses a program that was never
// run (#23). The tour's own code is not kept: exiting the tour restores what was there.
function keepOutgoing(): void {
  if (EMBED || tourIndex >= 0) return;
  const src = source();
  if (src.trim() !== "" && src !== pristine) rememberRun(src);
}

// `own`: `src` is the user's work (a restored draft), not something the app supplied.
function setEditorContent(src: string, own = false): void {
  keepOutgoing();
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: src } });
  pristine = own ? null : src;
  view.focus();
}

// The example last loaded from the gallery, shown as "Current" there.
let currentExampleId: string | null = EXAMPLES[0].id;

function loadSnippet(src: string): void {
  setEditorContent(src);
  // Loading a snippet drops any shared-snippet URL (?s= / #hash) so a reshare is
  // clean. (`window.history`; the bare `history` is CodeMirror's editor history.)
  window.history.replaceState(null, "", location.pathname);
  void compileAndRun();
}

function mountExamples(): void {
  mountGallery({
    currentId: () => currentExampleId,
    onPick: (ex: Example) => {
      exitTour();
      currentExampleId = ex.id;
      loadSnippet(ex.source);
    },
    recent: loadRecent,
    onPickRecent: (r) => {
      exitTour();
      currentExampleId = null;
      loadSnippet(r.src);
    },
  });
}

// --- Guided tour -----------------------------------------------------------------
let tourIndex = -1;
let tourDone = false;

// The Tour button says how far along the learner is.
function updateTourButton(): void {
  const done = loadTourDone().filter((id) => TOUR.some((s) => s.id === id)).length;
  $("tour-btn").textContent = done === 0 ? "Tour" : done === TOUR.length ? "Tour ✓" : `Tour · ${done}/${TOUR.length}`;
  $("tour-restart").hidden = done === 0;
}

function tourStep(): TourStep | undefined {
  return TOUR[tourIndex];
}

function setTourFeedback(text: string, kind: "ok" | "miss" | "idle" = "idle"): void {
  const el = $("tour-feedback");
  renderProse(el, text);
  el.dataset.kind = kind;
}

// Render `backticked` words as <code> without ever treating the prose as HTML.
function renderProse(el: HTMLElement, text: string): void {
  el.textContent = "";
  text.split("`").forEach((part, i) => {
    if (i % 2 === 1) {
      const code = document.createElement("code");
      code.textContent = part;
      el.append(code);
    } else {
      el.append(part);
    }
  });
}

// `fresh` is false when the page opened on this step: the editor already holds the
// starter and the first-run path runs it once the compiler is ready.
// What the editor held before the tour, restored when it ends, and whether that was the
// user's own work.
let preTour: string | null = null;
let preTourOwn = false;

function showTourStep(i: number, fresh = true): void {
  const step = TOUR[i];
  if (tourIndex < 0 && fresh) {
    preTour = source();
    preTourOwn = preTour !== pristine;
  }
  tourIndex = i;
  tourDone = false;
  currentExampleId = null;
  $("tour").hidden = false;
  dismissCoach();
  $("tour-btn").setAttribute("aria-pressed", "true");
  const doneBefore = loadTourDone().includes(step.id);
  $("tour-count").textContent = `Tour · step ${i + 1} of ${TOUR.length}`;
  $("tour-title").textContent = step.title;
  renderProse($("tour-prose"), step.prose);
  renderProse($("tour-task"), step.task);
  setTourFeedback(doneBefore ? "✓ You passed this step earlier." : "", doneBefore ? "ok" : "idle");
  tourDone = doneBefore;
  ($("tour-next") as HTMLButtonElement).disabled = !doneBefore;
  updateTourButton();
  $("tour-next").textContent = i === TOUR.length - 1 ? "Finish" : "Next";
  window.history.replaceState(null, "", `${location.pathname}?tour=${encodeURIComponent(step.id)}`);
  if (!fresh) return;
  setEditorContent(step.starter);
  void compileAndRun();
}

// Leave the tour and put back what the editor held before it (or, when the page opened
// on a tour step, the saved draft). `run`: run it too, as the editor did before the tour.
function exitTour(run = false): void {
  if (tourIndex < 0) return;
  // Opened on a tour step: the saved draft is what the editor would have held.
  const own = preTour === null || preTourOwn;
  const back = preTour ?? (EMBED ? null : loadDraft());
  preTour = null;
  // Restored while the tour is still on, so the tour's code is not kept under Recent.
  if (back !== null && back.trim() !== "") setEditorContent(back, own);
  tourIndex = -1;
  $("tour").hidden = true;
  $("tour-btn").setAttribute("aria-pressed", "false");
  window.history.replaceState(null, "", location.pathname);
  if (run && back !== null) void compileAndRun();
}

let checkSeq = 0;

async function checkTour(): Promise<void> {
  const step = tourStep();
  if (!step) return;
  const check = ++checkSeq;
  setTourFeedback("Checking…");
  const outcome = await compileAndRun();
  if (outcome.superseded) {
    // A plain Run replaced this check; a newer Check reports for itself.
    if (check === checkSeq) setTourFeedback("");
    return;
  }
  const miss = step.check(outcome);
  if (miss === null) {
    tourDone = true;
    markTourDone(step.id);
    updateTourButton();
    setTourFeedback("✓ Output matched. Well done.", "ok");
    ($("tour-next") as HTMLButtonElement).disabled = false;
  } else {
    setTourFeedback(outcome.compiled ? miss : `${miss} ${step.hint}`, "miss");
  }
}

function nextTour(): void {
  if (!tourDone) return;
  if (tourIndex === TOUR.length - 1) {
    exitTour();
    setStatus("tour complete", "ok");
    window.history.replaceState(null, "", location.pathname);
    return;
  }
  showTourStep(tourIndex + 1);
}

function mountTour(): void {
  $("tour-btn").addEventListener("click", () =>
    tourIndex >= 0 ? exitTour(true) : showTourStep(nextIncomplete(TOUR.map((s) => s.id), loadTourDone())),
  );
  $("tour-restart").addEventListener("click", () => {
    resetTourDone();
    showTourStep(0);
  });
  updateTourButton();
  $("tour-exit").addEventListener("click", () => exitTour(true));
  $("tour-check").addEventListener("click", () => void checkTour());
  $("tour-next").addEventListener("click", nextTour);
  $("tour-solution").addEventListener("click", () => {
    const step = tourStep();
    if (step) setEditorContent(step.solution);
  });
}

// `?tour=<id>` opens the tour at that step.
function initialTourIndex(): number {
  if (EMBED) return -1;
  const id = new URLSearchParams(location.search).get("tour");
  return id ? TOUR.findIndex((s) => s.id === id) : -1;
}

function makeEditor(doc: string): void {
  view = new EditorView({
    parent: $("editor"),
    state: EditorState.create({
      doc,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        history(),
        keymap.of([
          { key: "Mod-Enter", run: () => (void compileAndRun(true), true) },
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) scheduleDraftSave();
        }),
        highlightCompartment.of(bynkHighlighting()),
        bynkLinter,
        lintGutter(),
        bynkHover,
        autocompletion({ override: [bynkCompletions] }),
        EditorView.theme({ "&": { height: "100%" }, ".cm-scroller": { overflow: "auto" } }, {}),
      ],
    }),
  });
}

// The frame no longer holds the runner the channel was handed to: stop using the channel,
// and end any run waiting on it rather than leave it hanging.
function loseSandbox(): void {
  sandboxPort?.close();
  sandboxPort = null;
  sandboxReady = false;
  for (const [id, resolve] of pending) {
    resolve({ kind: "bynk-result", id, logs: [], error: "The code runner was replaced. Reload the page to run again." });
  }
  pending.clear();
  setStatus("code runner lost", "error");
}

// The frame's load events, and how many there had been when the app last pointed it at
// the runner. The runner's own load comes after its "ready", so one more load than that is
// expected; any beyond it means something else navigated the frame (#30).
let sandboxLoads = 0;
let loadsBeforeSrc = 0;

// How long the code runner may take to say it is ready before the page says why nothing
// runs and offers to try again (#31).
const SANDBOX_LOAD_MS = 8000;
let sandboxTimer: number | undefined;

function watchSandboxLoad(): void {
  window.clearTimeout(sandboxTimer);
  sandboxTimer = window.setTimeout(() => {
    if (sandboxReady) return;
    sandboxFailed = true;
    setStatus("code runner not loaded", "error");
    renderOutput();
  }, SANDBOX_LOAD_MS);
}

// Reload the iframe in place: same element and window, so the message listener stands.
function retrySandbox(): void {
  sandboxFailed = false;
  setStatus("loading…", "busy");
  const iframe = $("sandbox") as HTMLIFrameElement;
  loadsBeforeSrc = sandboxLoads;
  iframe.src = iframe.src;
  lastNote = "Loading the code runner…";
  renderOutput();
  watchSandboxLoad();
}

function mountSandbox(): void {
  const iframe = document.createElement("iframe");
  iframe.id = "sandbox";
  // Distinct origin + opaque sandbox: even a sandbox escape lands on a bare origin.
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.src = `${SANDBOX_ORIGIN}/sandbox.html`;
  iframe.hidden = true;
  document.body.appendChild(iframe);
  watchSandboxLoad();

  // A load beyond the runner's own, after the handshake, means the frame was navigated:
  // whatever is there now has no channel, so treat the runner as lost.
  iframe.addEventListener("load", () => {
    sandboxLoads++;
    if (sandboxPort && sandboxLoads > loadsBeforeSrc + 1) loseSandbox();
  });

  window.addEventListener("message", (e: MessageEvent) => {
    // The ready message comes from the opaque-origin iframe; identify it by window, not
    // origin. Only the first one is answered: one channel per page.
    if (e.source !== iframe.contentWindow || channelOffered) return;
    if ((e.data as { kind?: string })?.kind !== "bynk-sandbox-ready") return;
    channelOffered = true;
    const channel = new MessageChannel();
    sandboxPort = channel.port1;
    sandboxPort.onmessage = (m: MessageEvent) => {
      const data = m.data as { kind?: string; id?: number };
      if (data?.kind !== "bynk-result" || typeof data.id !== "number") return;
      const resolve = pending.get(data.id);
      if (resolve) {
        pending.delete(data.id);
        resolve(data as RunReply);
      }
    };
    // The opaque origin can't be named; the sandbox accepts the port only from the app origin.
    iframe.contentWindow!.postMessage({ kind: "bynk-connect" } satisfies SandboxConnect, "*", [channel.port2]);
    sandboxReady = true;
    sandboxFailed = false;
    window.clearTimeout(sandboxTimer);
    setStatus("ready", "ok");
    if (!lastReply) {
      lastNote = "";
      renderOutput();
    }
    maybeFirstRun();
  });
}

async function main(): Promise<void> {
  setStatus("loading…", "busy");
  mountSandbox();
  const initial = await loadInitialSource();
  makeEditor(initial);
  pristine = restoredDraft ? null : initial;
  mountExamples();
  mountTour();
  mountShareSheet();
  mountSharedNote();
  mountRestoredNote();
  mountLinkNote();
  if (EMBED) {
    // "Open in playground": the same snippet in the full page, in a new tab.
    const u = new URL(location.href);
    u.searchParams.delete("embed");
    const link = $("open-full") as HTMLAnchorElement;
    link.href = u.toString();
    link.hidden = false;
  }
  if (IS_APPLE) {
    $("run-key").textContent = "⌘↵";
    $("run").title = "Compile & run (⌘↵)";
  }
  $("run").addEventListener("click", () => void compileAndRun(true));
  $("share").addEventListener("click", () => void share());
  $("coach-dismiss").addEventListener("click", dismissCoach);
  const tabs = [...document.querySelectorAll<HTMLElement>("[role=tab]")];
  for (const t of tabs) {
    t.addEventListener("click", () => selectTab(t.dataset.tab as Tab));
    t.addEventListener("keydown", (e) => {
      const i = tabs.indexOf(t);
      const target =
        e.key === "ArrowRight" ? tabs[(i + 1) % tabs.length]
        : e.key === "ArrowLeft" ? tabs[(i - 1 + tabs.length) % tabs.length]
        : e.key === "Home" ? tabs[0]
        : e.key === "End" ? tabs[tabs.length - 1]
        : null;
      if (!target) return;
      e.preventDefault();
      selectTab(target.dataset.tab as Tab);
      target.focus();
    });
  }
  selectTab("result");
  // Run from anywhere, not only inside the editor.
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !(e.target as HTMLElement).closest(".cm-editor")) {
      e.preventDefault();
      void compileAndRun(true);
    }
  });
  mountTheme();
  showCoach();
  renderOutput();
  const t0 = initialTourIndex();
  if (t0 >= 0) {
    showTourStep(t0, false);
  }
  // Load the wasm compiler. Resolve the module against the page URL (not
  // `import.meta.url`) so esbuild leaves the path alone and the `.wasm` is fetched
  // from the deploy root.
  await init(new URL(BYNK_WASM, location.href));
  wasmReady = true;
  if (!sandboxReady) setStatus("compiler ready", "ok");
  // Lint the initial program now that the analyser is loaded.
  forceLinting(view);
  maybeFirstRun();

  // Upgrade highlighting to web-tree-sitter once its wasm loads; on failure the
  // stream highlighter stays (slice 5b).
  const ts = await bynkTreeSitterHighlighting();
  if (ts) view.dispatch({ effects: highlightCompartment.reconfigure(ts) });
}

void main();
