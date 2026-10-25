// A run's captured log lines (#28). The sandbox Worker posts each line as it is written;
// this keeps them for the reply, at most MAX_LOGS of them, so a program that logs in a
// loop until its timeout cannot exhaust memory in the sandbox or the app. Pure, so
// test/logs.test.mjs runs it under plain `node --test`.
import type { RunReply } from "./shared";

export const MAX_LOGS = 1000;

export class LogBuffer {
  private readonly lines: RunReply["logs"] = [];
  private dropped = 0;

  /// Keep one line, coerced to the reply's shape (a line comes from the program's Worker).
  push(level: unknown, message: unknown): void {
    if (this.lines.length < MAX_LOGS) {
      this.lines.push({ level: level === "error" ? "error" : "info", message: String(message) });
    } else {
      this.dropped++;
    }
  }

  /// The kept lines, ending with a note of how many were dropped, if any.
  collected(): RunReply["logs"] {
    if (this.dropped === 0) return this.lines;
    const n = this.dropped;
    return [...this.lines, { level: "info", message: `… ${n} more log line${n === 1 ? "" : "s"} not shown` }];
  }
}
