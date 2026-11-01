// Arguments for a run (#82): when no service handler takes zero arguments, Run calls the
// first service's `on call(…)` with values typed into the Arguments row.
//
// The compiler's wasm API doesn't report a handler's signature, so it is read from the
// source here: a small scanner that blanks out comments and strings, then reads the
// parameter list of each `on call(…)` inside a `service` block (an agent's named
// `on call add(…)` handlers can't run here and are skipped).
//
// Only types a field can be checked against are offered: `String`, `Int`, `Float`, `Bool`,
// and refinements of them declared in the file. The sandbox checks a refinement with the
// compiled type's own `T.of`. Anything else (a record, a `List`, an `Option`) is reported
// as not enterable yet, rather than passed through unchecked.

export type InputKind = "string" | "int" | "float" | "bool";

export interface Param {
  name: string;
  /// The declared type, as written.
  type: string;
  /// The field to show, or null when the type can't be entered here.
  input: InputKind | null;
  /// The file's refinements the value must pass, outermost first (`Slug`, then the type
  /// `Slug` refines, if that is one too).
  refines: string[];
}

export type EntrySignature =
  /// No service handler at all.
  | { kind: "none" }
  /// A zero-argument handler: Run calls it as it always has.
  | { kind: "zero" }
  /// The first service's `on call(…)`, which takes arguments.
  | { kind: "params"; service: string; params: Param[] };

const PRIMITIVES: Record<string, InputKind> = { String: "string", Int: "int", Float: "float", Bool: "bool" };

/// `source` with comments, doc blocks and string contents replaced by spaces, so the
/// scanner never reads code that isn't there. Offsets and newlines are kept.
export function mask(source: string): string {
  const out = source.split("");
  let i = 0;
  let lineStart = true;
  let inDoc = false;
  while (i < source.length) {
    const c = source[i];
    if (lineStart) {
      // A doc block is delimited by lines that are only `---`.
      const end = source.indexOf("\n", i);
      const line = source.slice(i, end === -1 ? source.length : end);
      if (line.trim() === "---" || inDoc) {
        if (line.trim() === "---") inDoc = !inDoc;
        for (let j = i; j < i + line.length; j++) out[j] = " ";
        i += line.length;
        lineStart = false;
        continue;
      }
    }
    lineStart = false;
    if (c === "\n") {
      lineStart = true;
      i++;
    } else if (c === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") out[i++] = " ";
    } else if (c === '"') {
      i++;
      while (i < source.length && source[i] !== '"' && source[i] !== "\n") {
        if (source[i] === "\\") out[i++] = " ";
        if (i < source.length) out[i++] = " ";
      }
      i++;
    } else {
      i++;
    }
  }
  return out.join("");
}

// The index just past the bracket that closes the one at `open`, or -1.
function closing(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

// Split `a: Int, b: Map[String, Int]` at its top-level commas.
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

/// The run's entry, read from the source.
export function entrySignature(source: string): EntrySignature {
  const text = mask(source);
  // `type Slug = String where …`: a refinement, and the type it refines.
  const refined = new Map<string, string>();
  for (const m of text.matchAll(/\btype\s+([A-Z]\w*)\s*=\s*([A-Z]\w*)\s+where\b/g)) refined.set(m[1], m[2]);

  const handlers: { service: string; params: string[] }[] = [];
  for (const svc of text.matchAll(/\bservice\s+(\w+)[^{}]*\{/g)) {
    const open = svc.index! + svc[0].length - 1;
    const end = closing(text, open);
    const body = text.slice(open, end === -1 ? text.length : end);
    for (const on of body.matchAll(/\bon\s+call\s*\(/g)) {
      const paren = on.index! + on[0].length - 1;
      const close = closing(body, paren);
      if (close === -1) continue;
      handlers.push({ service: svc[1], params: splitTopLevel(body.slice(paren + 1, close - 1)) });
    }
  }
  if (handlers.length === 0) return { kind: "none" };
  if (handlers.some((h) => h.params.length === 0)) return { kind: "zero" };

  const first = handlers[0];
  const params = first.params.map((p): Param => {
    const colon = p.indexOf(":");
    const name = (colon === -1 ? p : p.slice(0, colon)).trim();
    const type = colon === -1 ? "" : p.slice(colon + 1).trim();
    const refines: string[] = [];
    let base = type;
    while (refined.has(base) && !refines.includes(base)) {
      refines.push(base);
      base = refined.get(base)!;
    }
    return { name, type, input: PRIMITIVES[base] ?? null, refines };
  });
  return { kind: "params", service: first.service, params };
}

export type FieldValue = string | boolean;

/// A field's value as the argument the handler takes, or why it isn't one.
export function readArg(param: Param, raw: FieldValue | undefined): { value: unknown } | { error: string } {
  switch (param.input) {
    case "bool":
      return { value: raw === true };
    case "string":
      return { value: typeof raw === "string" ? raw : "" };
    case "int": {
      const s = typeof raw === "string" ? raw.trim() : "";
      if (!/^[+-]?\d+$/.test(s)) return { error: `\`${param.name}\` needs a whole number` };
      const n = Number(s);
      if (!Number.isSafeInteger(n)) return { error: `\`${param.name}\` is too large for an Int` };
      return { value: n };
    }
    case "float": {
      const s = typeof raw === "string" ? raw.trim() : "";
      const n = Number(s);
      if (s === "" || !Number.isFinite(n)) return { error: `\`${param.name}\` needs a number` };
      return { value: n };
    }
    default:
      return { error: `a \`${param.type}\` can't be entered here yet` };
  }
}

/// Field values in a link's `?args=`: a JSON object keyed by parameter name, so a value
/// can't land in the wrong parameter after the list is reordered.
export function encodeArgs(values: Record<string, FieldValue>): string {
  return JSON.stringify(values);
}

export function decodeArgs(text: string | null): Record<string, FieldValue> {
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, FieldValue> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string" || typeof v === "boolean") out[k] = v;
      else if (typeof v === "number" && Number.isFinite(v)) out[k] = String(v);
    }
    return out;
  } catch {
    return {};
  }
}
