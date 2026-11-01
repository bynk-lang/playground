// The playground examples gallery (in-browser track, slice 5a). Each is a small,
// **runnable** in-process (Bundle) program with a zero-argument `on call()` entry, so
// picking one and pressing Run produces output. Every example here is verified to
// compile and run in the in-process subset (the gallery never offers a snippet that
// would error on Run). The existing `examples/` apps are full Workers/agent programs
// outside that subset, so these are playground-specific teaching snippets.

export interface Example {
  id: string;
  title: string;
  /// The gallery section it's listed under (one of GROUPS).
  group: string;
  /// The tour step that teaches the same idea, if there is one.
  tour?: string;
  /// One line on what the example teaches (shown in the gallery).
  blurb: string;
  source: string;
}

/// The gallery's sections, in reading order: a newcomer starts at the top. EXAMPLES is
/// listed in the same order, so it reads top to bottom too (and its first entry is the
/// opening program).
export const GROUPS = ["Start here", "Data types", "Functions and collections", "Missing values and errors"];

export const EXAMPLES: Example[] = [
  {
    id: "hello",
    title: "Hello, world",
    group: "Start here",
    tour: "run",
    blurb: "The smallest service: log a line and return a value.",
    source: `context hello.world

consumes bynk { Logger }

service greet {
	on call() -> Effect[String] given Logger {
		let _ <- Logger.info("Hello from Bynk!")
		"Hello from Bynk!"
	}
}
`,
  },
  {
    id: "dice",
    title: "Capabilities — Random & Logger",
    group: "Start here",
    tour: "capabilities",
    blurb: "Capabilities a handler must declare before it can use them.",
    source: `context demo.dice

consumes bynk { Random, Logger }

service roll {
	on call() -> Effect[Int] given Random, Logger {
		let _ <- Logger.info("Rolling a d6...")
		let n <- Random.int(1, 7)
		n
	}
}
`,
  },
  {
    id: "plain",
    title: "No capabilities",
    group: "Start here",
    blurb: "A service that asks for nothing: no consumes, no given.",
    source: `context demo.plain

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
  },
  {
    id: "records",
    title: "Records",
    group: "Data types",
    tour: "records",
    blurb: "Group named fields into a record type.",
    source: `context demo.records

consumes bynk { Logger }

type Point = {
	x: Int,
	y: Int,
}

service make {
	on call() -> Effect[Point] given Logger {
		let _ <- Logger.info("Building a point")
		Point {
			x: 3,
			y: 4,
		}
	}
}
`,
  },
  {
    id: "lights",
    title: "Sum types & match",
    group: "Data types",
    tour: "match",
    blurb: "An enum, and a match the compiler checks is complete.",
    source: `context demo.lights

consumes bynk { Logger }

type Light = enum { Red, Green, Yellow }

service next {
	on call() -> Effect[String] given Logger {
		let _ <- Logger.info("The light is green")
		match Green {
			Red => "stop",
			Green => "go",
			Yellow => "slow down",
		}
	}
}
`,
  },
  {
    id: "variants",
    title: "Variants that carry data",
    group: "Data types",
    tour: "match",
    blurb: "A sum type whose cases hold values, matched exhaustively.",
    source: `context demo.shapes

type Shape =
	| Circle(r: Int)
	| Rect(w: Int, h: Int)

fn area(s: Shape) -> Int {
	match s {
		Circle(r) => 3 * r * r,
		Rect(w, h) => w * h,
	}
}

service run {
	on call() -> Effect[Int] {
		area(Rect(3, 4))
	}
}
`,
  },
  {
    id: "slug",
    title: "Refined types",
    group: "Data types",
    tour: "refined",
    blurb: "A String with a rule attached, validated at the boundary.",
    source: `context demo.slug

consumes bynk { Logger }

type Slug = String where Matches("[a-z]+")

service check {
	on call() -> Effect[Bool] given Logger {
		let _ <- Logger.info("Is \\"hello\\" a valid slug?")
		match Slug.of("hello") {
			Ok(_) => true,
			Err(_) => false,
		}
	}
}
`,
  },
  {
    id: "functions",
    title: "Functions and if",
    group: "Functions and collections",
    tour: "functions",
    blurb: "A pure fn, with if as an expression.",
    source: `context demo.functions

fn grade(score: Int) -> String {
	if score >= 90 { "A" } else { if score >= 50 { "pass" } else { "fail" } }
}

service run {
	on call() -> Effect[String] {
		grade(72)
	}
}
`,
  },
  {
    id: "lists",
    title: "Lists and fold",
    group: "Functions and collections",
    blurb: "Collapse a list to one value with a function.",
    source: `context demo.lists

service run {
	on call() -> Effect[Int] {
		let xs = [1, 2, 3, 4]
		xs.fold(0, (acc, x) => acc + x)
	}
}
`,
  },
  {
    id: "strings",
    title: "Strings",
    group: "Functions and collections",
    blurb: "Trim, split, change case and join text with String's methods.",
    source: `context demo.strings

fn initials(name: String) -> String {
	name.split(" ").map((w) => w.slice(0, 1).toUpper()).fold("", (acc, c) => acc.concat(c))
}

service text {
	on call() -> Effect[String] {
		let name = "  ada lovelace  ".trim()
		let shout = name.toUpper()
		shout.concat(" (").concat(initials(name)).concat(")")
	}
}
`,
  },
  {
    id: "maps",
    title: "Maps",
    group: "Functions and collections",
    blurb: "Count words into a Map, then look one up.",
    source: `context demo.maps

consumes bynk { Logger }

fn bump(counts: Map[String, Int], word: String) -> Map[String, Int] {
	match counts.get(word) {
		Some(n) => counts.insert(word, n + 1),
		None => counts.insert(word, 1),
	}
}

fn tally(words: List[String]) -> Map[String, Int] {
	let empty: Map[String, Int] = Map.empty()
	words.fold(empty, bump)
}

service count {
	on call() -> Effect[Int] given Logger {
		let counts = tally(["red", "blue", "red", "green", "red"])
		let _ <- Logger.info("colours seen: ".concat(counts.keys().length().toString()))
		match counts.get("red") {
			Some(n) => n,
			None => 0,
		}
	}
}
`,
  },
  {
    id: "recursion",
    title: "Recursion",
    group: "Functions and collections",
    blurb: "A function that calls itself, and a type whose cases hold more of itself.",
    source: `context demo.recursion

type Expr =
	| Num(n: Int)
	| Add(a: Expr, b: Expr)
	| Mul(a: Expr, b: Expr)

fn eval(e: Expr) -> Int {
	match e {
		Num(n) => n,
		Add(a, b) => eval(a) + eval(b),
		Mul(a, b) => eval(a) * eval(b),
	}
}

fn factorial(n: Int) -> Int {
	if n <= 1 { 1 } else { n * factorial(n - 1) }
}

service calc {
	on call() -> Effect[Int] {
		eval(Add(Num(factorial(3)), Mul(Num(2), Num(10))))
	}
}
`,
  },
  {
    id: "option",
    title: "Option",
    group: "Missing values and errors",
    tour: "option",
    blurb: "No null: a value that may be missing is an Option.",
    source: `context demo.option

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
  },
  {
    id: "result",
    title: "Result",
    group: "Missing values and errors",
    tour: "result",
    blurb: "A function that can fail says so in its type.",
    source: `context demo.result

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
  },
  {
    id: "question",
    title: "The ? operator",
    group: "Missing values and errors",
    tour: "question",
    blurb: "Carry on after Ok, or return the Err on the spot.",
    source: `context demo.question

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
  },
];
