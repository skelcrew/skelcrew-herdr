// The call handler: one JSON question on stdin, one JSON answer on stdout, as Skelcrew asks its
// plugins today. The question's `ask` names the function, and the rest are its arguments. An
// error exits 1 with its message as the last line of stderr, as Skelcrew reads it.
import { z } from "zod";
import * as host from "./host.ts";

const Question = z.discriminatedUnion("ask", [
  host.Start.extend({ ask: z.literal("start") }),
  z.object({ ask: z.literal("list") }),
  host.Read.extend({ ask: z.literal("read") }),
  host.Keys.extend({ ask: z.literal("keys") }),
  host.Interrupt.extend({ ask: z.literal("interrupt") }),
  host.End.extend({ ask: z.literal("end") }),
  host.Attach.extend({ ask: z.literal("attach") }),
  host.Deliver.extend({ ask: z.literal("deliver") }),
  host.Idle.extend({ ask: z.literal("idle") }),
  host.Status.extend({ ask: z.literal("status") }),
]);
export type Question = z.input<typeof Question>;

// Answers one question, as plain data.
export async function answer(question: unknown): Promise<unknown> {
  const q = Question.parse(question);
  switch (q.ask) {
    case "start":
      return host.start(q);
    case "list":
      return host.list();
    case "read":
      return host.read(q);
    case "keys":
      return host.keys(q);
    case "interrupt":
      return host.interrupt(q);
    case "end":
      return host.end(q);
    case "attach":
      return host.attach(q);
    case "deliver":
      return host.deliver(q);
    case "idle":
      return host.idle(q);
    case "status":
      return host.status(q);
  }
}

if (import.meta.main) {
  try {
    const result = await answer(JSON.parse(await Bun.stdin.text()));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const message = error instanceof z.ZodError ? z.prettifyError(error) : String(error);
    process.stderr.write(`${message.replaceAll("\n", "; ")}\n`);
    process.exit(1);
  }
}
