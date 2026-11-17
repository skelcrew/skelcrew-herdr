// Skelcrew's sessions, transport and status on herdr-core. Each function takes and returns plain
// data, so phase 5's runtime plugin can call it from its call handler unchanged. A session is an
// hc terminal, named by Skelcrew, with labels for its repository, task and role.
import { closeSync, constants, openSync, writeSync } from "node:fs";
import { z } from "zod";
import { HcError, hc, hcBin, hcEnv, lines, rpc } from "./hc.ts";

// A session's name, which is its ID: hc's rule for a terminal's name, unique among live ones.
export const Session = z.string().regex(/^[a-z0-9_-]{1,32}$/, "1-32 of a-z, 0-9, - and _");

// What every session carries, as hc labels: its repository as owner/name, its role, and for a
// builder its task, such as app-12. `by=skelcrew` marks Skelcrew's own among hc's terminals,
// since a label filter matches values, and other programs may use `repo` too.
export const Labels = z.object({
  repo: z.string().min(1),
  role: z.enum(["lead", "builder"]),
  task: z.string().min(1).optional(),
});
export type Labels = z.infer<typeof Labels>;
const mark = { by: "skelcrew" };

// The status words Skelcrew shows, and the OSC 7501 state each becomes. needs you is `blocked`
// and ready is `done`, the words herdr's apps know.
const words = {
  working: "working",
  idle: "idle",
  "needs you": "blocked",
  ready: "done",
  error: "error",
} as const;
export const Word = z.enum(["working", "idle", "needs you", "ready", "error"]);
export type Word = z.infer<typeof Word>;

// Turns hc's state back into Skelcrew's word, or keeps a word Skelcrew never sends, such as one
// a program reported itself. null when nothing was reported.
function wordOf(state: string | undefined): string | null {
  if (!state) return null;
  const found = Object.entries(words).find(([, osc]) => osc === state);
  return found ? found[0] : state;
}

// The part of hc's terminal record this module reads.
const Terminal = z.object({
  name: z.string().nullable().optional(),
  address: z.string(),
  state: z.string(),
  pid: z.number().nullable().optional(),
  labels: z.record(z.string(), z.string()).default({}),
  status: z
    .object({ state: z.string(), kind: z.string().optional(), msg: z.string().optional() })
    .nullable()
    .optional(),
  exit_code: z.number().nullable().optional(),
  reason: z.string().nullable().optional(),
});
type Terminal = z.infer<typeof Terminal>;

async function get(session: string): Promise<Terminal> {
  return Terminal.parse(await hc(["get", session]));
}

// Starts `argv` in `folder` with exactly `env`, in a new hc terminal named `session`, labelled.
// hc hands every terminal the core's own environment, so a token the core has would reach the
// agent: `env -i` starts from nothing, as Skelcrew does on tmux. TERM, COLORTERM and
// TERM_PROGRAM are the terminal's own, which must win: they say what hc draws with. No parent,
// even when this runs inside an hc terminal, so the agent never ends with the caller.
export const Start = z.object({
  session: Session,
  argv: z
    .array(z.string())
    .min(1)
    .refine(([program]) => !program?.includes("=") && !program?.startsWith("-"), {
      message: "the program's name can't hold = or start with -, as env would misread it",
    }),
  folder: z.string().min(1),
  env: z.record(z.string().regex(/^[^=\0]+$/), z.string()),
  labels: Labels,
});
export async function start(q: z.infer<typeof Start>) {
  const own = new Set(["TERM", "COLORTERM", "TERM_PROGRAM"]);
  const env = Object.entries(q.env).flatMap(([k, v]) => (own.has(k) ? [] : [`${k}=${v}`]));
  const keep = [...own].map((k) => `\${${k}+"${k}=$${k}"}`).join(" ");
  const clean = ["/bin/sh", "-c", `exec /usr/bin/env -i ${keep} "$@"`, "sh", ...env];
  const labels = Object.entries({ ...q.labels, ...mark }).flatMap(([k, v]) => [
    "--label",
    `${k}=${v}`,
  ]);
  const run = ["run", "--bg", "--no-parent", "--name", q.session, "--cwd", q.folder, ...labels];
  const t = Terminal.parse(await hc([...run, "--", ...clean, ...q.argv]));
  return { session: q.session, address: t.address };
}

// Lists Skelcrew's sessions on this core, finished ones too, with their labels, whether the
// agent runs, its status and how it ended, so a starting engine finds its agents again.
export async function list() {
  const answer = z
    .object({ terminals: z.array(Terminal) })
    .parse(await rpc("terminal.list", { all: true, labels: mark }));
  return {
    sessions: answer.terminals.flatMap((t) => {
      if (!t.name) return [];
      const labels = Labels.safeParse(t.labels);
      return [
        {
          session: t.name,
          running: t.state === "live",
          labels: labels.success ? labels.data : null,
          status: wordOf(t.status?.state),
          ...(t.state === "live" ? {} : { ended: { reason: t.reason, exit_code: t.exit_code } }),
        },
      ];
    }),
  };
}

// Returns what the session shows: its screen, and `lines` lines of history above it.
export const Read = z.object({ session: Session, lines: z.number().int().min(0).default(0) });
export async function read(q: z.infer<typeof Read>) {
  const answer = z
    .object({ text: z.string() })
    .parse(await hc(["read", q.session, "--lines", String(q.lines)]));
  return { text: answer.text };
}

// Presses keys in the session, by hc's names: enter, esc, up, ctrl+c.
export const Keys = z.object({ session: Session, keys: z.array(z.string().min(1)).min(1) });
export async function keys(q: z.infer<typeof Keys>) {
  await hc(["keys", q.session, ...q.keys]);
  return {};
}

// Stops the agent's turn. hc presses Esc for a program that ever reported a status, which every
// Skelcrew session has once `status` ran, and ctrl+c otherwise. Then it watches `timeout`
// seconds for the status to leave working and says what it saw: `stopped`, `still_working`,
// `exited`, or `unknown`. Only `status` changes the status, so after Esc on Claude Code, which
// has no hook for it, this says still_working until Skelcrew's screen check reports idle.
export const Interrupt = z.object({ session: Session, timeout: z.number().min(0).default(1) });
export async function interrupt(q: z.infer<typeof Interrupt>) {
  const answer = z
    .object({ key: z.string(), outcome: z.string() })
    .parse(await hc(["interrupt", q.session, "--timeout", String(q.timeout)]));
  return answer;
}

// Ends the session: its program, then its record. Ending one already gone is no error.
export const End = z.object({ session: Session });
export async function end(q: z.infer<typeof End>) {
  try {
    if ((await get(q.session)).state === "live") await hc(["kill", q.session]);
    await hc(["rm", q.session]);
  } catch (error) {
    if (!(error instanceof HcError && error.kind === "not_found")) throw error;
  }
  return {};
}

// The command that attaches your terminal to the session, for Skelcrew to run in your terminal.
// Ctrl+\ detaches, hc's key, not Skelcrew's Alt-Q.
export const Attach = z.object({ session: Session });
export function attach(q: z.infer<typeof Attach>) {
  return { argv: [hcBin(), "attach", q.session] };
}

// Waits until the agent isn't working, for at most `timeout` seconds, by following hc's events.
// Says whether it got there, and its status: idle, ready, needs you or error all leave a
// message free to go, as Skelcrew's messages module already decided it may. `ended` when the
// session ended or went.
export const Idle = z.object({ session: Session, timeout: z.number().min(0).default(50) });
export async function idle(q: z.infer<typeof Idle>) {
  const child = Bun.spawn([hcBin(), "events", "--terminal", q.session, "--json"], {
    env: hcEnv(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  // hc's own state word, until it is answered as Skelcrew's.
  let status: string | undefined;
  let seen = false;
  const timer = setTimeout(() => child.kill(), q.timeout * 1000);
  try {
    for await (const line of lines(child.stdout)) {
      const message = JSON.parse(line);
      // The first line is the snapshot, then one notification per change.
      if (message.terminals) {
        seen = true;
        const record = message.terminals[0];
        if (record?.state !== "live") return { idle: false, status: null, ended: true };
        status = record.status?.state;
      }
      const event = message.params;
      if (event?.type === "status") status = event.data.status?.state;
      if (event?.type === "finished" || event?.type === "removed")
        return { idle: false, status: wordOf(status), ended: true };
      if (status && status !== "working") return { idle: true, status: wordOf(status) };
    }
    // No snapshot at all: hc found no such terminal.
    if (!seen) return { idle: false, status: null, ended: true };
    return { idle: false, status: wordOf(status) };
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}

// Types `text` and Enter into the agent once it isn't working, never into a running turn and
// never onto a person's unsent draft, waiting at most `timeout` seconds. An idle agent gets it
// through a send `if` idle, which types only if the status is still idle when the text goes in,
// and holds it while a person has a draft. An agent that is ready or hit an error gets a plain
// send, which holds for a draft the same way: `if` knows only idle and working. One that needs
// you gets it only when no dialog is open, as typing would answer it. A send still held at the
// deadline is cancelled, which hc honours only before typing, so the answer is certain: whether
// it went in and, when not, why. After typing, hc watches up to 5 seconds for the agent to start
// working, so the answer can come that much after the deadline.
export const Deliver = z.object({
  session: Session,
  text: z.string().min(1),
  timeout: z.number().min(0).default(50),
});
export async function deliver(q: z.infer<typeof Deliver>) {
  const deadline = Date.now() + q.timeout * 1000;
  const left = () => Math.max(0, deadline - Date.now());
  while (true) {
    const t = await get(q.session);
    if (t.state !== "live") return { delivered: false, why: "it has ended" };
    const state = t.status?.state;
    if (state === "blocked" && t.status?.kind)
      return { delivered: false, why: `it shows a ${t.status.kind}, which typing would answer` };
    if (state && state !== "working") {
      const guard = state === "idle" ? { if: "idle" } : { force: state === "blocked" };
      try {
        const send = { terminal: q.session, text: q.text, ...guard };
        await rpc("terminal.send", send, left());
        return { delivered: true };
      } catch (error) {
        if (!(error instanceof HcError)) throw error;
        // It started working between the look and the send: wait again.
        if (error.kind === "status_mismatch") continue;
        if (error.kind === "cancelled")
          return { delivered: false, why: "a person's unsent draft held it" };
        throw error;
      }
    }
    if (left() === 0) return { delivered: false, why: `it was ${wordOf(state) ?? "silent"}` };
    const waited = await idle({ session: q.session, timeout: left() / 1000 });
    if (waited.ended) return { delivered: false, why: "it has ended" };
    if (!waited.idle) return { delivered: false, why: `it was ${waited.status ?? "silent"}` };
  }
}

// Shows a status on herdr: Skelcrew's word for the session, with a short reason, such as
// `question` or `round limit`. herdr-core reads status only from OSC 7501 in a terminal's
// output, which is what its program writes to its terminal. So this writes the report to the
// session's terminal device itself, the one its program has: to hc it is the program speaking.
// One write, which the terminal driver keeps whole, between two of the program's own writes.
// Returns the status hc then shows.
export const Status = z.object({
  session: Session,
  status: Word,
  reason: z.string().default(""),
});
export async function status(q: z.infer<typeof Status>) {
  const t = await get(q.session);
  if (t.state !== "live" || !t.pid) throw new Error(`${q.session} isn't running`);
  const tty = ttyOf(t.pid);
  const fd = openSync(tty, constants.O_WRONLY | constants.O_NOCTTY);
  try {
    writeSync(fd, osc7501(q.status, q.reason));
  } finally {
    closeSync(fd);
  }
  // hc reads the report as the terminal's output arrives, a moment after the write.
  const deadline = Date.now() + 2000;
  let shown = t.status?.state;
  while (shown !== words[q.status] && Date.now() < deadline) {
    await Bun.sleep(20);
    shown = (await get(q.session)).status?.state;
  }
  return { status: wordOf(shown) };
}

// The OSC 7501 report for a status word: its state, the kind of block when the reason names
// one, and the reason as its message, in base64 as the protocol carries text.
export function osc7501(word: Word, reason: string): string {
  const fields = [`state=${words[word]}`];
  if (word === "needs you" && (reason === "question" || reason === "permission"))
    fields.push(`kind=${reason}`);
  if (reason) fields.push(`msg=${Buffer.from(reason).toString("base64")}`);
  return `\x1b]7501;${fields.join(":")}\x1b\\`;
}

// The terminal device a process has, such as /dev/pts/3 or /dev/ttys003, by asking ps, which
// works the same on Linux and a Mac.
function ttyOf(pid: number): string {
  const ps = Bun.spawnSync(["ps", "-o", "tty=", "-p", String(pid)], { stdout: "pipe" });
  const name = ps.stdout.toString().trim();
  if (!ps.success || !name || name === "?" || name === "??")
    throw new Error(`process ${pid} has no terminal`);
  return `/dev/${name}`;
}
