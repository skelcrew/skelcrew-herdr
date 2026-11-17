// Tests against a real herdr-core, on a core of the tests' own: its own HC_SESSION, state,
// config and socket folders, so the machine's own core and its terminals are never touched.
// Without hc on PATH (or HC_BIN), they are skipped, and say so.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answer } from "../src/call.ts";
import { ensureCore, rpc, stopCore } from "../src/hc.ts";
import * as host from "../src/host.ts";

const bin = process.env.HC_BIN || Bun.which("hc");
const why = "hc (herdr-core) isn't installed: put it on PATH or set HC_BIN";
if (!bin) console.warn(`skipping the herdr-core tests: ${why}`);

const fakeAgent = join(import.meta.dir, "fake-agent.ts");
// The fake agent's screen marks, as a harness module gives them.
const marks = { busy: "esc to interrupt", prompt: ">" };
const draftReason = "a person's unsent draft is at its prompt";
let scratch = "";
// The socket's path is limited to about 100 bytes, so its folder is a short one in /tmp.
let sockets = "";
let names = 0;
const started: string[] = [];

beforeAll(async () => {
  if (!bin) return;
  scratch = mkdtempSync(join(tmpdir(), "skelcrew-herdr-"));
  sockets = mkdtempSync("/tmp/hc-");
  for (const key of ["HC_SOCKET", "HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "HC_SCOPE"])
    delete process.env[key];
  Object.assign(process.env, {
    HC_BIN: bin,
    // Skelcrew's core for these tests, and this program's files, with its config.
    SKELCREW_HC_SESSION: `test${process.pid}`,
    SKELCREW_HERDR_HOME: join(scratch, "plugin"),
    XDG_STATE_HOME: join(scratch, "state"),
    // A person's own hc config, which Skelcrew's core never reads.
    XDG_CONFIG_HOME: join(scratch, "config"),
    XDG_RUNTIME_DIR: sockets,
    // A person's key holds an agent's send this long, 3s by default.
    HC_QUIET_MS: "200",
    // A send watches this long for the agent to start working, 5s by default. Only `status`
    // says it did, and these tests mostly don't, so they would wait that long for each send.
    HC_STARTED_MS: "300",
  });
  mkdirSync(join(scratch, "config", "herdr-core"), { recursive: true });
  mkdirSync(join(scratch, "work"));
  await ensureCore();
});

afterAll(async () => {
  if (!bin) return;
  for (const session of started) await host.end({ session });
  await stopCore().catch(() => {});
  rmSync(scratch, { recursive: true, force: true });
  rmSync(sockets, { recursive: true, force: true });
});

// Writes a person's own hc config.toml, which a core started on it would read, and hc reads
// again for each delivery.
function personConfig(text: string) {
  writeFileSync(join(scratch, "config", "herdr-core", "config.toml"), text);
}

// The status hc shows for the session, in Skelcrew's words.
async function statusOf(session: string) {
  return (await host.list()).sessions.find((s) => s.session === session)?.status;
}

// Starts the fake agent in a session of its own and waits for its prompt.
async function startAgent(labels: host.Labels = { repo: "simon/app", role: "builder" }) {
  const session = `agent-${++names}`;
  started.push(session);
  await host.start({
    session,
    argv: [process.execPath, fakeAgent, "one arg", "two"],
    folder: join(scratch, "work"),
    env: { PATH: "/usr/bin:/bin", FAKE_TOKEN: "given", TERM: "dumb" },
    labels,
  });
  // hc's read leaves out the space after the prompt's mark.
  await screenShows(session, "token: given\n>");
  return session;
}

// Waits until the session's screen holds `text`, and returns the screen.
async function screenShows(session: string, text: string, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (true) {
    const { text: shown } = await host.read({ session, lines: 0 });
    if (shown.includes(text)) return shown;
    if (Date.now() > deadline) throw new Error(`${session} never showed ${text}:\n${shown}`);
    await Bun.sleep(50);
  }
}

const screen = async (session: string) => (await host.read({ session, lines: 0 })).text;

// Attaches a person's terminal to the session, through `script`, which gives hc attach the
// terminal it needs, and returns once hc painted the screen, with a way to type and to detach.
async function attachPerson(session: string) {
  const { argv: attach } = await host.attach({ session });
  const quoted = attach.map((word) => `'${word.replaceAll("'", "'\\''")}'`).join(" ");
  const argv =
    process.platform === "darwin"
      ? ["script", "-q", "/dev/null", ...attach]
      : ["script", "-qfc", quoted, "/dev/null"];
  // Bun hands a child the environment it started with unless given process.env as it is now.
  const person = Bun.spawn(argv, {
    env: process.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  // Keys typed before hc attach is up are lost, so wait for its first paint, then keep reading.
  const output = person.stdout.getReader();
  let painted = "";
  while (!painted.includes("token: given")) {
    const { value, done } = await output.read();
    if (done) throw new Error(`hc attach ended: ${painted}`);
    painted += new TextDecoder().decode(value);
  }
  (async () => {
    while (!(await output.read()).done);
  })();
  return {
    type: (text: string) => {
      person.stdin.write(text);
      person.stdin.flush();
    },
    detach: async () => {
      person.kill();
      await person.exited;
    },
  };
}

describe.skipIf(!bin)("sessions on herdr-core", () => {
  test("start runs exactly the argv, folder and environment given", async () => {
    const session = await startAgent();
    const shown = await screen(session);
    expect(shown).toContain(`argv: ${JSON.stringify(["one arg", "two"])}`);
    expect(shown).toContain(`cwd: ${join(scratch, "work")}`);
    expect(shown).toContain("token: given");
    // Only what was given, with the terminal's own TERM, COLORTERM and TERM_PROGRAM, never
    // the core's environment: no HOME, no XDG folders, no HC_ variables.
    const env = JSON.parse(shown.match(/env: (\[.*\])/)?.[1] ?? "[]") as string[];
    expect(env.filter((key) => !["COLORTERM", "TERM_PROGRAM"].includes(key))).toEqual([
      "FAKE_TOKEN",
      "PATH",
      "TERM",
    ]);
    expect(shown).not.toContain("TERM=dumb");
  }, 15_000);

  test("list finds Skelcrew's sessions with their labels, and not others", async () => {
    const lead = await startAgent({ repo: "simon/app", role: "lead" });
    const builder = await startAgent({ repo: "simon/app", role: "builder", task: "app-12" });
    const notOurs = { argv: ["sleep", "30"], name: "not-ours", labels: { repo: "x/y" } };
    await rpc("terminal.run", { ...notOurs, no_parent: true });
    started.push("not-ours");
    const { sessions } = await host.list();
    expect(sessions).toContainEqual({
      session: lead,
      running: true,
      labels: { repo: "simon/app", role: "lead" },
      status: null,
    });
    expect(sessions).toContainEqual({
      session: builder,
      running: true,
      labels: { repo: "simon/app", role: "builder", task: "app-12" },
      status: null,
    });
    expect(sessions.map((s) => s.session)).not.toContain("not-ours");
  }, 15_000);

  test("read gives the screen, and history above it", async () => {
    const session = await startAgent();
    await host.keys({ session, keys: ["h", "i", "enter"] });
    await screenShows(session, "got: hi");
    const { text } = await host.read({ session, lines: 100 });
    expect(text).toContain("argv:");
    expect(text).toContain("got: hi");
  }, 15_000);

  test("end ends the agent and removes its session, and ending it again is no error", async () => {
    const session = await startAgent();
    await host.end({ session });
    expect((await host.list()).sessions.map((s) => s.session)).not.toContain(session);
    await host.end({ session });
  }, 15_000);

  test("an agent that exits stays listed, not running, with how it ended", async () => {
    const session = "exits";
    started.push(session);
    await host.start({
      session,
      argv: ["/bin/sh", "-c", "exit 3"],
      folder: scratch,
      env: {},
      labels: { repo: "simon/app", role: "builder", task: "app-9" },
    });
    let found: Awaited<ReturnType<typeof host.list>>["sessions"][number] | undefined;
    for (let i = 0; i < 100 && !found?.ended; i++, await Bun.sleep(50))
      found = (await host.list()).sessions.find((s) => s.session === session);
    expect(found?.running).toBe(false);
    expect<unknown>(found?.ended).toEqual({ reason: "exited", exit_code: 3 });
  }, 15_000);

  test("attach is hc attach on the session, on Skelcrew's core whatever the caller's env", async () => {
    expect(await host.attach({ session: "agent-1" })).toEqual({
      argv: [
        "/usr/bin/env",
        ...["-u", "HC_SOCKET", "-u", "HC_TERMINAL_ID", "-u", "HC_SCOPE"],
        `HC_SESSION=${process.env.SKELCREW_HC_SESSION}`,
        `XDG_CONFIG_HOME=${join(scratch, "plugin", "config")}`,
        bin ?? "",
        "attach",
        "agent-1",
      ],
    });
    // A socket override and another session in the caller's env don't lead elsewhere.
    const session = await startAgent();
    Object.assign(process.env, { HC_SOCKET: join(sockets, "elsewhere.sock"), HC_SESSION: "x" });
    try {
      const person = await attachPerson(session);
      person.type("typed");
      await screenShows(session, "> typed");
      await person.detach();
    } finally {
      delete process.env.HC_SOCKET;
      delete process.env.HC_SESSION;
    }
  }, 20_000);
});

describe.skipIf(!bin)("status on herdr-core", () => {
  test("each status Skelcrew reports is the status hc shows", async () => {
    const session = await startAgent();
    const shows = [
      ["working", "", { state: "working" }],
      ["idle", "", { state: "idle" }],
      ["needs you", "question", { state: "blocked", kind: "question", msg: "question" }],
      ["needs you", "round limit", { state: "blocked", msg: "round limit" }],
      ["ready", "", { state: "done" }],
      ["error", "unknown model", { state: "error", msg: "unknown model" }],
    ] as const;
    for (const [word, reason, osc] of shows) {
      expect(await host.status({ session, status: word, reason })).toEqual({ status: word });
      const record = (await rpc("terminal.get", { terminal: session })) as { status: unknown };
      expect(record.status).toEqual(osc);
      const listed = (await host.list()).sessions.find((s) => s.session === session);
      expect(listed?.status).toBe(word);
    }
    // The report reached hc, not the agent's screen.
    expect(await screen(session)).not.toContain("7501");
  }, 20_000);

  test("a status for a session that has ended is an error", async () => {
    await expect(host.status({ session: "nobody", status: "idle", reason: "" })).rejects.toThrow();
  });
});

describe.skipIf(!bin)("transport on herdr-core", () => {
  test("deliver types only once the agent is idle", async () => {
    const session = await startAgent();
    await host.status({ session, status: "working", reason: "" });
    expect(await host.deliver({ session, text: "too soon", marks, timeout: 0.5 })).toEqual({
      delivered: false,
      why: "it was working",
    });
    const delivery = host.deliver({ session, text: "now", marks, timeout: 10 });
    await Bun.sleep(500);
    expect(await screen(session)).not.toContain("got:");
    await host.status({ session, status: "idle", reason: "" });
    expect(await delivery).toEqual({ delivered: true });
    const shown = await screenShows(session, "got: now");
    expect(shown).not.toContain("too soon");
  }, 20_000);

  test("deliver goes to a ready agent, but not into an open question", async () => {
    const session = await startAgent();
    await host.status({ session, status: "ready", reason: "" });
    expect(await host.deliver({ session, text: "review", marks, timeout: 5 })).toEqual({
      delivered: true,
    });
    await screenShows(session, "got: review");
    await host.status({ session, status: "needs you", reason: "question" });
    expect(await host.deliver({ session, text: "yes", marks, timeout: 1 })).toMatchObject({
      delivered: false,
    });
    await host.status({ session, status: "needs you", reason: "round limit" });
    expect(await host.deliver({ session, text: "go on", marks, timeout: 5 })).toEqual({
      delivered: true,
    });
    await screenShows(session, "got: go on");
    expect(await screen(session)).not.toContain("got: yes");
  }, 20_000);

  test("a person's unsent draft holds a delivery until it is sent or cleared", async () => {
    const session = await startAgent();
    await host.status({ session, status: "idle", reason: "" });
    const person = await attachPerson(session);
    try {
      person.type("draft");
      await screenShows(session, "> draft");
      expect(await host.deliver({ session, text: "held", marks, timeout: 1.5 })).toEqual({
        delivered: false,
        why: draftReason,
      });
      // The send that timed out is gone: nothing is typed later either.
      await Bun.sleep(1000);
      expect(await screen(session)).not.toContain("held");
      const delivery = host.deliver({ session, text: "after", marks, timeout: 10 });
      await Bun.sleep(500);
      expect(await screen(session)).not.toContain("after");
      person.type("\x15"); // ctrl+u clears the draft
      expect(await delivery).toEqual({ delivered: true });
      const shown = await screenShows(session, "got: after");
      expect(shown).not.toContain("draftafter");
    } finally {
      await person.detach();
    }
  }, 30_000);

  test("a draft holds a delivery however old it is", async () => {
    const session = await startAgent();
    const person = await attachPerson(session);
    try {
      // A draft from before the delivery, and one typed while it waits for the agent.
      await host.status({ session, status: "idle", reason: "" });
      person.type("draft");
      await screenShows(session, "> draft");
      await Bun.sleep(1500);
      expect(await host.deliver({ session, text: "AUTOMATED", marks, timeout: 2 })).toEqual({
        delivered: false,
        why: draftReason,
      });
      person.type("\x15");
      await host.status({ session, status: "working", reason: "" });
      const delivery = host.deliver({ session, text: "LATER", marks, timeout: 3 });
      person.type("again");
      await screenShows(session, "> again");
      await host.status({ session, status: "idle", reason: "" });
      expect(await delivery).toEqual({ delivered: false, why: draftReason });
      await Bun.sleep(500);
      const shown = await screen(session);
      expect(shown).not.toContain("AUTOMATED");
      expect(shown).not.toContain("LATER");
      person.type("\x15");
      expect(await host.deliver({ session, text: "cleared", marks, timeout: 5 })).toEqual({
        delivered: true,
      });
      await screenShows(session, "got: cleared");
    } finally {
      await person.detach();
    }
  }, 30_000);

  test("a draft the screen doesn't show holds a delivery however old it is", async () => {
    const session = await startAgent();
    await host.status({ session, status: "idle", reason: "" });
    const person = await attachPerson(session);
    // A person's own config can't shorten the hold on Skelcrew's core, however it is written.
    const configs = [
      ["draft_wait = 2\n", 3000],
      ['"draft_wait" = 0\n', 500],
      ["'draft_wait' = 0.0 # off\n", 500],
      ["[x]\n", 500],
    ] as const;
    try {
      for (const [config, age] of configs) {
        personConfig(config);
        person.type("\x02draft");
        await Bun.sleep(age);
        expect(host.notReady(await screen(session), marks)).toBe("");
        expect(await host.deliver({ session, text: "ONTOP", marks, timeout: 1.5 })).toEqual({
          delivered: false,
          why: "a person's typing at its prompt held it",
        });
        await Bun.sleep(500);
        expect(await screen(session)).not.toContain("ONTOP");
        person.type("\x15");
      }
      expect(await host.deliver({ session, text: "cleared", marks, timeout: 5 })).toEqual({
        delivered: true,
      });
      const shown = await screenShows(session, "got: cleared");
      expect(shown).not.toContain("draftONTOP");
    } finally {
      await person.detach();
      personConfig("");
    }
  }, 40_000);

  test("a core for the session started without this program's config is refused", async () => {
    const own = process.env.SKELCREW_HC_SESSION;
    const other = `other${process.pid}`;
    // Started as any hc command would start it, on the person's own config.
    const env = { ...process.env, HC_SESSION: other };
    Bun.spawnSync([bin ?? "hc", "server", "start", "--json"], { env, stdout: "ignore" });
    process.env.SKELCREW_HC_SESSION = other;
    try {
      await expect(host.list()).rejects.toThrow("wasn't started by skelcrew-herdr");
    } finally {
      process.env.SKELCREW_HC_SESSION = own;
      Bun.spawnSync([bin ?? "hc", "server", "stop", "--json"], { env, stdout: "ignore" });
    }
  }, 15_000);

  test("a status that changes while hc holds a delivery stops it", async () => {
    const session = await startAgent();
    await host.status({ session, status: "ready", reason: "" });
    const person = await attachPerson(session);
    try {
      // A draft the screen doesn't show, so only hc holds the send for it.
      person.type("\x02draft");
      await Bun.sleep(300);
      expect(host.notReady(await screen(session), marks)).toBe("");
      const delivery = host.deliver({ session, text: "DURING_WORK", marks, timeout: 10 });
      await Bun.sleep(1000);
      await host.status({ session, status: "working", reason: "" });
      person.type("\x15");
      await Bun.sleep(1500);
      expect(await screen(session)).not.toContain("DURING_WORK");
      expect(await statusOf(session)).toBe("working");
      await host.status({ session, status: "ready", reason: "" });
      expect(await delivery).toEqual({ delivered: true });
      await screenShows(session, "got: DURING_WORK");
    } finally {
      await person.detach();
    }
  }, 30_000);

  test("a status that changes while a draft holds a delivery stops it", async () => {
    const session = await startAgent();
    await host.status({ session, status: "ready", reason: "" });
    const person = await attachPerson(session);
    try {
      person.type("draft");
      await screenShows(session, "> draft");
      const delivery = host.deliver({ session, text: "DURING_WORK", marks, timeout: 10 });
      await Bun.sleep(300);
      await host.status({ session, status: "working", reason: "" });
      person.type("\x15");
      await Bun.sleep(1500);
      expect(await screen(session)).not.toContain("DURING_WORK");
      await host.status({ session, status: "ready", reason: "" });
      expect(await delivery).toEqual({ delivered: true });
      await screenShows(session, "got: DURING_WORK");
    } finally {
      await person.detach();
    }
  }, 30_000);

  test("a delivery to a ready agent puts its status back", async () => {
    const session = await startAgent();
    await host.status({ session, status: "ready", reason: "" });
    expect(await host.deliver({ session, text: "one", marks, timeout: 5 })).toEqual({
      delivered: true,
    });
    expect(await statusOf(session)).toBe("ready");
    const person = await attachPerson(session);
    try {
      person.type("draft");
      await screenShows(session, "> draft");
      expect(await host.deliver({ session, text: "two", marks, timeout: 1 })).toMatchObject({
        delivered: false,
      });
      expect(await statusOf(session)).toBe("ready");
    } finally {
      await person.detach();
    }
  }, 20_000);

  test("a delivery to an agent that ends right after taking it is still delivered", async () => {
    const session = "takes-one";
    started.push(session);
    await host.start({
      session,
      argv: ["/bin/sh", "-c", 'printf "> "; read line; echo "got: $line"'],
      folder: scratch,
      env: {},
      labels: { repo: "simon/app", role: "builder" },
    });
    await screenShows(session, ">");
    await host.status({ session, status: "ready", reason: "" });
    expect(await host.deliver({ session, text: "last", marks, timeout: 5 })).toEqual({
      delivered: true,
    });
    const found = (await host.list()).sessions.find((s) => s.session === session);
    expect(found?.running).toBe(false);
    expect<unknown>(found?.ended).toEqual({ reason: "exited", exit_code: 0 });
  }, 15_000);

  test("idle says when the agent stops working", async () => {
    const session = await startAgent();
    await host.status({ session, status: "working", reason: "" });
    expect(await host.idle({ session, timeout: 0.3 })).toEqual({ idle: false, status: "working" });
    const waiting = host.idle({ session, timeout: 10 });
    await Bun.sleep(300);
    await host.status({ session, status: "ready", reason: "" });
    expect(await waiting).toEqual({ idle: true, status: "ready" });
    await host.end({ session });
    expect(await host.idle({ session, timeout: 1 })).toMatchObject({ idle: false, ended: true });
  }, 20_000);

  test("idle with no time to wait says what it sees, and never that a live session ended", async () => {
    const session = await startAgent();
    for (let i = 0; i < 3; i++)
      expect(await host.idle({ session, timeout: 0 })).toEqual({ idle: false, status: null });
    await host.status({ session, status: "working", reason: "" });
    for (let i = 0; i < 3; i++)
      expect(await host.idle({ session, timeout: 0 })).toEqual({ idle: false, status: "working" });
    await host.status({ session, status: "idle", reason: "" });
    for (let i = 0; i < 3; i++)
      expect(await host.idle({ session, timeout: 0 })).toEqual({ idle: true, status: "idle" });
    expect(await host.idle({ session: "nobody", timeout: 0 })).toEqual({
      idle: false,
      status: null,
      ended: true,
    });
  }, 20_000);

  test("interrupt presses Esc, and the status stays Skelcrew's to change", async () => {
    const session = await startAgent();
    await host.status({ session, status: "working", reason: "" });
    expect(await host.interrupt({ session, timeout: 0.5 })).toEqual({
      key: "esc",
      outcome: "still_working",
    });
    await screenShows(session, "interrupted");
    const stopped = host.interrupt({ session, timeout: 5 });
    await Bun.sleep(200);
    await host.status({ session, status: "idle", reason: "" });
    expect(await stopped).toEqual({ key: "esc", outcome: "stopped" });
  }, 20_000);
});

describe.skipIf(!bin)("the call handler", () => {
  test("answers a question as plain data", async () => {
    const child = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "call.ts")], {
      env: process.env,
      stdin: new Blob([JSON.stringify({ ask: "list" })]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(JSON.parse(out)).toHaveProperty("sessions");
  }, 15_000);

  test("refuses a question it can't read, with the reason on stderr", async () => {
    const child = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "call.ts")], {
      env: process.env,
      stdin: new Blob([JSON.stringify({ ask: "start", session: "Bad Name" })]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const err = await new Response(child.stderr).text();
    expect(await child.exited).toBe(1);
    expect(err).toContain("session");
  });

  test("calls the same functions", async () => {
    expect(await answer({ ask: "attach", session: "x" })).toEqual(
      await host.attach({ session: "x" }),
    );
  });
});

describe.skipIf(!bin)("status reports take turns", () => {
  test("callers with different environments wait for the same lock", async () => {
    const session = await startAgent();
    const lock = await host.lockPath(session);
    mkdirSync(lock, { recursive: true });
    // Another caller, as Skelcrew's engine might be, with another inherited HC_SESSION and TMPDIR.
    const env = { ...process.env, HC_SESSION: "inherited", TMPDIR: join(scratch, "elsewhere") };
    mkdirSync(env.TMPDIR, { recursive: true });
    const question = { ask: "status", session, status: "working", reason: "" };
    const caller = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "call.ts")], {
      env,
      stdin: new Blob([JSON.stringify(question)]),
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      await Bun.sleep(1500);
      expect(caller.exitCode).toBeNull();
      expect(await statusOf(session)).toBeNull();
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
    expect(await caller.exited).toBe(0);
    expect(JSON.parse(await new Response(caller.stdout).text())).toEqual({ status: "working" });
    expect(await statusOf(session)).toBe("working");
  }, 20_000);
});

test("oscFor encodes a status the way hc reads it", () => {
  expect(host.oscFor("needs you", "question")).toBe(
    "\x1b]7501;state=blocked:kind=question:msg=cXVlc3Rpb24=\x1b\\",
  );
  expect(host.oscFor("ready", "")).toBe("\x1b]7501;state=done\x1b\\");
});

test("notReady tells a bare prompt from a draft, a menu and a busy screen", () => {
  expect(host.notReady("got: x\n>", marks)).toBe("");
  expect(host.notReady("> old\ngot: x\n> new", marks)).toBe(draftReason);
  expect(host.notReady("> 1. Yes", marks)).toBe("it shows a menu");
  expect(host.notReady(">\nesc to interrupt", marks)).toBe("it shows esc to interrupt");
  expect(host.notReady("loading", marks)).toBe("it shows no > prompt");
});

test("notReady reads Skelcrew's Codex and Claude Code marks", () => {
  const codex = { busy: "esc to interrupt", prompt: "› Ask Codex to do anything" };
  expect(host.notReady("› Ask Codex to do anything", codex)).toBe("");
  expect(host.notReady("› Ask Codex to do anything\n› my unsent draft", codex)).toBe(draftReason);
  expect(host.notReady("› my unsent draft", codex)).toBe(draftReason);
  expect(host.notReady("› earlier message\n\n› Ask Codex to do anything", codex)).toBe("");
  const claude = { busy: "esc to interrupt", prompt: "❯" };
  expect(host.notReady("❯ hi\n⏺ Hello\n❯", claude)).toBe("");
  expect(host.notReady("❯ draft", claude)).toBe(draftReason);
});

describe.skipIf(!bin)("Skelcrew's core", () => {
  test("a core replaced after a call is checked again, and refused", async () => {
    expect(await host.list()).toHaveProperty("sessions");
    // Another core on the same session, on the person's own config, as any hc command starts one.
    const env = { ...process.env, HC_SESSION: process.env.SKELCREW_HC_SESSION };
    await stopCore();
    Bun.spawnSync([bin ?? "hc", "server", "start", "--json"], { env, stdout: "ignore" });
    try {
      await expect(host.list()).rejects.toThrow("wasn't started by skelcrew-herdr");
      await expect(host.idle({ session: "agent-1", timeout: 1 })).rejects.toThrow(
        "wasn't started by skelcrew-herdr",
      );
      await expect(host.attach({ session: "agent-1" })).rejects.toThrow(
        "wasn't started by skelcrew-herdr",
      );
    } finally {
      Bun.spawnSync([bin ?? "hc", "server", "stop", "--json"], { env, stdout: "ignore" });
    }
    // With it gone, Skelcrew's own starts again.
    const { sessions } = await host.list();
    expect(sessions.filter((s) => s.running)).toEqual([]);
  }, 20_000);
});
