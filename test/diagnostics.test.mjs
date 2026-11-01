// A diagnostic row's help (src/diagnostics.ts): every compiler code links to its section
// of the Book's diagnostic index, and each "Try:" hint is keyed by a code the staged
// compiler really emits for that mistake, so a renamed code fails here, not silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transform } from "esbuild";

const vendor = new URL("../src/vendor/", import.meta.url);
const { default: init, bynk_compile } = await import(new URL("bynk_wasm.js", vendor));
await init({ module_or_path: await readFile(new URL("bynk_wasm_bg.wasm", vendor)) });

const source = await readFile(new URL("../src/diagnostics.ts", import.meta.url), "utf8");
const { code } = await transform(source, { loader: "ts", format: "esm" });
const { hintFor, learnMoreHref } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

const program = (body, { decls = "", given = " given Logger" } = {}) =>
  `context demo.t\n\nconsumes bynk { Logger }\n${decls}\nservice s {\n\ton call() -> Effect[String]${given} {\n${body}\n\t}\n}\n`;

// Each newcomer mistake, and the code the compiler reports for it.
const MISTAKES = [
  ["a capability used without `given`", program(`\t\tlet _ <- Logger.info("hi")\n\t\t"x"`, { given: "" }), "bynk.given.undeclared_capability"],
  ["a misspelt capability", program(`\t\t"x"`, { given: " given Clok" }), "bynk.given.unknown_capability"],
  ["a capability declared but not used", program(`\t\t"x"`), "bynk.given.unused_capability"],
  [
    "a match missing a case",
    program(`\t\tlet _ <- Logger.info("hi")\n\t\tmatch Green {\n\t\t\tRed => "stop",\n\t\t\tGreen => "go",\n\t\t}`, {
      decls: "\ntype Light = enum { Red, Green, Yellow }\n",
    }),
    "bynk.types.non_exhaustive_match",
  ],
  ["a body of the wrong type", program(`\t\tlet _ <- Logger.info("hi")\n\t\t42`), "bynk.types.return_mismatch"],
  ["a let of the wrong type", program(`\t\tlet _ <- Logger.info("hi")\n\t\tlet n: Int = "x"\n\t\t"y"`), "bynk.types.let_annotation_mismatch"],
  ["an argument of the wrong type", program(`\t\tlet _ <- Logger.info("hi")\n\t\tf("x")`, { decls: '\nfn f(n: Int) -> String { "a" }\n' }), "bynk.types.argument_mismatch"],
  [
    "a literal that breaks a refinement",
    program(`\t\tlet _ <- Logger.info("hi")\n\t\tlet s: Slug = "Hello"\n\t\t"y"`, { decls: '\ntype Slug = String where Matches("[a-z]+")\n' }),
    "bynk.refine.literal_violates",
  ],
  ["an unknown name", program(`\t\tlet _ <- Logger.info("hi")\n\t\tfoo`), "bynk.resolve.unknown_name"],
];

for (const [what, src, expected] of MISTAKES) {
  test(`${what} reports ${expected}, which has a hint and a docs link`, () => {
    const codes = JSON.parse(bynk_compile(src)).diagnostics.map((d) => d.category);
    assert.ok(codes.includes(expected), `expected ${expected}, got ${codes.join(", ")}`);
    assert.ok(hintFor(expected), `a hint for ${expected}`);
    assert.match(learnMoreHref(expected), /^https:\/\/bynk-lang\.org\/book\/reference\/diagnostics\/#[a-z-]+$/);
  });
}

test("a code links to its category's section of the diagnostic index", () => {
  const index = "https://bynk-lang.org/book/reference/diagnostics/";
  assert.equal(learnMoreHref("bynk.types.non_exhaustive_match"), `${index}#type-checking`);
  assert.equal(learnMoreHref("bynk.given.unused_capability"), `${index}#given-capabilities`);
  assert.equal(learnMoreHref("bynk.property.whatever"), `${index}#properties-generative-tests`);
  assert.equal(learnMoreHref("bynk.parse.expected_unit_header"), `${index}#parser`);
  // A segment the index doesn't head is listed under "Other".
  assert.equal(learnMoreHref("bynk.target.vendor_required"), `${index}#other`);
});

test("the playground's own codes have no docs link, and most codes no hint", () => {
  assert.equal(learnMoreHref("bynk.format"), null);
  assert.equal(learnMoreHref("bynk.wasm.panic"), null);
  assert.equal(learnMoreHref("not.a.code"), null);
  assert.equal(hintFor("bynk.parse.expected_unit_header"), null);
});
