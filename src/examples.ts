// The playground examples gallery (in-browser track, slice 5a). Each is a small,
// **runnable** in-process (Bundle) program with a zero-argument `on call()` entry, so
// picking one and pressing Run produces output. Every example here is verified to
// compile and run in the in-process subset (the gallery never offers a snippet that
// would error on Run). The existing `examples/` apps are full Workers/agent programs
// outside that subset, so these are playground-specific teaching snippets.

export interface Example {
  id: string;
  title: string;
  /// One line on what the example teaches (shown in the gallery).
  blurb: string;
  source: string;
}

export const EXAMPLES: Example[] = [
  {
    id: "hello",
    title: "Hello, world",
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
    id: "records",
    title: "Records",
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
    id: "slug",
    title: "Refined types",
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
    id: "variants",
    title: "Variants that carry data",
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
    id: "option",
    title: "Option",
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
  {
    id: "lists",
    title: "Lists and fold",
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
    id: "plain",
    title: "No capabilities",
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
];
