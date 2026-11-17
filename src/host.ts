// Skelcrew's sessions, transport and status on herdr-core. Each function takes and returns plain
// data, so phase 5's runtime plugin can call it from its call handler unchanged. A session is an
// hc terminal, named by Skelcrew, with labels for its repository, task and role.
import { closeSync, constants, mkdirSync, openSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { HcError, hcBin, hcEnv, lines, rpc } from "./hc.ts";

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
  return Terminal.parse(await rpc("terminal.get", { terminal: session }));
}

// The session's record while its program runs, or undefined once it ended or went.
async function live(session: string): Promise<Terminal | undefined> {
  try {
    const t = await get(session);
    return t.state === "live" ? t : undefined;
  } catch (error) {
    if (error instanceof HcError && error.kind === "not_found") return undefined;
    throw error;
  }
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
  const run = {
    argv: [...clean, ...q.argv],
    cwd: q.folder,
    name: q.session,
    labels: { ...q.labels, ...mark },
    no_parent: true,
  };
  const t = Terminal.parse(await rpc("terminal.run", run));
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
    .parse(await rpc("terminal.read", { terminal: q.session, lines: q.lines }));
  return { text: answer.text };
}

// Presses keys in the session, by hc's names: enter, esc, up, ctrl+c.
export const Keys = z.object({ session: Session, keys: z.array(z.string().min(1)).min(1) });
export async function keys(q: z.infer<typeof Keys>) {
  await rpc("terminal.keys", { terminal: q.session, keys: q.keys });
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
    .parse(await rpc("terminal.interrupt", { terminal: q.session, timeout: q.timeout }));
  return answer;
}

// Ends the session: its program, then its record. Ending one already gone is no error.
export const End = z.object({ session: Session });
export async function end(q: z.infer<typeof End>) {
  try {
    if ((await get(q.session)).state === "live")
      await rpc("terminal.kill", { terminal: q.session });
    await rpc("terminal.rm", { terminal: q.session });
  } catch (error) {
    if (!(error instanceof HcError && error.kind === "not_found")) throw error;
  }
  return {};
}

// The command that attaches your terminal to the session, for Skelcrew to run in your terminal
// as it is: it sets what reaches Skelcrew's core and unsets what would lead elsewhere, whatever
// your environment holds. Ctrl+\ detaches, hc's key, not Skelcrew's Alt-Q.
export const Attach = z.object({ session: Session });
export async function attach(q: z.infer<typeof Attach>) {
  // Checks the core is Skelcrew's, as every call does.
  await rpc("server.status", {});
  const { HC_SESSION, XDG_CONFIG_HOME } = hcEnv();
  const unset = ["HC_SOCKET", "HC_TERMINAL_ID", "HC_SCOPE"].flatMap((k) => ["-u", k]);
  const set = [`HC_SESSION=${HC_SESSION}`, `XDG_CONFIG_HOME=${XDG_CONFIG_HOME}`];
  return { argv: ["/usr/bin/env", ...unset, ...set, hcBin(), "attach", q.session] };
}

// Waits until the agent isn't working, for at most `timeout` seconds, by following hc's events.
// Says whether it got there, and its status: idle, ready, needs you or error all leave a
// message free to go, as Skelcrew's messages module already decided it may. `ended` when the
// session ended or went.
export const Idle = z.object({ session: Session, timeout: z.number().min(0).default(50) });
export async function idle(q: z.infer<typeof Idle>) {
  // Checks the core is Skelcrew's, as every call does, before following its events.
  await rpc("server.status", {});
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

// What a harness's screen shows: `busy` while a turn runs, and a line starting with `prompt`
// where a message goes, bare when nothing is typed there. The same marks Skelcrew's built-in
// transport reads.
export const Marks = z.object({ busy: z.string().min(1), prompt: z.string().min(1) });
export type Marks = z.infer<typeof Marks>;

// Returns why the screen shows the agent not ready for a message, or empty text when its prompt
// is empty. The prompt's mark is its first word, such as `❯` for Claude Code or `›` for Codex,
// and the rest is the placeholder an empty prompt shows, such as Codex's `Ask Codex to do
// anything`, which typing replaces. So the last line starting with the mark is where a message
// goes: the mark alone or with its placeholder is empty, and anything else after it is a
// person's unsent draft. A numbered menu, such as a permission question, also puts the mark
// before text, and isn't ready either. hc's read drops trailing spaces.
export function notReady(shown: string, marks: Marks): string {
  if (shown.includes(marks.busy)) return `it shows ${marks.busy}`;
  const empty = marks.prompt.trim();
  const mark = empty.split(/\s+/)[0] ?? empty;
  const input = shown
    .split("\n")
    .map((line) => line.trim())
    .findLast((line) => line === mark || line.startsWith(`${mark} `));
  if (input === undefined) return `it shows no ${mark} prompt`;
  if (input === mark || input === empty) return "";
  if (/^\S+ \d+\. /.test(input)) return "it shows a menu";
  return draftReason;
}
const draftReason = "a person's unsent draft is at its prompt";

// Types `text` and Enter into the agent once it isn't working, never into a running turn and
// never onto a person's unsent draft, waiting at most `timeout` seconds. Answers whether it
// went in and, when not, why: then nothing was typed.
//
// Never into a running turn: hc types only through a send `if` idle, which hc checks at the
// moment it types, whatever happened while the send was held. `if` knows only idle and working,
// so an agent that is ready, needs you with no dialog open, or hit an error is first reported
// idle, with the message `delivering`, and its status is put back afterwards unless Skelcrew
// reported another meanwhile. A report of working while the send is held then stops it.
//
// Never onto a draft: hc holds a send while a person has a draft, the screen shows it or not,
// and on Skelcrew's core that hold has no end (see hc.ts). A send goes only once the screen
// shows an empty prompt, by the harness's `marks`, which also catches a draft hc never saw, such
// as one typed before the core restarted. A send still held at the deadline is cancelled, which
// hc honours only before typing, so the answer is certain. After typing, hc watches up to 5
// seconds for the agent to start working, so the answer can come that much after the deadline.
export const Deliver = z.object({
  session: Session,
  text: z.string().min(1),
  marks: Marks,
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
    if (!state || state === "working") {
      if (left() === 0) return { delivered: false, why: `it was ${wordOf(state) ?? "silent"}` };
      const waited = await idle({ session: q.session, timeout: left() / 1000 });
      if (waited.ended) return { delivered: false, why: "it has ended" };
      if (!waited.idle) return { delivered: false, why: `it was ${waited.status ?? "silent"}` };
      continue;
    }
    const why = notReady((await read({ session: q.session, lines: 0 })).text, q.marks);
    if (why) {
      if (left() === 0) return { delivered: false, why };
      await Bun.sleep(Math.min(250, left()));
      continue;
    }
    const shown = t.status ?? { state };
    if (state !== "idle" && !(await report(q.session, shown, delivering))) continue;
    let delivered = false;
    try {
      const send = { terminal: q.session, text: q.text, if: "idle" };
      await rpc("terminal.send", send, left());
      delivered = true;
      return { delivered };
    } catch (error) {
      if (!(error instanceof HcError)) throw error;
      // The status changed before typing: look again.
      if (error.kind === "status_mismatch") continue;
      // Held by a person's typing until the deadline.
      if (error.kind === "cancelled")
        return { delivered: false, why: "a person's typing at its prompt held it" };
      throw error;
    } finally {
      // Putting the status back never hides that the text went in, as the caller would send it
      // again. An agent that ended after taking it, which leaves nothing to put back, is fine.
      if (state !== "idle")
        try {
          await report(q.session, delivering, shown);
        } catch (error) {
          if (!delivered) throw error;
        }
    }
  }
}

// The status a delivery reports while it sends to an agent that isn't idle.
const delivering = { state: "idle", msg: "delivering" };

// One status as hc keeps it: its state, the kind of block, and its message.
type Shown = { state: string; kind?: string | undefined; msg?: string | undefined };
const same = (a: Shown | null | undefined, b: Shown) =>
  a?.state === b.state && (a.kind ?? "") === (b.kind ?? "") && (a.msg ?? "") === (b.msg ?? "");

// Shows a status on herdr: Skelcrew's word for the session, with a short reason, such as
// `question` or `round limit`. Returns the status hc then shows.
export const Status = z.object({
  session: Session,
  status: Word,
  reason: z.string().default(""),
});
export async function status(q: z.infer<typeof Status>) {
  const wanted = shownFor(q.status, q.reason);
  await report(q.session, null, wanted);
  return { status: wordOf(wanted.state) };
}

// The status Skelcrew's word and reason become: the state herdr knows, the kind of block when
// the reason names one, and the reason as the message.
function shownFor(word: Word, reason: string): Shown {
  const kind = word === "needs you" && (reason === "question" || reason === "permission");
  return {
    state: words[word],
    ...(kind ? { kind: reason } : {}),
    ...(reason ? { msg: reason } : {}),
  };
}

// Reports `next` to hc, if it still shows `expected` (any status when null), and returns
// whether it did. With `expected`, a session that ended or went has nothing to report on, and
// that is false too; without it, an error. Reports for one session take turns: each waits until hc shows the one before,
// so a delivery putting a status back can't undo a newer one from Skelcrew.
//
// herdr-core reads status only from OSC 7501 in a terminal's output, which is what its program
// writes to its terminal. So the report is written to the session's terminal device itself, the
// one its program has: to hc it is the program speaking. One write, which the terminal driver
// keeps whole, between two of the program's own writes.
async function report(session: string, expected: Shown | null, next: Shown): Promise<boolean> {
  return await locked(session, async () => {
    const t = await live(session);
    if (!t?.pid) {
      if (expected) return false;
      throw new Error(`${session} isn't running`);
    }
    if (expected && !same(t.status, expected)) return false;
    const fd = openSync(ttyOf(t.pid), constants.O_WRONLY | constants.O_NOCTTY);
    try {
      writeSync(fd, osc7501(next));
    } finally {
      closeSync(fd);
    }
    // hc reads the report as the terminal's output arrives, a moment after the write.
    const deadline = Date.now() + 2000;
    while (true) {
      const now = await live(session);
      if (!now && expected) return false;
      if (same(now?.status, next)) break;
      if (Date.now() > deadline) throw new Error(`hc didn't show ${next.state} for ${session}`);
      await Bun.sleep(20);
    }
    return true;
  });
}

// The OSC 7501 report for a status, with its message in base64 as the protocol carries text.
export function osc7501(shown: Shown): string {
  const fields = [`state=${shown.state}`];
  if (shown.kind) fields.push(`kind=${shown.kind}`);
  if (shown.msg) fields.push(`msg=${Buffer.from(shown.msg).toString("base64")}`);
  return `\x1b]7501;${fields.join(":")}\x1b\\`;
}
export const oscFor = (word: Word, reason: string) => osc7501(shownFor(word, reason));

// Runs `fn` holding the session's lock, a folder only one process can make. Every holder is
// done in moments, so a lock older than 10 seconds was left by a process that died, and goes.
async function locked<T>(session: string, fn: () => Promise<T>): Promise<T> {
  const folder = join(tmpdir(), `skelcrew-herdr-${process.getuid?.() ?? "user"}`);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const lock = join(folder, `${process.env.HC_SESSION || "default"}-${session}.lock`);
  while (true) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = Date.now() - (statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
      if (age > 10_000) rmSync(lock, { recursive: true, force: true });
      else await Bun.sleep(10);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
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
