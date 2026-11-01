// Help for a diagnostic row: where to read about its code, and a one-line "Try:" hint
// for the mistakes newcomers make most.
//
// Every compiler code is listed in the Book's diagnostic index, grouped by the code's
// second dotted segment (`bynk.types.return_mismatch` → "Type checking"). The index has
// no per-code anchors, so a row links to its category's section; the index itself links
// the curated codes on to their concept pages.

const INDEX = "https://bynk-lang.org/book/reference/diagnostics/";

// The index's section anchors, keyed by code segment. Read off the published page's
// `<h2 id>`s rather than slugged from the titles, so a heading like "Properties
// (generative tests)" can't be guessed wrong. A segment not listed here is in "Other".
const SECTIONS: Record<string, string> = {
  agent: "agents",
  agents: "agents",
  asset: "static-assets",
  boundary: "boundaries",
  capability: "capabilities",
  cloudflare: "cloudflare",
  consumes: "consumes",
  context: "contexts",
  contract: "contracts",
  cron: "cron",
  doc: "doc-comments",
  effect: "effects",
  embed: "embedded-text",
  expect: "expectations",
  exports: "exports",
  given: "given-capabilities",
  http: "http",
  lex: "lexer",
  messages: "message-bundles",
  observe: "observation",
  parse: "parser",
  project: "project",
  property: "properties-generative-tests",
  provider: "providers",
  queue: "queue",
  record_spread: "record-spread",
  refine: "refinement",
  resolve: "resolution",
  service: "services",
  stability: "stability",
  suite: "suites-and-cases",
  transition: "transitions-step-invariants",
  types: "type-checking",
  uses: "uses",
  val: "value-fabrication",
};

// Codes the playground makes up itself (a formatter failure, a wasm fault): not in the
// compiler's index, so there is nothing to link to.
const LOCAL = new Set(["format", "wasm"]);

/// The diagnostic index section that documents `code`, or null for a code that isn't
/// the compiler's.
export function learnMoreHref(code: string): string | null {
  const [root, segment] = code.split(".");
  if (root !== "bynk" || !segment || LOCAL.has(segment)) return null;
  return `${INDEX}#${SECTIONS[segment] ?? "other"}`;
}

const TYPE_MISMATCH = "Make the two types agree: convert the value, or change the type that was declared.";

// The hints, by exact code. Each code here is one the pinned compiler really emits for
// the mistake (test/diagnostics.test.mjs triggers every one), so a rename shows up.
const HINTS: Record<string, string> = {
  "bynk.given.undeclared_capability":
    "List the capability after `given` in the handler's signature, e.g. `on call() -> Effect[String] given Logger`.",
  "bynk.given.unknown_capability":
    "Check the spelling, and bring the capability in with `consumes bynk { … }` at the top of the file.",
  "bynk.given.unused_capability": "Remove it from `given`, or use it in the handler's body.",
  "bynk.types.non_exhaustive_match": "Add an arm for each missing case, or a last `_ => …` arm for the rest.",
  "bynk.types.return_mismatch": TYPE_MISMATCH,
  "bynk.types.let_annotation_mismatch": TYPE_MISMATCH,
  "bynk.types.argument_mismatch": TYPE_MISMATCH,
  "bynk.refine.literal_violates":
    "Use a value that meets the type's rule, or check one at run time with `T.of(…)`, which returns `Ok` or `Err`.",
  "bynk.resolve.unknown_name": "Check the spelling: a name has to be declared, or brought in with `consumes`, before it's used.",
};

/// A one-line fix to try for `code`, or null when there isn't a stock one.
export function hintFor(code: string): string | null {
  return HINTS[code] ?? null;
}
