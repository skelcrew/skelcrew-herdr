// Tests against a real herdr-core, on a core of the tests' own: its own HC_SESSION, state,
// config and socket folders, so the machine's own core and its terminals are never touched.
// Without hc on PATH (or HC_BIN), they are skipped, and say so.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import { z } from "zod";
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
const started: string[] = [];

beforeAll(async () => {
  if (!bin) return;
  scratch = mkdtempSync(join(tmpdir(), "skelcrew-herdr-"));
  sockets = mkdtempSync("/tmp/hc-");
  for (const key of ["HC_SOCKET", "HC_SESSION", "HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "HC_SCOPE"])
    delete process.env[key];
  Object.assign(process.env, {
    HC_BIN: bin,
    // The tests' own default core: its runtime folder holds its socket, so the machine's own
    // core and its terminals are never touched. A person's hc config, which the core reads.
    XDG_STATE_HOME: join(scratch, "state"),
    XDG_CONFIG_HOME: join(scratch, "config"),
    XDG_RUNTIME_DIR: sockets,
    // A person's key holds an agent's send this long, 3s by default.
    HC_QUIET_MS: "200",
    // A send watches this long for the agent to start working, 5s by default. Only `status`
    // says it did, and these tests mostly don't, so they would wait that long for each send.
    HC_STARTED_MS: "300",
  });
  mkdirSync(join(scratch, "config", "herdr-core"), { recursive: true });
  personConfig(recommended);
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

// The hc config the README asks a person to set, which the core reads.
const recommended = 'notes = false\ndraft_wait = 1000000000\ndetach_key = "ctrl+q"\n';

// Writes a person's own hc config.toml, which the core reads, again for each delivery.
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
    exited: person.exited,
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

  test("an environment value is on no process's command line, nor in hc's record", async () => {
    const token = `secret-${crypto.randomUUID()}`;
    const session = await startSession({
      name: "token",
      command: [process.execPath, fakeAgent],
      folder: scratch,
      env: { PATH: "/usr/bin:/bin", FAKE_TOKEN: token },
      labels: { repository: "simon/app", role: "builder" },
    });
    await screenShows(session, `token: ${token}`);
    // Any local user can read every process's command line with ps, but only its owner can
    // read its environment. hc's record of the terminal is shown by hc get and herdr's apps.
    const ps = Bun.spawnSync(["ps", "-A", "-ww", "-o", "pid=,args="]).stdout.toString();
    expect(ps.split("\n").filter((line) => line.includes(token))).toEqual([]);
    expect(JSON.stringify(await rpc("terminal.get", { terminal: session }))).not.toContain(token);
  }, 15_000);

  test("a started session is a terminal a person's own hc lists, under its name", async () => {
    const session = await startSession({
      name: "skelcrew-430",
      command: ["sleep", "30"],
      folder: scratch,
      env: {},
      labels: { repository: "simon/skelcrew", role: "builder", task: "skelcrew-430" },
    });
    // A person's hc, as they type it, with no session chosen: the core herdr's apps show.
    const { HC_SESSION: _, ...env } = process.env;
    const ls = Bun.spawnSync([bin ?? "hc", "ls", "--json"], { env });
    const listed = z
      .object({
        terminals: z.array(z.object({ address: z.string(), name: z.string().nullable() })),
      })
      .parse(JSON.parse(ls.stdout.toString())).terminals;
    expect(listed).toContainEqual({ address: session, name: "skelcrew-430" });
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
    const pid = Number((await screen(session)).match(/pid: (\d+)/)?.[1]);
    expect(pid).toBeGreaterThan(0);
    await host.end({ id: session });
    // The agent itself, under the relay, is gone too.
    expect(() => process.kill(pid, 0)).toThrow();
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
    // The relay around the agent ends with the agent's own exit code.
    const record = (await rpc("terminal.get", { terminal: session })) as { exit_code: unknown };
    expect(record.exit_code).toBe(3);
  }, 15_000);

  // Ctrl-Q detaches on tmux too, so leaving an agent is the same keys on either host. Alt-Q
  // can't be: hc's detach key is a Ctrl chord.
  test("Ctrl-Q detaches a person's terminal, and the agent keeps running", async () => {
    const session = await startAgent();
    const person = await attachPerson(session);
    try {
      person.type("\x11");
      const left = await Promise.race([
        person.exited.then(() => true),
        Bun.sleep(3000).then(() => false),
      ]);
      expect(left).toBe(true);
      expect((await host.list()).sessions.find((s) => s.id === session)?.running).toBe(true);
    } finally {
      await person.detach();
    }
  }, 20_000);

  test("attach is hc attach on the session, on the default core whatever the caller's env", async () => {
    expect(await host.attachCommand("t1")).toEqual([
      "/usr/bin/env",
      ...["-u", "HC_TERMINAL_ID", "-u", "HC_SCOPE", "-u", "HC_SESSION"],
      `HC_SOCKET=${join(sockets, "herdr-core", "default.sock")}`,
      bin ?? "",
      "attach",
      "t1",
    ]);
    // A person's terminal with other runtime and state folders, a socket override and another
    // session still reaches the agents' core.
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

describe.skipIf(!bin)("workspaces in herdr's app", () => {
  // The app's layout, the hc document it keeps its workspaces in.
  const Layout = z.object({
    spaces: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        tabs: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            root: z.object({
              children: z.array(z.object({ content: z.object({ terminal: z.string() }) })),
            }),
          }),
        ),
      }),
    ),
  });
  const layout = async () =>
    Layout.parse(
      z.object({ value: z.unknown() }).parse(await rpc("doc.get", { name: "herdr-app" })).value ?? {
        spaces: [],
      },
    );
  const placed = { repository: "simon/placed" };
  const start = (name: string, labels: host.Labels) =>
    startSession({ name, command: ["sleep", "30"], folder: scratch, env: {}, labels });

  test("each session gets a tab in its repository's workspace, the lead's first", async () => {
    // A workspace of the person's own, with what a later app may add, which stays as it is.
    const { version } = z
      .object({ version: z.number() })
      .parse(await rpc("doc.get", { name: "herdr-app" }));
    const own = { id: "spown", name: "", folder: "/home/a", tabs: [], color: "blue" };
    const kept = { spaces: [...(await layout()).spaces, own], theme: "dark" };
    await rpc("doc.set", { name: "herdr-app", value: kept, version });
    // The short title Skelcrew shows for a thread, when it has one, else its number.
    const builder = await start("placed-1", {
      ...placed,
      role: "builder",
      task: "placed-1",
      title: "Tabs for agents",
    });
    const untitled = await start("placed-2", { ...placed, role: "builder", task: "placed-2" });
    const lead = await start("lead-placed", { ...placed, role: "lead" });
    const after = await layout();
    const whole = z
      .object({ value: z.object({ theme: z.string(), spaces: z.array(z.unknown()) }) })
      .parse(await rpc("doc.get", { name: "herdr-app" }));
    expect(whole.value.theme).toBe("dark");
    expect(whole.value.spaces).toContainEqual(own);
    // The workspace is the repository's name, as its owner is the same for nearly all of them.
    const space = after.spaces.find((s) => s.name === "placed");
    expect(
      space?.tabs.map((t) => [t.name, t.root.children.map((c) => c.content.terminal)]),
    ).toEqual([
      ["lead", [lead]],
      ["Tabs for agents", [builder]],
      ["2", [untitled]],
    ]);
    // hc ls says where each one is, as for a terminal the app placed itself.
    const ls = Bun.spawnSync([bin ?? "hc", "ls", "--json"], { env: process.env });
    const listed = z
      .object({
        terminals: z.array(z.object({ address: z.string(), where: z.string().optional() })),
      })
      .parse(JSON.parse(ls.stdout.toString())).terminals;
    expect(listed).toContainEqual({ address: builder, where: "placed / Tabs for agents" });
    expect(listed).toContainEqual({ address: untitled, where: "placed / 2" });
    expect(listed).toContainEqual({ address: lead, where: "placed / lead" });
    // Ending a session closes its tab.
    await host.end({ id: builder });
    const ended = (await layout()).spaces.find((s) => s.name === "placed");
    expect(ended?.tabs.map((t) => t.name)).toEqual(["lead", "2"]);
  }, 20_000);
});

describe.skipIf(!bin)("sessions an older version started", () => {
  // Version 0.1.0 ran its agents on a core of its own, the hc session `skelcrew`. This starts
  // a terminal there as 0.1.0 labelled it, running `sleep`, and returns its address and pid.
  const olderEnv = () => ({ ...process.env, HC_SESSION: "skelcrew" });
  // Starts `sleep` in a terminal through hc on the core `env` reaches, with `labels`, and returns
  // its address and pid.
  function hcRun(env: Record<string, string | undefined>, labels: string[]) {
    const json = (args: string[]) =>
      JSON.parse(Bun.spawnSync([bin ?? "hc", ...args], { env }).stdout.toString());
    const flags = labels.flatMap((label) => ["--label", label]);
    const { address } = z
      .object({ address: z.string() })
      .parse(
        json([
          "run",
          "--bg",
          "--json",
          "--no-parent",
          "--cwd",
          scratch,
          ...flags,
          "--",
          "sleep",
          "300",
        ]),
      );
    const { pid } = z.object({ pid: z.number() }).parse(json(["get", address, "--json"]));
    return { address, pid };
  }
  // A terminal on that core as 0.1.0 labelled it.
  const startOlder = (name: string) =>
    hcRun(olderEnv(), ["repo=simon/app", "role=builder", `name=${name}`, "by=skelcrew"]);
  // Addresses count up on each core, so one there can be one of Skelcrew's running here too.
  const runningHere = async () =>
    new Set((await host.list()).sessions.filter((s) => s.running).map((s) => s.id));
  // A terminal on that core whose address no running session on the default core has.
  async function startOlderAlone(name: string) {
    const taken = await runningHere();
    while (true) {
      const older = startOlder(name);
      if (!taken.has(older.address)) return older;
    }
  }
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  afterAll(() => {
    Bun.spawnSync([bin ?? "hc", "server", "stop", "--json"], { env: olderEnv(), stdout: "ignore" });
  });

  test("list finds them, and end stops them", async () => {
    const older = await startOlderAlone("app-7");
    const { sessions } = await host.list();
    expect(sessions).toContainEqual({
      id: older.address,
      running: true,
      labels: { repository: "simon/app", role: "builder" },
    });
    expect(await host.end({ id: older.address })).toEqual({});
    for (let i = 0; i < 50 && alive(older.pid); i++) await Bun.sleep(20);
    expect(alive(older.pid)).toBe(false);
  }, 15_000);

  test("a call to an address both cores run an agent at fails, and ends neither", async () => {
    const here = await startAgent();
    let older = startOlder("app-8");
    while (older.address !== here) older = startOlder("app-8");
    await expect(host.end({ id: here })).rejects.toThrow("on both hc sessions");
    expect(alive(older.pid)).toBe(true);
    expect((await host.list()).sessions.filter((s) => s.id === here && s.running)).toHaveLength(2);
  }, 30_000);

  test("end leaves alone a terminal at that address that isn't Skelcrew's", async () => {
    // A person's own shell on the default core.
    const own = hcRun(process.env, []);
    try {
      await host.end({ id: own.address });
      expect(alive(own.pid)).toBe(true);
    } finally {
      await rpc("terminal.kill", { terminal: own.address });
    }
  }, 15_000);
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

  test("herdr shows the harness Skelcrew runs, however deep in the command it is", async () => {
    // A stand-in for the harness, under the name Skelcrew starts it by, behind a sandbox.
    const harness = join(scratch, "bin", "claude");
    mkdirSync(dirname(harness), { recursive: true });
    writeFileSync(harness, "#!/bin/sh\nexec sleep 30\n");
    chmodSync(harness, 0o755);
    const session = await startSession({
      name: "shows-claude",
      command: ["/usr/bin/env", "--", harness, "--model", "x"],
      folder: scratch,
      env: {},
      labels: { repository: "simon/app", role: "builder" },
    });
    // The relay listens once it has started.
    const { labels } = (await rpc("terminal.get", { terminal: session })) as {
      labels: { relay: string };
    };
    const socket = join(`/tmp/skelcrew-herdr-${process.getuid?.()}`, `${labels.relay}.sock`);
    for (let i = 0; i < 100 && !existsSync(socket); i++) await Bun.sleep(20);
    await host.status({ id: session, status: "working", reason: "" });
    const ls = Bun.spawnSync([bin ?? "hc", "ls", "--json"], { env: process.env });
    const listed = z
      .object({ terminals: z.array(z.object({ address: z.string(), agent: z.string() })) })
      .parse(JSON.parse(ls.stdout.toString())).terminals;
    expect(listed).toContainEqual({ address: session, agent: "claude" });
  }, 15_000);

  test("the relay writes only a report's fields to the terminal", async () => {
    const session = await startAgent();
    const record = (await rpc("terminal.get", { terminal: session })) as {
      labels: { relay: string };
    };
    const socket = join(`/tmp/skelcrew-herdr-${process.getuid?.()}`, `${record.labels.relay}.sock`);
    const send = (text: string) =>
      new Promise<string>((resolve, reject) => {
        let said = "";
        Bun.connect({
          unix: socket,
          socket: {
            open: (conn) => void conn.write(text),
            data: (_conn, bytes) => {
              said += new TextDecoder().decode(bytes);
            },
            close: () => resolve(said),
            connectError: (_conn, error) => reject(error),
          },
        });
      });
    expect(await send("state=x\x1b]0;title\n")).toBe("refused\n");
    expect(await statusOf(session)).toBeNull();
    expect(await send("state=working\n")).toBe("ok\n");
    for (let i = 0; i < 50 && (await statusOf(session)) !== "working"; i++) await Bun.sleep(20);
    expect(await statusOf(session)).toBe("working");
  }, 15_000);

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
    try {
      person.type("\x02draft");
      await Bun.sleep(3000);
      expect(host.notReady(await screen(session), marks)).toBe("");
      await expect(
        host.deliver({ id: session, text: "ONTOP", marks, timeout: 1500 }),
      ).rejects.toThrow("a person's typing at its prompt held it");
      await Bun.sleep(500);
      expect(await screen(session)).not.toContain("ONTOP");
      person.type("\x15");
      expect(await host.deliver({ id: session, text: "cleared", marks, timeout: 5000 })).toEqual(
        {},
      );
      const shown = await screenShows(session, "got: cleared");
      expect(shown).not.toContain("draftONTOP");
    } finally {
      await person.detach();
    }
  }, 40_000);

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
    // An hc whose core start takes two seconds, as on a slow or busy machine.
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

// A small screenshot an image viewer opens: a `width` by `height` PNG, 8-bit RGB, with a
// gradient, each chunk with its CRC and the pixels deflated as the format requires.
function validPng(width: number, height: number) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Uint8Array) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "latin1");
    out.set(data, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  // Each row starts with filter type 0, then its pixels' red, green and blue.
  const rows = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) rows.set([x * 4, y * 5, 128], y * (1 + width * 3) + 1 + x * 3);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return new Uint8Array(
    Buffer.concat([
      signature,
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(rows)),
      chunk("IEND", new Uint8Array()),
    ]),
  );
}

// A small PDF a reader opens, showing `text` on one page: its cross-reference table gives each
// object's true byte offset, as the format requires.
function validPdf(text: string) {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, i) => {
    const at = body.length;
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return at;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) body += `${String(at).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

// Files a person drops into a session in herdr: hc puts each in the terminal's own files folder
// and types its path to the agent, so the agent's sandbox must show that folder, and no other.
describe.skipIf(!bin)("files dropped into a session", () => {
  // A drop as herdr's apps make it: the file's bytes, put beside the terminal.
  const drop = async (id: string, name: string, bytes: Uint8Array) =>
    z.object({ path: z.string(), bytes: z.number() }).parse(
      await rpc("terminal.put", {
        terminal: id,
        name,
        data: Buffer.from(bytes).toString("base64"),
      }),
    );
  // The marker Skelcrew puts in the command where the session's files folder goes.
  const marker = () => `/skelcrew-files-${randomBytes(16).toString("hex")}`;
  // A small PDF and PNG, as a person drops them.
  const pdf = validPdf("Dropped into a session");
  const png = validPng(64, 48);

  // Starts the fake agent with the marker in its command, as the sandbox's mount would hold it.
  async function startWithFiles(name: string) {
    const files = marker();
    const session = await startSession({
      name,
      command: [process.execPath, fakeAgent, `--ro-bind=${files}`, `${files}/x`],
      folder: scratch,
      env: { PATH: "/usr/bin:/bin" },
      labels: { repository: "simon/app", role: "builder" },
      files,
    });
    const shown = await screenShows(session, "token:");
    const argv = JSON.parse(shown.match(/argv: (\[.*\])/)?.[1] ?? "[]") as string[];
    return { session, files, argv };
  }

  test("the command names the session's own files folder, made empty before anything is dropped", async () => {
    const { session, files, argv } = await startWithFiles("drops-1");
    const folder = argv[0]?.replace(/^--ro-bind=/, "") ?? "";
    expect(argv).toEqual([`--ro-bind=${folder}`, `${folder}/x`]);
    expect(argv.join(" ")).not.toContain(files);
    expect(readdirSync(folder)).toEqual([]);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    // hc puts a drop there: a PDF whose name has spaces, its bytes as they were.
    const put = await drop(session, "Quarterly report 2026.pdf", pdf);
    expect(dirname(put.path)).toBe(folder);
    expect(basename(put.path)).not.toContain(" ");
    expect(new Uint8Array(readFileSync(put.path))).toEqual(pdf);
    // And removes the folder with the session.
    await host.end({ id: session });
    expect(existsSync(folder)).toBe(false);
  }, 15_000);

  // The marker is only a word in the command, never a path on the host: the relay puts the real
  // folder in its place, and makes it, before the command runs, so a sandbox started by that
  // command, such as bwrap's `--ro-bind <folder> <folder>`, mounts a folder that exists, at its
  // real path. Nothing is swapped once the command runs: what hc saves later lands in the very
  // folder the command was given.
  test("the marker never exists on the host, and the command starts with a real folder in its place", async () => {
    const files = marker();
    // The command's side, as bwrap would see its mount: whether its source exists as it starts,
    // and later, each file found there, by the path it was given at the start.
    const script =
      'if [ -d "$1" ]; then echo "folder at start: $1"; fi; echo ready;' +
      ' while read -r name; do [ -f "$1/$name" ] && echo "found: $name"; done';
    const session = await startSession({
      name: "drops-marker",
      command: ["sh", "-c", script, "sh", files],
      folder: scratch,
      env: { PATH: "/usr/bin:/bin" },
      labels: { repository: "simon/app", role: "builder" },
      files,
    });
    const shown = await screenShows(session, "ready");
    const folder = shown.match(/folder at start: (\S+)/)?.[1] ?? "";
    expect(folder).not.toBe("");
    expect(folder).not.toContain("skelcrew-files-");
    expect(existsSync(files)).toBe(false);
    // A drop after the command started lands where the command already looks.
    const put = await drop(session, "Later drop.png", png);
    expect(dirname(put.path)).toBe(folder);
    await rpc("terminal.send", { terminal: session, text: basename(put.path) });
    await screenShows(session, `found: ${basename(put.path)}`);
  }, 15_000);

  test("each session's drops land in its own folder, never another's", async () => {
    const one = await startWithFiles("drops-2");
    const two = await startWithFiles("drops-3");
    const first = await drop(one.session, "Screenshot 2026-11-19 at 20.14.53.png", png);
    const second = await drop(two.session, "Screenshot 2026-11-19 at 20.14.53.png", png);
    expect(dirname(first.path)).not.toBe(dirname(second.path));
    expect(readdirSync(dirname(first.path))).toEqual([basename(first.path)]);
    expect(readdirSync(dirname(second.path))).toEqual([basename(second.path)]);
  }, 15_000);

  test("start refuses a marker that isn't Skelcrew's", async () => {
    for (const files of ["/home", "/skelcrew-files-x", `/skelcrew-files-${"a".repeat(32)}/..`])
      await expect(
        answer({
          ask: "start",
          name: "app-1",
          command: ["sleep", "30"],
          folder: scratch,
          env: {},
          labels: { repository: "simon/app", role: "builder" },
          files,
        }),
      ).rejects.toThrow();
  });

  // A sandbox that hides the core's state, as Skelcrew's hides the home folder that holds it,
  // and shows the session's files folder read-only at the marker's place. bubblewrap needs
  // namespaces a user may make, which some machines and CI runners don't allow.
  const bwrap = Bun.which("bwrap");
  const nests = !!bwrap && Bun.spawnSync([bwrap, "--ro-bind", "/", "/", "true"]).exitCode === 0;
  test.skipIf(!nests)(
    "a sandboxed agent reads its own drops, and sees no other session's",
    async () => {
      const other = await startWithFiles("drops-4");
      const theirs = await drop(other.session, "theirs.png", png);
      const files = marker();
      const state = join(scratch, "state");
      // The agent's side: it reads each file whose path is typed to it, as herdr types a drop's,
      // whole, and shows its checksum, then tries the other session's folder and to write beside
      // the drop. Each answer goes on a line of its own, numbered by the drop.
      const script =
        'echo ready; n=0; while read -r path; do n=$((n+1)); sum=$(sha256sum < "$path" | cut -c1-64) &&' +
        ' echo "read $n: $sum"; ls "$1" >/dev/null 2>&1 || echo "hidden $n"; touch "$path.new" 2>/dev/null ||' +
        ' echo "read-only $n"; done';
      const session = await startSession({
        name: "drops-5",
        command: [
          ...[bwrap ?? "bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"],
          ...["--tmpfs", state, "--ro-bind", files, files, "--", "sh", "-c", script, "sh"],
          dirname(theirs.path),
        ],
        folder: scratch,
        env: { PATH: "/usr/bin:/bin" },
        labels: { repository: "simon/app", role: "builder" },
        files,
      });
      await screenShows(session, "ready");
      const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
      // A screenshot and a valid PDF, both with spaces in their names, as a person drops them.
      const drops: [string, Uint8Array][] = [
        ["My screenshot.png", png],
        ["Quarterly report 2026.pdf", pdf],
      ];
      for (const [n, [name, bytes]] of drops.entries()) {
        const ours = await drop(session, name, bytes);
        await rpc("terminal.send", { terminal: session, text: ours.path });
        const shown = await screenShows(session, `read-only ${n + 1}`);
        expect(shown).toContain(`read ${n + 1}: ${sha(bytes)}`);
        expect(shown).toContain(`hidden ${n + 1}`);
      }
    },
    20_000,
  );
});

test("fieldsFor encodes a status the way hc reads it", () => {
  expect(host.fieldsFor("needs you", "question")).toBe(
    "state=blocked:kind=question:msg=cXVlc3Rpb24=",
  );
  expect(host.fieldsFor("ready", "")).toBe("state=done");
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
