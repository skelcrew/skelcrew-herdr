// Skelcrew's sessions, transport and status on herdr-core. Each function takes and returns plain
// data, in the shapes Skelcrew's session command speaks, so the call handler passes them on
// unchanged. A session is an hc terminal, with labels for its repository, task and role.
import { dlopen, FFIType } from "bun:ffi";
import { closeSync, constants, existsSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { coreSocket, HcError, hcBin, hcEnv, lines, rpc } from "./hc.ts";

// A session's ID: its hc address, such as t7, which hc never gives another terminal, even after
// this one is removed or the core restarts. A name could be taken over by a later terminal once
// this one finished, and Skelcrew's own names, such as a repository with a dot in it, can break
// hc's rule for names. It is checked against that rule all the same, as it goes into a file name.
export const Id = z.string().regex(/^[a-z0-9_-]{1,32}$/, "1-32 of a-z, 0-9, - and _");

// What every session carries, as Skelcrew gives them: its repository as owner/name, its role,
// and for a builder its task, such as app-12.
export const Labels = z.object({
  repository: z.string().min(1),
  role: z.enum(["lead", "builder"]),
  task: z.string().min(1).optional(),
});
export type Labels = z.infer<typeof Labels>;

// The same labels as hc keeps them, under the short names herdr's apps show: `repo`, `role` and
// `task`. `by=skelcrew` marks Skelcrew's own among hc's terminals, since a label filter matches
// values, and other programs may use `repo` too.
const HcLabels = z.object({
  repo: z.string().min(1),
  role: z.enum(["lead", "builder"]),
  task: z.string().min(1).optional(),
});
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

// Starts `command` in `folder` with exactly `env`, in a new hc terminal labelled with `labels`,
// and returns its ID. hc hands every terminal the core's own environment, so a token the core
// has would reach the agent: `env -i` starts from nothing and sets exactly what was given,
// terminal variables such as TERM included: hc's own (xterm-256color, truecolor, ghostty) only
// when Skelcrew passes them. No parent, even when this runs inside an hc terminal, so the agent
// never ends with the caller. Skelcrew's `name` for the session goes in a label, for a person
// looking in herdr's apps.
export const Start = z.object({
  name: z.string().min(1),
  command: z
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
  const env = Object.entries(q.env).map(([k, v]) => `${k}=${v}`);
  // `--` ends env's options, so a name starting with - is set, not read as an option.
  const clean = ["/usr/bin/env", "-i", "--", ...env];
  const { repository, ...rest } = q.labels;
  const run = {
    argv: [...clean, ...q.command],
    cwd: q.folder,
    labels: { repo: repository, ...rest, name: q.name, ...mark },
    no_parent: true,
  };
  const t = Terminal.parse(await rpc("terminal.run", run));
  return { id: t.address };
}

// Lists Skelcrew's sessions on this core, finished ones too, with their labels and whether the
// agent runs, so a starting engine finds its agents again. A terminal whose labels aren't
// Skelcrew's shape has null labels, and Skelcrew leaves it alone.
export async function list() {
  const answer = z
    .object({ terminals: z.array(Terminal) })
    .parse(await rpc("terminal.list", { all: true, labels: mark }));
  return {
    sessions: answer.terminals.map((t) => {
      const labels = HcLabels.safeParse(t.labels);
      const { repo, ...rest } = labels.success ? labels.data : { repo: "" };
      return {
        id: t.address,
        running: t.state === "live",
        labels: labels.success ? { repository: repo, ...rest } : null,
      };
    }),
  };
}

// Returns what the session shows now, for typing, Skelcrew's screen check and `sc peek`. A
// session whose agent ended still shows its last screen, so Skelcrew can say why it ended.
export const Read = z.object({ id: Id });
export async function read(q: z.infer<typeof Read>) {
  const answer = z
    .object({ text: z.string() })
    .parse(await rpc("terminal.read", { terminal: q.id, lines: 0 }));
  return { screen: answer.text };
}

// Presses one key in the session, Enter or Esc, by hc's names for them.
export const Keys = z.object({ id: Id, key: z.enum(["Enter", "Escape"]) });
export async function keys(q: z.infer<typeof Keys>) {
  await rpc("terminal.keys", { terminal: q.id, keys: [q.key === "Enter" ? "enter" : "esc"] });
  return {};
}

// Stops the agent's turn. hc presses Esc for a program that ever reported a status, which every
// Skelcrew session has once `status` ran, and ctrl+c otherwise. Then it watches a second for the
// status to leave working and says what it saw: `stopped`, `still_working`, `exited`, or
// `unknown`. Only `status` changes the status, so after Esc on Claude Code, which has no hook
// for it, this says still_working until Skelcrew's screen check reports idle.
export const Interrupt = z.object({ id: Id });
export async function interrupt(q: z.infer<typeof Interrupt>) {
  return z
    .object({ key: z.string(), outcome: z.string() })
    .parse(await rpc("terminal.interrupt", { terminal: q.id, timeout: 1 }));
}

// Ends the session: its program, then its record. hc's kill hangs up, then terminates, then
// kills, and answers once the program ended, so Skelcrew can remove its clone after. Ending one
// already gone is no error.
export const End = z.object({ id: Id });
export async function end(q: z.infer<typeof End>) {
  try {
    if ((await get(q.id)).state === "live") await rpc("terminal.kill", { terminal: q.id });
    await rpc("terminal.rm", { terminal: q.id });
  } catch (error) {
    if (!(error instanceof HcError && error.kind === "not_found")) throw error;
  }
  return {};
}

// The command that attaches your terminal to the session: it names the core's own socket, and
// unsets what would make hc take the caller for a terminal of its own, so it reaches Skelcrew's
// core whatever your environment holds, other runtime and state folders included. Ctrl+\
// detaches, hc's key, not Skelcrew's Alt-Q.
export async function attachCommand(id: string): Promise<string[]> {
  Id.parse(id);
  // Checks the core is Skelcrew's, as every call does.
  await rpc("server.status", {});
  const { HC_SESSION, XDG_CONFIG_HOME } = hcEnv();
  const socket = coreSocket();
  if (!existsSync(socket)) throw new Error(`Skelcrew's core has no socket at ${socket}`);
  const unset = ["HC_TERMINAL_ID", "HC_SCOPE"].flatMap((k) => ["-u", k]);
  const set = [
    `HC_SOCKET=${socket}`,
    `HC_SESSION=${HC_SESSION}`,
    `XDG_CONFIG_HOME=${XDG_CONFIG_HOME}`,
  ];
  return ["/usr/bin/env", ...unset, ...set, hcBin(), "attach", id];
}

// Says whether the agent can take a message now: idle, ready, needs you with no question open,
// or an error all leave it free, as Skelcrew's messages module already decided it may send. A
// turn still running, an open question or permission, which typing would answer, an agent that
// reported nothing yet, or one that ended, are not idle. Skelcrew asks this to decide, so it
// answers at once.
export const Idle = z.object({ id: Id });
export async function idle(q: z.infer<typeof Idle>) {
  return { idle: free((await live(q.id))?.status) };
}

// Reports whether a status leaves the agent free for a message, as `idle` says.
function free(shown: Shown | null | undefined): boolean {
  if (!shown || shown.state === "working") return false;
  return !(shown.state === "blocked" && shown.kind);
}

// Waits until the agent isn't working, for at most `timeout` milliseconds, by following hc's
// events. Says whether it got there, the state hc last showed, and `ended` when the session
// ended or went. Only hc saying so counts as ended: a wait that ran out says only what it saw.
async function waitUntilIdle(id: string, timeout: number) {
  // A first look, which also checks the core is Skelcrew's, as every call does.
  const first = await live(id);
  if (!first) return { idle: false, state: undefined, ended: true };
  let state = first.status?.state;
  if (state && state !== "working") return { idle: true, state };
  const child = Bun.spawn([hcBin(), "events", "--terminal", id, "--json"], {
    env: hcEnv(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const timer = Number.isFinite(timeout) ? setTimeout(() => child.kill(), timeout) : undefined;
  try {
    for await (const line of lines(child.stdout)) {
      const message = JSON.parse(line);
      // The first line is the snapshot, then one notification per change.
      if (message.terminals) {
        const record = message.terminals[0];
        if (record?.state !== "live") return { idle: false, state: undefined, ended: true };
        state = record.status?.state;
      }
      const event = message.params;
      if (event?.type === "status") state = event.data.status?.state;
      if (event?.type === "finished" || event?.type === "removed")
        return { idle: false, state, ended: true };
      if (state && state !== "working") return { idle: true, state };
    }
  } finally {
    clearTimeout(timer);
    child.kill();
  }
  // The wait ran out, or hc events stopped: look once more.
  const last = await live(id);
  if (!last) return { idle: false, state: undefined, ended: true };
  state = last.status?.state;
  return { idle: !!state && state !== "working", state };
}

// What a harness's screen shows: `busy` while a turn runs, and a line starting with `prompt`
// where a message goes, bare when nothing is typed there. The same marks Skelcrew's built-in
// transport reads.
export const Marks = z.object({ busy: z.string().min(1), prompt: z.string().min(1) });
export type Marks = z.infer<typeof Marks>;

// Returns why the screen shows the agent not ready for a message, or empty text when its prompt
// is empty. `shown` is the screen now, and `before` the same screen a moment earlier.
//
// A running turn keeps its status line moving, a spinner or a clock beside the busy mark, so
// the busy mark counts only on a line that is new since the earlier look. The same words in
// output that stands still, such as an agent quoting them, don't count. A screen that changed
// elsewhere is still being drawn, and isn't ready either. hc's `if: idle`, not the screen, is
// what keeps a message out of a running turn: this look is a second guard.
//
// The prompt's mark is its first word, such as `❯` for Claude Code or `›` for Codex,
// and the rest is the placeholder an empty prompt shows, such as Codex's `Ask Codex to do
// anything`, which typing replaces. So the last line starting with the mark is where a message
// goes: the mark alone or with its placeholder is empty, and anything else after it is a
// person's unsent draft. A numbered menu, such as a permission question, also puts the mark
// before text, and isn't ready either. hc's read drops trailing spaces.
export function notReady(shown: string, marks: Marks, before = shown): string {
  if (before !== shown) {
    const earlier = new Set(before.split("\n"));
    const live = shown.split("\n").some((line) => line.includes(marks.busy) && !earlier.has(line));
    return live ? `it shows ${marks.busy}` : "its screen kept changing";
  }
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

// Returns why the agent's screen shows it not ready, or empty text when it is, as Skelcrew's
// built-in transport tells: two looks a moment apart, so a moving status line shows apart from
// still output. A busy mark still at a ready prompt gets one more look, long enough for a status
// line to redraw: Claude Code's spinner and Codex's "Working" line count seconds, so they redraw
// at least once a second, and the first two looks can fall between two ticks.
async function whyNotReady(id: string, marks: Marks): Promise<string> {
  const look = async () => (await read({ id })).screen;
  const before = await look();
  await Bun.sleep(moment);
  const after = await look();
  const why = notReady(after, marks, before);
  if (why || !after.includes(marks.busy)) return why;
  await Bun.sleep(statusLineWatch);
  return notReady(await look(), marks, after);
}

// The moment between the first two looks, and how long a still busy mark is watched after.
const moment = 500;
const statusLineWatch = 1500;

// Types `text` and Enter into the agent once it isn't working, never into a running turn and
// never onto a person's unsent draft, waiting at most `timeout` milliseconds, or with no limit
// when it is null. Throws saying why when the text didn't go in: then nothing was typed, and
// Skelcrew keeps the message to send again. An answer means it went in.
//
// Never into a running turn: hc types only through a send `if` idle, which hc checks at the
// moment it types, whatever happened while the send was held. `if` knows only idle and working,
// so an agent that is ready, needs you with no dialog open, or hit an error is first reported
// idle, with the message `delivering`, and its status is put back afterwards unless Skelcrew
// reported another meanwhile. A report of working while the send is held then stops it.
//
// Never onto a draft: hc holds a send while a person has a draft, the screen shows it or not,
// and on Skelcrew's core that hold has no end (see hc.ts). Given the harness's `marks`, a send
// also goes only once the screen shows an empty prompt, which catches a draft hc never saw, such
// as one typed before the core restarted. A send still held at the deadline is cancelled, which
// hc honours only before typing, so the answer is certain. After typing, hc watches up to 5
// seconds for the agent to start working, so the answer can come that much after the deadline.
export const Deliver = z.object({
  id: Id,
  text: z.string().min(1),
  marks: Marks.optional(),
  timeout: z.number().min(0).nullable().default(60_000),
});
export async function deliver(q: z.infer<typeof Deliver>) {
  const deadline = q.timeout === null ? Infinity : Date.now() + q.timeout;
  const left = () => Math.max(0, deadline - Date.now());
  while (true) {
    const t = await get(q.id);
    if (t.state !== "live") throw new Error("it has ended");
    const state = t.status?.state;
    if (state === "blocked" && t.status?.kind)
      throw new Error(`it shows a ${t.status.kind}, which typing would answer`);
    if (!state || state === "working") {
      if (left() === 0) throw new Error(`it was ${wordOf(state) ?? "silent"}`);
      const waited = await waitUntilIdle(q.id, left());
      if (waited.ended) throw new Error("it has ended");
      if (!waited.idle) throw new Error(`it was ${wordOf(waited.state) ?? "silent"}`);
      continue;
    }
    const why = q.marks ? await whyNotReady(q.id, q.marks) : "";
    if (why) {
      if (left() === 0) throw new Error(why);
      await Bun.sleep(Math.min(250, left()));
      continue;
    }
    // Nothing is sent once the time is up, as a send can type before its cancel arrives.
    const late = "its time ran out before it was ready";
    if (left() === 0) throw new Error(late);
    const shown = t.status ?? { state };
    if (state !== "idle" && !(await report(q.id, shown, delivering))) continue;
    if (left() === 0) {
      if (state !== "idle") await report(q.id, delivering, shown);
      throw new Error(late);
    }
    const send = { terminal: q.id, text: q.text, if: "idle" };
    const failed = await rpc(
      "terminal.send",
      send,
      Number.isFinite(deadline) ? deadline : undefined,
    ).then(
      () => null,
      (error: unknown) => error ?? new Error("the send failed"),
    );
    // Then the status goes back, whatever the send did. An agent that ended after taking the
    // text leaves nothing to put back, and that is no error.
    const notPutBack =
      state === "idle"
        ? null
        : await report(q.id, delivering, shown).then(
            () => null,
            (error: unknown) => error ?? new Error("putting the status back failed"),
          );
    // Putting the status back never hides that the text went in, as Skelcrew would send it
    // again.
    if (!failed) return {};
    if (!(failed instanceof HcError)) throw failed;
    if (notPutBack) throw notPutBack;
    // The status changed before typing: look again.
    if (failed.kind === "status_mismatch") continue;
    // Held by a person's typing until the deadline.
    if (failed.kind === "cancelled") throw new Error("a person's typing at its prompt held it");
    // The time ran out while connecting, so nothing was sent.
    if (failed.kind === "late") throw new Error(late);
    throw failed;
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
  id: Id,
  status: Word,
  reason: z.string().default(""),
});
export async function status(q: z.infer<typeof Status>) {
  const wanted = shownFor(q.status, q.reason);
  await report(q.id, null, wanted);
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
// that is false too; without it, an error. Reports for one session take turns: each waits until
// hc shows the one before, so a delivery putting a status back can't undo a newer one from Skelcrew.
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

// Where the lock for a session lives: a file named for the core it is on, by the core's own ID,
// and the session, in a folder of this user's in /tmp. Nothing in a caller's environment
// changes it, so every caller reaching that terminal takes the same lock.
export async function lockPath(session: string): Promise<string> {
  const status = z
    .object({ core: z.object({ id: z.string().regex(/^[A-Za-z0-9_-]+$/) }) })
    .parse(await rpc("server.status", {}));
  const folder = join("/tmp", `skelcrew-herdr-${process.getuid?.() ?? "user"}`);
  return join(folder, `${status.core.id}-${session}.flock`);
}

// Runs `fn` holding the session's lock: the system's own lock on its file (flock), which the
// system lets go of when its holder exits or dies, however long it held it. So nothing ever has
// to decide that a holder died, or take a lock from one. Two opens of the file exclude each
// other even in one process. The file stays: removing it while someone waits on it would let
// two holders in.
export async function locked<T>(session: string, fn: () => Promise<T>): Promise<T> {
  const lock = await lockPath(session);
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  const fd = openSync(lock, "a", 0o600);
  try {
    // Asked without blocking, as a blocking call would stop this process's other work.
    while (flock()(fd, lockExclusive | lockNoWait) !== 0) await Bun.sleep(10);
    return await fn();
  } finally {
    // Closing the file lets go of the lock.
    closeSync(fd);
  }
}

// flock's flags, the same on Linux and a Mac.
const lockExclusive = 2;
const lockNoWait = 4;

// The C library's flock, loaded once on first use.
let flockFn: ((fd: number, operation: number) => number) | undefined;
function flock(): (fd: number, operation: number) => number {
  if (!flockFn) {
    const library = process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6";
    const { symbols } = dlopen(library, {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    });
    flockFn = (fd, operation) => symbols.flock(fd, operation);
  }
  return flockFn;
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
