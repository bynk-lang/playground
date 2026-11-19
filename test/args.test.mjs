// Arguments for a run (src/args.ts): the entry handler's signature, read from source, and
// a field's text as the value the handler takes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transform } from "esbuild";

const source = await readFile(new URL("../src/args.ts", import.meta.url), "utf8");
const { code } = await transform(source, { loader: "ts", format: "esm" });
const { entrySignature, readArg, encodeArgs, decodeArgs, mask } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

const program = (handlers, decls = "") => `context demo.t\n${decls}\nservice playground {\n${handlers}\n}\n`;

test("a zero-argument playground handler is the entry", () => {
  assert.deepEqual(entrySignature(program('\ton call() -> Effect[String] {\n\t\t"x"\n\t}')), { kind: "zero" });
});

test("only `service playground` is the entry, whatever else is declared", () => {
  const two = `context demo.t\n\nservice a {\n\ton call() -> Effect[Int] {\n\t\t1\n\t}\n}\n\nservice playground {\n\ton call(n: Int) -> Effect[Int] {\n\t\tn\n\t}\n}\n`;
  const sig = entrySignature(two);
  assert.equal(sig.kind, "params");
  // A zero-argument handler in another service is not an entry.
  const other = `context demo.t\n\nservice a {\n\ton call() -> Effect[Int] {\n\t\t1\n\t}\n}\n\nservice b {\n\ton call() -> Effect[Int] {\n\t\t2\n\t}\n}\n`;
  assert.deepEqual(entrySignature(other), { kind: "none", others: ["a", "b"] });
});

test("no service handler at all", () => {
  assert.deepEqual(entrySignature("context demo.t\n\nfn f() -> Int { 1 }\n"), { kind: "none", others: [] });
});

test("the playground service's parameters, with the field each one gets", () => {
  const sig = entrySignature(program("\ton call(name: String, times: Int, ratio: Float, loud: Bool) -> Effect[String] {\n\t\tname\n\t}"));
  assert.equal(sig.kind, "params");
  assert.deepEqual(
    sig.params.map((p) => [p.name, p.type, p.input]),
    [
      ["name", "String", "string"],
      ["times", "Int", "int"],
      ["ratio", "Float", "float"],
      ["loud", "Bool", "bool"],
    ],
  );
});

test("nested generic types stay whole and can't be entered", () => {
  const sig = entrySignature(program("\ton call(m: Map[String, List[Int]], p: Point,) -> Effect[Int] {\n\t\t1\n\t}"));
  assert.deepEqual(
    sig.params.map((p) => [p.name, p.type, p.input]),
    [
      ["m", "Map[String, List[Int]]", null],
      ["p", "Point", null],
    ],
  );
});

test("a refinement is entered as the type it refines, and checked as itself", () => {
  const decls = '\ntype Slug = String where Matches("[a-z]+")\ntype Short = Slug where MaxLength(5)\ntype Small = Int where InRange(1, 10)\n';
  const sig = entrySignature(program("\ton call(s: Short, n: Small) -> Effect[String] {\n\t\ts\n\t}", decls));
  assert.deepEqual(sig.params, [
    { name: "s", type: "Short", input: "string", refines: ["Short", "Slug"] },
    { name: "n", type: "Small", input: "int", refines: ["Small"] },
  ]);
});

test("comments, doc blocks and strings can't fake a handler", () => {
  const src = `context demo.t

---
service fake {
	on call(x: Int) -> Effect[Int] { x }
}
---
service playground {
	// on call(y: Int) -> Effect[Int]
	on call(
		name: String, // who to greet
	) -> Effect[String] {
		"on call(z: Int)"
	}
}
`;
  const sig = entrySignature(src);
  assert.deepEqual(sig.params.map((p) => p.name), ["name"]);
  assert.equal(mask('let s = "a \\" b"').length, 'let s = "a \\" b"'.length, "masking keeps offsets");
});

test("an agent's named handlers aren't entries", () => {
  const src = `context demo.t\n\nagent Counter {\n\tkey id: String\n\ton call add(n: Int) -> Effect[()] {\n\t\tEffect.pure(())\n\t}\n}\n`;
  assert.deepEqual(entrySignature(src), { kind: "none", others: [] });
});

test("a field's text becomes the argument, or says why it can't", () => {
  const p = (input, name = "x", type = "T") => ({ name, type, input, refines: [] });
  assert.deepEqual(readArg(p("string"), "Ada"), { value: "Ada" });
  assert.deepEqual(readArg(p("string"), undefined), { value: "" });
  assert.deepEqual(readArg(p("int"), " 42 "), { value: 42 });
  assert.deepEqual(readArg(p("int"), "-7"), { value: -7 });
  assert.match(readArg(p("int", "n"), "4.5").error, /`n` needs a whole number/);
  assert.match(readArg(p("int", "n"), "").error, /whole number/);
  assert.match(readArg(p("int", "n"), "9007199254740993").error, /too large/);
  assert.deepEqual(readArg(p("float"), "1.5e2"), { value: 150 });
  assert.match(readArg(p("float", "r"), "abc").error, /`r` needs a number/);
  assert.deepEqual(readArg(p("bool"), true), { value: true });
  assert.deepEqual(readArg(p("bool"), undefined), { value: false });
  assert.match(readArg(p(null, "pt", "Point"), "{}").error, /a `Point` can't be entered here yet/);
});

test("link arguments round-trip by name, and junk is dropped", () => {
  const values = { name: "Ada", times: "3", loud: true };
  assert.deepEqual(decodeArgs(encodeArgs(values)), values);
  assert.deepEqual(decodeArgs('{"n": 4, "o": {"x": 1}, "l": [1]}'), { n: "4" });
  assert.deepEqual(decodeArgs("[1, 2]"), {});
  assert.deepEqual(decodeArgs("not json"), {});
  assert.deepEqual(decodeArgs(null), {});
});

test("every example and tour program has a `service playground` entry", async () => {
  const load = async (file) => {
    const { code } = await transform(await readFile(new URL(`../src/${file}`, import.meta.url), "utf8"), { loader: "ts", format: "esm" });
    return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  };
  const { EXAMPLES } = await load("examples.ts");
  const { TOUR } = await load("tour.ts");
  for (const ex of EXAMPLES) assert.equal(entrySignature(ex.source).kind, "zero", ex.id);
  assert.ok(EXAMPLES.every((ex) => /\bservice playground\b/.test(ex.source)));
  for (const step of TOUR) {
    for (const src of [step.starter, step.solution]) assert.notEqual(entrySignature(src).kind, "params", step.id);
  }
});
