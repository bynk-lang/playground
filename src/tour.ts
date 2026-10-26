// The guided tour: a short sequence of tiny programs, each with something for the
// learner to change. `check` reads the outcome of running the learner's code and
// returns null when the step is done, else a one-line hint. The compiler stays the
// teacher: a step that doesn't compile shows the compiler's own diagnostics, and
// `hint` only says where to look. Every step's `starter` must fail its check and its
// `solution` must pass it — `test/tour.test.mjs` runs both through the staged compiler.

export interface TourOutcome {
  /// The program compiled (a failed compile has no run to read).
  compiled: boolean;
  /// The entry's returned value, stringified, when it completed.
  value?: string;
  /// A thrown error from the program.
  error?: string;
  /// A later run started before this one finished, so it has no outcome to check.
  superseded?: boolean;
}

export interface TourStep {
  id: string;
  title: string;
  /// Short prose, plain text with `backticks` for code terms.
  prose: string;
  /// What to do, one sentence.
  task: string;
  starter: string;
  /// A working answer, shown on request.
  solution: string;
  /// Shown when the program does not compile.
  hint: string;
  check: (o: TourOutcome) => string | null;
}

/// Where the tour should open: the first step not yet done, or the first step once
/// every step is (so a finished learner can go round again).
export function nextIncomplete(ids: string[], done: string[]): number {
  const i = ids.findIndex((id) => !done.includes(id));
  return i === -1 ? 0 : i;
}

export const TOUR: TourStep[] = [
  {
    id: "run",
    title: "Run a service",
    prose:
      "A Bynk program is a `context` holding `service`s. This one logs a line and returns a `String`. The result appears on the right as `⇒`.",
    task: "Change the returned string so it greets you instead of the world, then press Check.",
    starter: `context tour.run

consumes bynk { Logger }

service greet {
	on call() -> Effect[String] given Logger {
		let _ <- Logger.info("Greeting someone")
		"Hello, world"
	}
}
`,
    solution: `context tour.run

consumes bynk { Logger }

service greet {
	on call() -> Effect[String] given Logger {
		let _ <- Logger.info("Greeting someone")
		"Hello, Ada"
	}
}
`,
    hint: "Keep the quotes around the string.",
    check: (o) =>
      !o.compiled
        ? "Fix the compile error first."
        : o.value && !/world/i.test(o.value)
          ? null
          : "The result still says world.",
  },
  {
    id: "capabilities",
    title: "Capabilities",
    prose:
      "A service can only do what it declares. `consumes bynk { … }` names the capabilities a context may use, and `given` lists the ones a handler needs. Randomness is a capability too.",
    task: "The program uses `Random` without declaring it. Declare it in both places.",
    starter: `context tour.dice

consumes bynk { Logger }

service roll {
	on call() -> Effect[Int] given Logger {
		let _ <- Logger.info("Rolling a d6...")
		let n <- Random.int(1, 7)
		n
	}
}
`,
    solution: `context tour.dice

consumes bynk { Random, Logger }

service roll {
	on call() -> Effect[Int] given Random, Logger {
		let _ <- Logger.info("Rolling a d6...")
		let n <- Random.int(1, 7)
		n
	}
}
`,
    hint: "The error names the unknown capability: add it to `consumes` and to `given`.",
    check: (o) => {
      if (!o.compiled) return "Still not compiling.";
      const n = Number(o.value);
      return Number.isInteger(n) && n >= 1 && n <= 6 ? null : "Expected a number from 1 to 6.";
    },
  },
  {
    id: "records",
    title: "Records",
    prose: "A record type groups named fields. You build one by naming its type and giving each field a value.",
    task: "Make the point `x: 10` and `y: 20`.",
    starter: `context tour.records

type Point = {
	x: Int,
	y: Int,
}

service make {
	on call() -> Effect[Point] {
		Point {
			x: 3,
			y: 4,
		}
	}
}
`,
    solution: `context tour.records

type Point = {
	x: Int,
	y: Int,
}

service make {
	on call() -> Effect[Point] {
		Point {
			x: 10,
			y: 20,
		}
	}
}
`,
    hint: "Both fields are required.",
    check: (o) => {
      if (!o.compiled) return "Still not compiling.";
      try {
        const p = JSON.parse(o.value ?? "null") as { x?: number; y?: number };
        return p.x === 10 && p.y === 20 ? null : "Expected x: 10 and y: 20.";
      } catch {
        return "Expected a point back.";
      }
    },
  },
  {
    id: "match",
    title: "Sum types and match",
    prose:
      "An `enum` lists every shape a value can take, and `match` must cover them all. The compiler refuses a match that misses a case, so there is no forgotten branch to find at runtime.",
    task: "Cover the missing `Yellow` case so it returns `\"slow down\"`.",
    starter: `context tour.lights

type Light = enum { Red, Green, Yellow }

service next {
	on call() -> Effect[String] {
		match Yellow {
			Red => "stop",
			Green => "go",
		}
	}
}
`,
    solution: `context tour.lights

type Light = enum { Red, Green, Yellow }

service next {
	on call() -> Effect[String] {
		match Yellow {
			Red => "stop",
			Green => "go",
			Yellow => "slow down",
		}
	}
}
`,
    hint: "The error says which variant is not covered. Add an arm for it.",
    check: (o) => (!o.compiled ? "Still not compiling." : o.value === "slow down" ? null : 'Expected "slow down".'),
  },
  {
    id: "refined",
    title: "Refined types",
    prose:
      "A refined type is a base type plus a rule. `Slug.of(…)` checks the rule and returns `Ok` or `Err`, so an invalid value can never be treated as a `Slug`.",
    task: "`Slug` only allows lowercase letters. Change the input so the check passes and the result is `true`.",
    starter: `context tour.slug

type Slug = String where Matches("[a-z]+")

service check {
	on call() -> Effect[Bool] {
		match Slug.of("Hello World") {
			Ok(_) => true,
			Err(_) => false,
		}
	}
}
`,
    solution: `context tour.slug

type Slug = String where Matches("[a-z]+")

service check {
	on call() -> Effect[Bool] {
		match Slug.of("hello") {
			Ok(_) => true,
			Err(_) => false,
		}
	}
}
`,
    hint: "Only the input string needs to change.",
    check: (o) => (!o.compiled ? "Still not compiling." : o.value === "true" ? null : "The slug was rejected: it is not all lowercase letters."),
  },
  {
    id: "functions",
    title: "Functions",
    prose:
      "A `fn` is a pure function: the same input always gives the same output. It sits in the `context` beside the services and returns its last expression. `if` is an expression too.",
    task: "`grade` always returns `\"fail\"`. Make `grade(72)` return `\"pass\"` with an `if` on the score.",
    starter: `context tour.functions

fn grade(score: Int) -> String {
	"fail"
}

service run {
	on call() -> Effect[String] {
		grade(72)
	}
}
`,
    solution: `context tour.functions

fn grade(score: Int) -> String {
	if score >= 90 { "A" } else { if score >= 50 { "pass" } else { "fail" } }
}

service run {
	on call() -> Effect[String] {
		grade(72)
	}
}
`,
    hint: "`if cond { a } else { b }` needs both branches.",
    check: (o) => (!o.compiled ? "Still not compiling." : o.value === "pass" ? null : 'Expected "pass" for a score of 72.'),
  },
  {
    id: "option",
    title: "Option: a value that may be missing",
    prose:
      "There is no `null`. A value that might be absent has the type `Option[T]`, either `Some(value)` or `None`, and `match` makes you handle both. `first()` returns the first element of a list, if there is one.",
    task: "Cover the missing `None` case, returning `\"empty\"`.",
    starter: `context tour.option

service run {
	on call() -> Effect[String] {
		let xs = [3, 8, 12]
		match xs.first() {
			Some(n) => "first is \\(n)",
		}
	}
}
`,
    solution: `context tour.option

service run {
	on call() -> Effect[String] {
		let xs = [3, 8, 12]
		match xs.first() {
			Some(n) => "first is \\(n)",
			None => "empty",
		}
	}
}
`,
    hint: "The error names the case that is not covered.",
    check: (o) => (!o.compiled ? "Still not compiling." : o.value === "first is 3" ? null : 'Expected "first is 3".'),
  },
  {
    id: "result",
    title: "Result: failure in the type",
    prose:
      "A function that can fail says so in its return type: `Result[T, E]` is `Ok(value)` or `Err(error)`. The caller cannot reach the value without deciding what to do about the error. Here `parseAge(\"-5\")` fails.",
    task: "Handle the `Err` case so the program returns `\"problem: negative\"`.",
    starter: `context tour.result

fn parseAge(s: String) -> Result[Int, String] {
	match Int.parse(s) {
		None => Err("not a number"),
		Some(n) => if n < 0 { Err("negative") } else { Ok(n) },
	}
}

service run {
	on call() -> Effect[String] {
		match parseAge("-5") {
			Ok(n) => "age \\(n)",
		}
	}
}
`,
    solution: `context tour.result

fn parseAge(s: String) -> Result[Int, String] {
	match Int.parse(s) {
		None => Err("not a number"),
		Some(n) => if n < 0 { Err("negative") } else { Ok(n) },
	}
}

service run {
	on call() -> Effect[String] {
		match parseAge("-5") {
			Ok(n) => "age \\(n)",
			Err(e) => "problem: \\(e)",
		}
	}
}
`,
    hint: "`\\(e)` puts the error text inside a string.",
    check: (o) => (!o.compiled ? "Still not compiling." : o.value === "problem: negative" ? null : 'Expected "problem: negative".'),
  },
  {
    id: "question",
    title: "The ? operator",
    prose:
      "Inside a function that returns a `Result`, `?` after an expression unwraps an `Ok` and carries on, or returns the `Err` from the function on the spot. It saves a nested `match` for every step that can fail.",
    task: "`n` is a `Result`, not a number, so `n + 1` does not type-check. Add `?` after `parseAge(s)`.",
    starter: `context tour.question

fn parseAge(s: String) -> Result[Int, String] {
	match Int.parse(s) {
		None => Err("not a number"),
		Some(n) => Ok(n),
	}
}

fn nextAge(s: String) -> Result[Int, String] {
	let n = parseAge(s)
	Ok(n + 1)
}

service run {
	on call() -> Effect[Int] {
		match nextAge("41") {
			Ok(n) => n,
			Err(_) => 0,
		}
	}
}
`,
    solution: `context tour.question

fn parseAge(s: String) -> Result[Int, String] {
	match Int.parse(s) {
		None => Err("not a number"),
		Some(n) => Ok(n),
	}
}

fn nextAge(s: String) -> Result[Int, String] {
	let n = parseAge(s)?
	Ok(n + 1)
}

service run {
	on call() -> Effect[Int] {
		match nextAge("41") {
			Ok(n) => n,
			Err(_) => 0,
		}
	}
}
`,
    hint: "The `?` goes straight after the call, with no space.",
    check: (o) => (!o.compiled ? "Still not compiling." : o.value === "42" ? null : "Expected 42."),
  },
];
