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

const prelude = (ctx: string) => `context ${ctx}\n\nconsumes bynk { Logger }\n`;

export const TOUR: TourStep[] = [
  {
    id: "run",
    title: "Run a service",
    prose:
      "A Bynk program is a `context` holding `service`s. This one logs a line and returns a `String`. The result appears on the right as `⇒`.",
    task: "Change the returned string so it greets you instead of the world, then press Check.",
    starter: `${prelude("tour.run")}
service greet {
  on call() -> Effect[String] given Logger {
    let _ <- Logger.info("Greeting someone")
    "Hello, world"
  }
}
`,
    solution: `${prelude("tour.run")}
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
    starter: `${prelude("tour.dice")}
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
    starter: `${prelude("tour.records")}
type Point = { x: Int, y: Int }

service make {
  on call() -> Effect[Point] given Logger {
    Point { x: 3, y: 4 }
  }
}
`,
    solution: `${prelude("tour.records")}
type Point = { x: Int, y: Int }

service make {
  on call() -> Effect[Point] given Logger {
    Point { x: 10, y: 20 }
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
    starter: `${prelude("tour.lights")}
type Light = enum { Red, Green, Yellow }

service next {
  on call() -> Effect[String] given Logger {
    match Yellow {
      Red => "stop",
      Green => "go",
    }
  }
}
`,
    solution: `${prelude("tour.lights")}
type Light = enum { Red, Green, Yellow }

service next {
  on call() -> Effect[String] given Logger {
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
    starter: `${prelude("tour.slug")}
type Slug = String where Matches("[a-z]+")

service check {
  on call() -> Effect[Bool] given Logger {
    match Slug.of("Hello World") {
      Ok(_) => true,
      Err(_) => false,
    }
  }
}
`,
    solution: `${prelude("tour.slug")}
type Slug = String where Matches("[a-z]+")

service check {
  on call() -> Effect[Bool] given Logger {
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
];
