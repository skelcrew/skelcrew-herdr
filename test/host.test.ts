// Tests against a real herdr-core, on a core of the tests' own: its own HC_SESSION, state,
// config and socket folders, so the machine's own core and its terminals are never touched.
// Without hc on PATH (or HC_BIN), they are skipped, and say so.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answer } from "../src/call.ts";
import { coreMark, ensureCore, markedIn, rpc, stopCore } from "../src/hc.ts";
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
  for (const id of started) await host.end({ id });
  await stopCore().catch(() => {});
  rmSync(scratch, { recursive: true, force: true });
  rmSync(sockets, { recursive: true, force: true });
});

// Writes a person's own hc config.toml, which a core started on it would read, and hc reads
// again for each delivery.
function personConfig(text: string) {
  writeFileSync(join(scratch, "config", "herdr-core", "config.toml"), text);
}

// The state hc shows for the session, such as `done` for Skelcrew's ready, or null for none.
async function statusOf(id: string) {
  const record = (await rpc("terminal.get", { terminal: id })) as { status?: { state: string } };
  return record.status?.state ?? null;
}

// Presses keys in the session by hc's names, as a person's terminal would send them.
const press = (id: string, keys: string[]) => rpc("terminal.keys", { terminal: id, keys });

// Starts a session, remembering it for the end of the tests, and returns its ID.
async function startSession(question: Parameters<typeof host.start>[0]) {
  const { id } = await host.start(question);
  started.push(id);
  return id;
}

// Starts the fake agent in a session of its own and waits for its prompt.
async function startAgent(labels: host.Labels = { repository: "simon/app", role: "builder" }) {
  const session = await startSession({
    name: "app-1",
    command: [process.execPath, fakeAgent, "one arg", "two"],
    folder: join(scratch, "work"),
    env: {
      PATH: "/usr/bin:/bin",
      FAKE_TOKEN: "given",
      TERM: "dumb",
      COLORTERM: "custom",
      TERM_PROGRAM: "custom",
    },
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
    const { screen: shown } = await host.read({ id: session });
    if (shown.includes(text)) return shown;
    if (Date.now() > deadline) throw new Error(`${session} never showed ${text}:\n${shown}`);
    await Bun.sleep(50);
  }
}

const screen = async (id: string) => (await host.read({ id })).screen;

// Attaches a person's terminal to the session, through `script`, which gives hc attach the
// terminal it needs, and returns once hc painted the screen, with a way to type and to detach.
// `env` is the person's terminal's, which can differ from Skelcrew's.
async function attachPerson(
  session: string,
  env: Record<string, string | undefined> = process.env,
) {
  const attach = await host.attachCommand(session);
  const quoted = attach.map((word) => `'${word.replaceAll("'", "'\\''")}'`).join(" ");
  const argv =
    process.platform === "darwin"
      ? ["script", "-q", "/dev/null", ...attach]
      : ["script", "-qfc", quoted, "/dev/null"];
  // Bun hands a child the environment it started with unless given process.env as it is now.
  const person = Bun.spawn(argv, {
    env,
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
  test("start runs exactly the command, folder and environment given", async () => {
    const session = await startAgent();
    const shown = await screen(session);
    expect(shown).toContain(`argv: ${JSON.stringify(["one arg", "two"])}`);
    expect(shown).toContain(`cwd: ${join(scratch, "work")}`);
    expect(shown).toContain("token: given");
    // Exactly what was given, terminal variables too, never the core's environment: no HOME,
    // no XDG folders, no HC_ variables, and not hc's own TERM.
    const env = JSON.parse(shown.match(/env: (\[.*\])/)?.[1] ?? "[]") as string[];
    expect(env).toEqual(["COLORTERM", "FAKE_TOKEN", "PATH", "TERM", "TERM_PROGRAM"]);
    expect(shown).toContain(`terminal: ${JSON.stringify(["dumb", "custom", "custom"])}`);
  }, 15_000);

  test("start sets an environment name that starts with -, rather than reading it as an option", async () => {
    const session = await startSession({
      name: "dash-env",
      command: [process.execPath, fakeAgent],
      folder: scratch,
      env: { PATH: "/usr/bin:/bin", "-FOO": "bar" },
      labels: { repository: "simon/app", role: "builder" },
    });
    const shown = await screenShows(session, "token:");
    expect(shown).toContain(`env: ${JSON.stringify(["-FOO", "PATH"])}`);
  }, 15_000);

  test("start takes any name Skelcrew gives, and each start is a session of its own", async () => {
    const exits = {
      name: "My.App-12",
      command: ["sleep", "30"],
      folder: scratch,
      env: {},
      labels: { repository: "simon/My.App", role: "builder" as const, task: "My.App-12" },
    };
    const first = await startSession(exits);
    const second = await startSession(exits);
    expect(first).not.toBe(second);
    const record = (await rpc("terminal.get", { terminal: first })) as { labels: unknown };
    expect(record.labels).toMatchObject({ repo: "simon/My.App", name: "My.App-12" });
  }, 15_000);

  test("list finds Skelcrew's sessions with their labels, and not others", async () => {
    const lead = await startAgent({ repository: "simon/app", role: "lead" });
    const builder = await startAgent({ repository: "simon/app", role: "builder", task: "app-12" });
    const notOurs = { argv: ["sleep", "30"], labels: { repo: "x/y" }, no_parent: true };
    const other = (await rpc("terminal.run", notOurs)) as { address: string };
    started.push(other.address);
    const { sessions } = await host.list();
    expect(sessions).toContainEqual({
      id: lead,
      running: true,
      labels: { repository: "simon/app", role: "lead" },
    });
    expect(sessions).toContainEqual({
      id: builder,
      running: true,
      labels: { repository: "simon/app", role: "builder", task: "app-12" },
    });
    expect(sessions.map((s) => s.id)).not.toContain(other.address);
  }, 15_000);

  test("read gives the screen", async () => {
    const session = await startAgent();
    await press(session, ["h", "i", "enter"]);
    await screenShows(session, "got: hi");
    expect(await screen(session)).toContain("argv:");
  }, 15_000);

  test("keys presses Enter and Esc", async () => {
    const session = await startAgent();
    await press(session, ["h", "i"]);
    await host.keys({ id: session, key: "Enter" });
    await screenShows(session, "got: hi");
    await host.keys({ id: session, key: "Escape" });
    await screenShows(session, "interrupted");
  }, 15_000);

  test("end ends the agent and removes its session, and ending it again is no error", async () => {
    const session = await startAgent();
    await host.end({ id: session });
    expect((await host.list()).sessions.map((s) => s.id)).not.toContain(session);
    await host.end({ id: session });
  }, 15_000);

  test("an agent that exits stays listed, not running, with its last screen", async () => {
    const session = await startSession({
      name: "exits",
      command: ["/bin/sh", "-c", "echo bye; exit 3"],
      folder: scratch,
      env: {},
      labels: { repository: "simon/app", role: "builder", task: "app-9" },
    });
    let found: Awaited<ReturnType<typeof host.list>>["sessions"][number] | undefined;
    for (let i = 0; i < 100 && found?.running !== false; i++, await Bun.sleep(50))
      found = (await host.list()).sessions.find((s) => s.id === session);
    expect(found?.running).toBe(false);
    expect(await screen(session)).toContain("bye");
  }, 15_000);

  test("attach is hc attach on the session, on Skelcrew's core whatever the caller's env", async () => {
    expect(await host.attachCommand("t1")).toEqual([
      "/usr/bin/env",
      ...["-u", "HC_TERMINAL_ID", "-u", "HC_SCOPE"],
      `HC_SOCKET=${join(sockets, "herdr-core", `${process.env.SKELCREW_HC_SESSION}.sock`)}`,
      `HC_SESSION=${process.env.SKELCREW_HC_SESSION}`,
      `XDG_CONFIG_HOME=${join(scratch, "plugin", "config")}`,
      bin ?? "",
      "attach",
      "t1",
    ]);
    // A person's terminal with other runtime and state folders, a socket override and another
    // session still reaches Skelcrew's core.
    const session = await startAgent();
    const elsewhere = join(scratch, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    const person = await attachPerson(session, {
      ...process.env,
      XDG_RUNTIME_DIR: elsewhere,
      XDG_STATE_HOME: elsewhere,
      HOME: elsewhere,
      HC_SOCKET: join(elsewhere, "other.sock"),
      HC_SESSION: "x",
    });
    try {
      person.type("typed");
      await screenShows(session, "> typed");
    } finally {
      await person.detach();
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
      expect(await host.status({ id: session, status: word, reason })).toEqual({ status: word });
      const record = (await rpc("terminal.get", { terminal: session })) as { status: unknown };
      expect(record.status).toEqual(osc);
    }
    // The report reached hc, not the agent's screen.
    expect(await screen(session)).not.toContain("7501");
  }, 20_000);

  test("a status for a session that has ended is an error", async () => {
    await expect(host.status({ id: "nobody", status: "idle", reason: "" })).rejects.toThrow();
  });
});

describe.skipIf(!bin)("transport on herdr-core", () => {
  test("deliver types only once the agent is idle", async () => {
    const session = await startAgent();
    await host.status({ id: session, status: "working", reason: "" });
    await expect(
      host.deliver({ id: session, text: "too soon", marks, timeout: 500 }),
    ).rejects.toThrow("it was working");
    const delivery = host.deliver({ id: session, text: "now", marks, timeout: 10000 });
    await Bun.sleep(500);
    expect(await screen(session)).not.toContain("got:");
    await host.status({ id: session, status: "idle", reason: "" });
    expect(await delivery).toEqual({});
    const shown = await screenShows(session, "got: now");
    expect(shown).not.toContain("too soon");
  }, 20_000);

  test("deliver goes to a ready agent, but not into an open question", async () => {
    const session = await startAgent();
    await host.status({ id: session, status: "ready", reason: "" });
    expect(await host.deliver({ id: session, text: "review", marks, timeout: 5000 })).toEqual({});
    await screenShows(session, "got: review");
    await host.status({ id: session, status: "needs you", reason: "question" });
    await expect(
      host.deliver({ id: session, text: "yes", marks, timeout: 1000 }),
    ).rejects.toThrow();
    await host.status({ id: session, status: "needs you", reason: "round limit" });
    expect(await host.deliver({ id: session, text: "go on", marks, timeout: 5000 })).toEqual({});
    await screenShows(session, "got: go on");
    expect(await screen(session)).not.toContain("got: yes");
  }, 20_000);

  test("a person's unsent draft holds a delivery until it is sent or cleared", async () => {
    const session = await startAgent();
    await host.status({ id: session, status: "idle", reason: "" });
    const person = await attachPerson(session);
    try {
      person.type("draft");
      await screenShows(session, "> draft");
      await expect(
        host.deliver({ id: session, text: "held", marks, timeout: 1500 }),
      ).rejects.toThrow(draftReason);
      // The send that timed out is gone: nothing is typed later either.
      await Bun.sleep(1000);
      expect(await screen(session)).not.toContain("held");
      const delivery = host.deliver({ id: session, text: "after", marks, timeout: 10000 });
      await Bun.sleep(500);
      expect(await screen(session)).not.toContain("after");
      person.type("\x15"); // ctrl+u clears the draft
      expect(await delivery).toEqual({});
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
      await host.status({ id: session, status: "idle", reason: "" });
      person.type("draft");
      await screenShows(session, "> draft");
      await Bun.sleep(1500);
      await expect(
        host.deliver({ id: session, text: "AUTOMATED", marks, timeout: 2000 }),
      ).rejects.toThrow(draftReason);
      person.type("\x15");
      await host.status({ id: session, status: "working", reason: "" });
      const delivery = host.deliver({ id: session, text: "LATER", marks, timeout: 3000 });
      person.type("again");
      await screenShows(session, "> again");
      await host.status({ id: session, status: "idle", reason: "" });
      await expect(delivery).rejects.toThrow(draftReason);
      await Bun.sleep(500);
      const shown = await screen(session);
      expect(shown).not.toContain("AUTOMATED");
      expect(shown).not.toContain("LATER");
      person.type("\x15");
      expect(await host.deliver({ id: session, text: "cleared", marks, timeout: 5000 })).toEqual(
        {},
      );
      await screenShows(session, "got: cleared");
    } finally {
      await person.detach();
    }
  }, 30_000);

  test("a draft the screen doesn't show holds a delivery however old it is", async () => {
    const session = await startAgent();
    await host.status({ id: session, status: "idle", reason: "" });
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
        await expect(
          host.deliver({ id: session, text: "ONTOP", marks, timeout: 1500 }),
        ).rejects.toThrow("a person's typing at its prompt held it");
        await Bun.sleep(500);
        expect(await screen(session)).not.toContain("ONTOP");
        person.type("\x15");
      }
      expect(await host.deliver({ id: session, text: "cleared", marks, timeout: 5000 })).toEqual(
        {},
      );
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
    await host.status({ id: session, status: "ready", reason: "" });
    const person = await attachPerson(session);
    try {
      // A draft the screen doesn't show, so only hc holds the send for it.
      person.type("\x02draft");
      await Bun.sleep(300);
      expect(host.notReady(await screen(session), marks)).toBe("");
      const delivery = host.deliver({ id: session, text: "DURING_WORK", marks, timeout: 10000 });
      await Bun.sleep(1000);
      await host.status({ id: session, status: "working", reason: "" });
      person.type("\x15");
      await Bun.sleep(1500);
      expect(await screen(session)).not.toContain("DURING_WORK");
      expect(await statusOf(session)).toBe("working");
      await host.status({ id: session, status: "ready", reason: "" });
      expect(await delivery).toEqual({});
      await screenShows(session, "got: DURING_WORK");
    } finally {
      await person.detach();
    }
  }, 30_000);

  test("a status that changes while a draft holds a delivery stops it", async () => {
    const session = await startAgent();
    await host.status({ id: session, status: "ready", reason: "" });
    const person = await attachPerson(session);
    try {
      person.type("draft");
      await screenShows(session, "> draft");
      const delivery = host.deliver({ id: session, text: "DURING_WORK", marks, timeout: 10000 });
      await Bun.sleep(300);
      await host.status({ id: session, status: "working", reason: "" });
      person.type("\x15");
      await Bun.sleep(1500);
      expect(await screen(session)).not.toContain("DURING_WORK");
      await host.status({ id: session, status: "ready", reason: "" });
      expect(await delivery).toEqual({});
      await screenShows(session, "got: DURING_WORK");
    } finally {
      await person.detach();
    }
  }, 30_000);

  test("a delivery to a ready agent puts its status back", async () => {
    const session = await startAgent();
    await host.status({ id: session, status: "ready", reason: "" });
    expect(await host.deliver({ id: session, text: "one", marks, timeout: 5000 })).toEqual({});
    expect(await statusOf(session)).toBe("done");
    const person = await attachPerson(session);
    try {
      person.type("draft");
      await screenShows(session, "> draft");
      await expect(
        host.deliver({ id: session, text: "two", marks, timeout: 1000 }),
      ).rejects.toThrow();
      expect(await statusOf(session)).toBe("done");
    } finally {
      await person.detach();
    }
  }, 20_000);

  test("a delivery to an agent that ends right after taking it is still delivered", async () => {
    const session = await startSession({
      name: "takes-one",
      command: ["/bin/sh", "-c", 'printf "> "; read line; echo "got: $line"'],
      folder: scratch,
      env: {},
      labels: { repository: "simon/app", role: "builder" },
    });
    await screenShows(session, ">");
    await host.status({ id: session, status: "ready", reason: "" });
    expect(await host.deliver({ id: session, text: "last", marks, timeout: 5000 })).toEqual({});
    const found = (await host.list()).sessions.find((s) => s.id === session);
    expect(found?.running).toBe(false);
  }, 15_000);

  test("a busy mark holds a delivery only while it moves", async () => {
    const session = await startAgent();
    await host.status({ id: session, status: "idle", reason: "" });
    // The agent quotes the busy mark, which then stands still in its output.
    expect(
      await host.deliver({ id: session, text: "say esc to interrupt", marks, timeout: 5000 }),
    ).toEqual({});
    await screenShows(session, "got: say esc to interrupt");
    expect(await host.deliver({ id: session, text: "quoted", marks, timeout: 5000 })).toEqual({});
    await screenShows(session, "got: quoted");
    // A busy line that moves, though hc's status says idle.
    await press(session, ["ctrl+t"]);
    await screenShows(session, "(esc to interrupt)");
    await expect(
      host.deliver({ id: session, text: "moving", marks, timeout: 4000 }),
    ).rejects.toThrow("it shows esc to interrupt");
    await press(session, ["ctrl+t"]);
    expect(await host.deliver({ id: session, text: "stopped", marks, timeout: 5000 })).toEqual({});
    const shown = await screenShows(session, "got: stopped");
    expect(shown).not.toContain("got: moving");
  }, 30_000);

  test("deliver types nothing once its time is up", async () => {
    const session = await startAgent();
    await host.status({ id: session, status: "idle", reason: "" });
    for (const timeout of [0, 300]) {
      await expect(
        host.deliver({ id: session, text: "too late", marks, timeout }),
      ).rejects.toThrow();
    }
    await Bun.sleep(1500);
    expect(await screen(session)).not.toContain("too late");
  }, 15_000);

  test("a send whose setup outlasts its deadline is never sent", async () => {
    const session = await startAgent();
    await host.status({ id: session, status: "idle", reason: "" });
    // An hc whose core check takes two seconds, as on a slow or busy machine.
    const slow = join(scratch, "slow-hc");
    writeFileSync(slow, `#!/bin/sh\n[ "$1" = server ] && sleep 2\nexec '${bin}' "$@"\n`);
    chmodSync(slow, 0o755);
    process.env.HC_BIN = slow;
    try {
      const send = { terminal: session, text: "LATE", if: "idle" };
      await expect(rpc("terminal.send", send, Date.now() + 1000)).rejects.toThrow("time ran out");
      await expect(
        host.deliver({ id: session, text: "LATER", marks, timeout: 1000 }),
      ).rejects.toThrow();
    } finally {
      process.env.HC_BIN = bin ?? "";
    }
    await Bun.sleep(1000);
    const shown = await screen(session);
    expect(shown).not.toContain("LATE");
  }, 30_000);

  test("idle says at once whether the agent can take a message", async () => {
    const session = await startAgent();
    // Nothing reported yet, then a turn running, then each status that leaves it free.
    expect(await host.idle({ id: session })).toEqual({ idle: false });
    const says = [
      ["working", "", false],
      ["idle", "", true],
      ["ready", "", true],
      ["error", "unknown model", true],
      ["needs you", "round limit", true],
      ["needs you", "question", false],
    ] as const;
    for (const [word, reason, free] of says) {
      await host.status({ id: session, status: word, reason });
      expect(await host.idle({ id: session })).toEqual({ idle: free });
    }
    await host.end({ id: session });
    expect(await host.idle({ id: session })).toEqual({ idle: false });
  }, 20_000);

  test("interrupt presses Esc, and the status stays Skelcrew's to change", async () => {
    const session = await startAgent();
    await host.status({ id: session, status: "working", reason: "" });
    expect(await host.interrupt({ id: session })).toEqual({
      key: "esc",
      outcome: "still_working",
    });
    await screenShows(session, "interrupted");
    const stopped = host.interrupt({ id: session });
    await Bun.sleep(200);
    await host.status({ id: session, status: "idle", reason: "" });
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
      stdin: new Blob([JSON.stringify({ ask: "read", id: "Bad Name" })]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const err = await new Response(child.stderr).text();
    expect(await child.exited).toBe(1);
    expect(err).toContain("id");
  });

  // Skelcrew takes a delivery that answered for one that went in, so one that didn't must fail.
  test("a delivery that didn't go in exits 1 with why", async () => {
    const session = await startAgent();
    await host.status({ id: session, status: "working", reason: "" });
    const question = { ask: "deliver", id: session, text: "NOT_NOW", timeout: 300 };
    const child = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "call.ts")], {
      env: process.env,
      stdin: new Blob([JSON.stringify(question)]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const err = await new Response(child.stderr).text();
    expect(await child.exited).toBe(1);
    expect(err.trim().split("\n").at(-1)).toBe("Error: it was working");
    expect(await screen(session)).not.toContain("NOT_NOW");
  }, 15_000);

  test("calls the same functions", async () => {
    expect(await answer({ ask: "idle", id: "t999" })).toEqual(await host.idle({ id: "t999" }));
  });
});

// Holds the session's lock in a process of its own, as another caller would, until killed.
async function holdLockElsewhere(session: string) {
  const holder = Bun.spawn(["bun", join(import.meta.dir, "hold-lock.ts"), session], {
    env: process.env,
    stdout: "pipe",
    stderr: "ignore",
  });
  const reader = holder.stdout.getReader();
  let said = "";
  while (!said.includes("held")) {
    const { value, done } = await reader.read();
    if (done) throw new Error("the lock holder ended");
    said += new TextDecoder().decode(value);
  }
  return holder;
}

describe.skipIf(!bin)("a session's lock", () => {
  test("callers with different environments wait for the same lock", async () => {
    const session = await startAgent();
    const holder = await holdLockElsewhere(session);
    // Another caller, as Skelcrew's engine might be, with another inherited HC_SESSION and TMPDIR.
    const env = { ...process.env, HC_SESSION: "inherited", TMPDIR: join(scratch, "elsewhere") };
    mkdirSync(env.TMPDIR, { recursive: true });
    const question = { ask: "status", id: session, status: "working", reason: "" };
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
      holder.kill();
    }
    expect(await caller.exited).toBe(0);
    expect(JSON.parse(await new Response(caller.stdout).text())).toEqual({ status: "working" });
    expect(await statusOf(session)).toBe("working");
  }, 20_000);

  test("stays its live holder's however long it is held", async () => {
    const session = await startAgent();
    const holder = await holdLockElsewhere(session);
    const question = { ask: "status", id: session, status: "working", reason: "" };
    const caller = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "call.ts")], {
      env: process.env,
      stdin: new Blob([JSON.stringify(question)]),
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      // Longer than any age a lock could once be taken for.
      await Bun.sleep(11_000);
      expect(caller.exitCode).toBeNull();
      expect(await statusOf(session)).toBeNull();
    } finally {
      holder.kill();
    }
    expect(await caller.exited).toBe(0);
    expect(await statusOf(session)).toBe("working");
  }, 30_000);

  test("goes to one waiter at a time once its holder dies, and is left free", async () => {
    const session = "held-dead";
    const holder = await holdLockElsewhere(session);
    let inside = 0;
    let most = 0;
    const waiter = () =>
      host.locked(session, async () => {
        inside++;
        most = Math.max(most, inside);
        await Bun.sleep(100);
        inside--;
      });
    const waiting = Array.from({ length: 4 }, waiter);
    try {
      await Bun.sleep(500);
      expect(most).toBe(0);
    } finally {
      holder.kill("SIGKILL");
    }
    await Promise.all(waiting);
    expect(most).toBe(1);
    // Nothing is left holding it.
    const started = Date.now();
    await host.locked(session, async () => {});
    expect(Date.now() - started).toBeLessThan(1000);
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
  // The busy mark counts on a line that moved between two looks, not in output that stands still.
  expect(host.notReady("got: esc to interrupt\n>", marks)).toBe("");
  const moving = ["* working 1s (esc to interrupt)\n>", "* working 2s (esc to interrupt)\n>"];
  expect(host.notReady(moving[1] ?? "", marks, moving[0])).toBe("it shows esc to interrupt");
  expect(host.notReady("a\n>", marks, "b\n>")).toBe("its screen kept changing");
  expect(host.notReady("loading", marks)).toBe("it shows no > prompt");
});

test("markedIn finds the core's mark in ps's line, whatever spaces other values hold", () => {
  const mark = coreMark();
  const line = (home: string, value: string) =>
    `/opt/hc serve HOME=/Users/a b XDG_CONFIG_HOME=${home} SKELCREW_HERDR_CORE=${value} PATH=/bin`;
  expect(markedIn(line("/Users/a b/state/skelcrew herdr/config", mark), mark)).toBe(true);
  expect(markedIn(line("/x", `${mark}0`), mark)).toBe(false);
  expect(markedIn(`/opt/hc serve NOTE=SKELCREW_HERDR_CORE=${mark}`, mark)).toBe(false);
  expect(markedIn("/opt/hc serve HOME=/Users/a", mark)).toBe(false);
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
  test("a config folder whose path holds spaces is Skelcrew's core all the same", async () => {
    const own = { ...process.env };
    process.env.SKELCREW_HC_SESSION = `spaces${process.pid}`;
    process.env.SKELCREW_HERDR_HOME = join(scratch, "with spaces", "skelcrew herdr");
    try {
      expect(await host.list()).toEqual({ sessions: [] });
    } finally {
      await stopCore().catch(() => {});
      process.env.SKELCREW_HC_SESSION = own.SKELCREW_HC_SESSION;
      process.env.SKELCREW_HERDR_HOME = own.SKELCREW_HERDR_HOME;
    }
  }, 15_000);

  test("a core replaced after a call is checked again, and refused", async () => {
    expect(await host.list()).toHaveProperty("sessions");
    // Another core on the same session, on the person's own config, as any hc command starts one.
    const env = { ...process.env, HC_SESSION: process.env.SKELCREW_HC_SESSION };
    await stopCore();
    Bun.spawnSync([bin ?? "hc", "server", "start", "--json"], { env, stdout: "ignore" });
    try {
      await expect(host.list()).rejects.toThrow("wasn't started by skelcrew-herdr");
      await expect(host.idle({ id: "t1" })).rejects.toThrow("wasn't started by skelcrew-herdr");
      await expect(host.attachCommand("t1")).rejects.toThrow("wasn't started by skelcrew-herdr");
    } finally {
      Bun.spawnSync([bin ?? "hc", "server", "stop", "--json"], { env, stdout: "ignore" });
    }
    // With it gone, Skelcrew's own starts again.
    const { sessions } = await host.list();
    expect(sessions.filter((s) => s.running)).toEqual([]);
  }, 20_000);
});
