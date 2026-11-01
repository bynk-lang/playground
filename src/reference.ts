// The standard library reference (#85): built-in types and their functions, the `bynk`
// capabilities and their operations, and the first-party modules' functions, with
// signatures.
//
// Everything here is read from the compiler the page runs, through the same completion
// call that drives the editor (`bynk_complete`), so it can't drift from the release: a
// probe program is completed at the spot that lists what's wanted (`consumes bynk { | }`
// lists the capabilities, `Int.|` lists Int's functions, and so on). The compiler doesn't
// expose methods on values (`s.trim()`, `xs.fold(…)`) or doc comments to the browser, so
// the panel says so rather than listing a copy of its own.

export interface CompletionItem {
  label: string;
  kind: string;
  detail?: string;
}

/// `bynk_complete` at a UTF-8 byte offset, parsed.
export type Complete = (source: string, offset: number) => CompletionItem[];

export interface RefEntry {
  /// What it is called: `Int.parse`, `Logger.info`, `bynk.list.map`.
  name: string;
  signature: string;
}

export interface RefGroup {
  section: "Types" | "Capabilities" | "Modules";
  /// The type, capability or module: `Int`, `Logger`, `bynk.list`.
  owner: string;
  /// The compiler's one-line description of it, when it has one.
  about?: string;
  entries: RefEntry[];
}

// Built-in types that have functions but aren't offered as a type name in expression
// position, so can't be found by listing. test/reference.test.mjs checks each still has
// at least one function, so a rename shows up.
export const EXTRA_TYPES = ["Bytes", "Json"];

// Complete `source` where `@@` is, with the marker removed.
function at(complete: Complete, source: string): CompletionItem[] {
  const i = source.indexOf("@@");
  const text = source.slice(0, i) + source.slice(i + 2);
  return complete(text, new TextEncoder().encode(source.slice(0, i)).length);
}

const unit = (head: string, body: string, given = "") =>
  `context demo.reference\n\n${head}\nservice s {\n\ton call() -> Effect[Int]${given} {\n${body}\n\t\t1\n\t}\n}\n`;

// The signature, without the compiler's trailing " — operation of `Logger`" / " — `bynk.list`".
const signature = (detail = "") => detail.replace(/\s+—\s+.*$/, "");

export function harvestReference(complete: Complete): RefGroup[] {
  const groups: RefGroup[] = [];

  // Types: every type name offered in expression position, plus the extras, with the
  // functions each has (`Int.parse`). A type without functions is listed only when the
  // compiler describes it.
  const typeItems = at(complete, unit("", "\t\tlet x = @@")).filter((i) => i.kind === "type");
  const types = new Map<string, string | undefined>();
  for (const t of typeItems) types.set(t.label, t.detail && t.detail !== "type" ? t.detail : undefined);
  for (const t of EXTRA_TYPES) if (!types.has(t)) types.set(t, undefined);
  for (const [name, about] of types) {
    const members = at(complete, unit("", `\t\tlet x = ${name}.@@`)).filter((i) => i.kind === "member");
    // An undescribed type with nothing but `of`/`unsafe` is a refined or opaque type
    // (`Uuid`, the experimental crypto keys): those are the constructors every such type
    // has, not library functions to look up.
    if (!about && members.every((m) => m.label === "of" || m.label === "unsafe")) continue;
    groups.push({
      section: "Types",
      owner: name,
      about,
      entries: members.map((m) => ({ name: `${name}.${m.label}`, signature: signature(m.detail) })),
    });
  }

  // Capabilities: the ones `bynk` exports, and each one's operations.
  const caps = at(complete, unit("consumes bynk { @@ }\n", "")).filter((i) => i.kind === "capability").map((i) => i.label);
  const head = `consumes bynk { ${caps.join(", ")} }\nuses bynk.locale.types\n`;
  const given = caps.length > 0 ? ` given ${caps.join(", ")}` : "";
  for (const cap of caps) {
    const ops = at(complete, unit(head, `\t\tlet x = ${cap}.@@`, given)).filter((i) => i.kind === "member");
    groups.push({
      section: "Capabilities",
      owner: cap,
      entries: ops.map((o) => ({ name: `${cap}.${o.label}`, signature: signature(o.detail) })),
    });
  }

  // Modules: the first-party commons, and the functions `uses` brings in from each.
  const modules = at(complete, unit("uses bynk.@@\n", "")).filter((i) => i.kind === "unit").map((i) => i.label);
  for (const mod of modules) {
    const fns = at(complete, unit(`uses ${mod}\n`, "\t\tlet x = @@")).filter((i) => i.kind === "function");
    if (fns.length === 0) continue;
    groups.push({
      section: "Modules",
      owner: mod,
      entries: fns.map((f) => ({ name: f.label, signature: signature(f.detail) })),
    });
  }
  return groups;
}

/// The groups and entries matching `query`: every word must appear in the entry's name or
/// signature, or in its group's name or description ("parse int" finds `Int.parse`).
export function searchReference(groups: RefGroup[], query: string): RefGroup[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return groups;
  const out: RefGroup[] = [];
  for (const g of groups) {
    const groupText = `${g.owner} ${g.about ?? ""}`.toLowerCase();
    const entries = g.entries.filter((e) => {
      const text = `${groupText} ${e.name} ${e.signature}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
    if (entries.length > 0) out.push({ ...g, entries });
    else if (words.every((w) => groupText.includes(w))) out.push({ ...g, entries: [] });
  }
  return out;
}
