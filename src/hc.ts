// Runs herdr-core's CLI, `hc`, and returns its JSON answer. Every hc command is one API call,
// and with --json it prints that call's result, or `{"error": {kind, message, hint}}` and a
// non-zero exit. HC_BIN names the binary, `hc` by default.
//
// Skelcrew's agents run on an hc core of their own: the hc session SKELCREW_HC_SESSION,
// `skelcrew` by default, as they run on a tmux server of Skelcrew's own. That core reads a config
// file this program writes, so its settings are known rather than read from a person's
// config.toml: no notes typed by hc on its own, and a draft hold with no end in practice. hc's
// own hold ends `draft_wait` after a person's last key, and then hc types on top of the draft.
// Nothing outside hc can see a draft the screen doesn't show, so only a hold that never ends
// keeps every draft safe.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// An error hc reported, with its stable kind, such as `not_found` or `status_mismatch`.
export class HcError extends Error {
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message);
  }
}

export const hcBin = () => process.env.HC_BIN || "hc";
export const hcSession = () => process.env.SKELCREW_HC_SESSION || "skelcrew";

// Where this program keeps its own files: SKELCREW_HERDR_HOME, else skelcrew-herdr in the XDG
// state folder. The core's config home is a folder in it.
function configHome(): string {
  const state = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(process.env.SKELCREW_HERDR_HOME || join(state, "skelcrew-herdr"), "config");
}

// The core's config.toml. draft_wait is in seconds, and a billion is over 31 years.
export const coreConfig = `# Written by skelcrew-herdr for its own hc core. Changes here are overwritten.
notes = false
draft_wait = 1000000000
`;

// The environment for hc, on Skelcrew's session with its config home, which is also where hc
// reads a socket setting. Inside an hc terminal, hc takes HC_TERMINAL_ID as the caller, so a
// session started from there would become that terminal's child and end with it, and a message
// sent from there would be marked as from it. Skelcrew's engine is nobody's child, so both go.
// HC_SCOPE marks processes for hc's cleanup of an ended terminal, which the engine isn't either,
// and HC_SOCKET would lead to another core.
export function hcEnv(): Record<string, string | undefined> {
  const { HC_TERMINAL_ID: _id, HC_SCOPE: _scope, HC_SOCKET: _socket, ...env } = process.env;
  return { ...env, HC_SESSION: hcSession(), XDG_CONFIG_HOME: configHome() };
}

// What the core's own environment keeps from this process's. The core hands its environment to
// every terminal, and though start replaces it for an agent, nothing else needs more. HC_QUIET_MS
// and HC_STARTED_MS are hc's timing knobs, which tests shorten.
const coreKeeps = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  "HC_QUIET_MS",
  "HC_STARTED_MS",
];

// Starts Skelcrew's core with its config, once per process and session, or finds it running,
// and checks that it reads that config: a core started some other way, such as by any hc command
// run on this session, which starts one if none runs, reads the person's config.toml instead.
const cores = new Map<string, Promise<void>>();
export function ensureCore(): Promise<void> {
  const session = hcSession();
  let ready = cores.get(session);
  if (!ready) {
    ready = startCore();
    cores.set(session, ready);
    ready.catch(() => cores.delete(session));
  }
  return ready;
}

async function startCore(): Promise<void> {
  const home = configHome();
  const file = join(home, "herdr-core", "config.toml");
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  let written = "";
  try {
    written = readFileSync(file, "utf8");
  } catch {}
  if (written !== coreConfig) writeFileSync(file, coreConfig, { mode: 0o600 });
  const env = Object.fromEntries(
    coreKeeps.flatMap((k) => (process.env[k] ? [[k, process.env[k]]] : [])),
  );
  const status = (await run(["server", "start"], 30_000, {
    ...env,
    HC_SESSION: hcSession(),
    XDG_CONFIG_HOME: home,
  })) as { pid?: number };
  const pid = status.pid;
  const reads = pid ? envOf(pid, "XDG_CONFIG_HOME") : undefined;
  if (reads !== home)
    throw new HcError(
      "config",
      `the hc core for session ${hcSession()} (pid ${pid}) wasn't started by skelcrew-herdr, so ` +
        `it could type onto a person's draft. Stop it with HC_SESSION=${hcSession()} hc server stop`,
    );
}

// Returns one variable of a process's environment: from /proc on Linux, and from ps on a Mac,
// which prints a process's environment after its command. Undefined when it can't be read.
function envOf(pid: number, key: string): string | undefined {
  try {
    const vars = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
    return vars.find((v) => v.startsWith(`${key}=`))?.slice(key.length + 1);
  } catch {}
  const ps = Bun.spawnSync(["ps", "-wwE", "-o", "command=", "-p", String(pid)], { stdout: "pipe" });
  return ps.stdout.toString().match(new RegExp(` ${key}=(\\S*)`))?.[1];
}

// Runs `hc <command> --json <args>` on Skelcrew's core and returns its parsed answer. Throws
// HcError with hc's kind when hc reports an error, and with kind `timeout` when it runs longer
// than `timeout` milliseconds, after ending it.
export async function hc(args: string[], timeout = 30_000): Promise<unknown> {
  await ensureCore();
  return run(args, timeout, hcEnv());
}

async function run(
  args: string[],
  timeout: number,
  env: Record<string, string | undefined>,
): Promise<unknown> {
  // --json goes before the arguments, as a program's own arguments follow `--` at the end.
  const child = Bun.spawn([hcBin(), ...args.slice(0, 1), "--json", ...args.slice(1)], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeout);
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  if (timedOut) throw new HcError("timeout", `hc ${args[0]} took over ${timeout / 1000}s`);
  const answer = parse(out) ?? parse(err);
  const error = (answer as { error?: { kind?: string; message?: string } } | null)?.error;
  if (code !== 0 || error)
    throw new HcError(
      error?.kind ?? "failed",
      error?.message ?? (err.trim() || `hc ${args[0]} exited with code ${code}`),
    );
  return answer;
}

// Parses hc's JSON output, or returns null for empty or other output.
function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Calls one API method over `hc connect`, for what the CLI can't do. `hc ls` prints a short form
// of each terminal, without its labels, where `terminal.list` gives the whole record. And a send
// can be given up on with `$/cancelRequest`, which hc honours only while the send is still held,
// before typing: once it typed, the send finishes. So after `cancelAfter` milliseconds this asks
// to cancel, and the answer says for certain whether the text went in: kind `cancelled` when
// not. A killed CLI can't tell that apart from a send that typed and then watched for a turn.
// Cancelling with an answer needs framed mode, so the connection switches to it first: each
// frame is its channel (u32), kind (u8, 0 for data) and length (u32), little-endian, then the
// JSON-RPC message, on channel 0.
export async function rpc(method: string, params: object, cancelAfter?: number): Promise<unknown> {
  await ensureCore();
  const child = Bun.spawn([hcBin(), "connect"], {
    env: hcEnv(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const send = (bytes: Uint8Array | string) => {
    child.stdin.write(bytes);
    child.stdin.flush();
  };
  const frame = (message: object) => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }));
    const head = Buffer.alloc(9);
    head.writeUInt32LE(body.length, 5);
    send(Buffer.concat([head, body]));
  };
  send(`${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "hello", params: { framed: true } })}\n`);
  let timer: Timer | undefined;
  try {
    let buffer = Buffer.alloc(0);
    let framed = false;
    for await (const chunk of child.stdout) {
      buffer = Buffer.concat([buffer, chunk]);
      if (!framed) {
        const end = buffer.indexOf("\n");
        if (end < 0) continue;
        reply(JSON.parse(buffer.subarray(0, end).toString()), "hello");
        buffer = buffer.subarray(end + 1);
        framed = true;
        frame({ id: 1, method, params });
        if (cancelAfter !== undefined)
          timer = setTimeout(
            () => frame({ method: "$/cancelRequest", params: { id: 1 } }),
            cancelAfter,
          );
      }
      while (buffer.length >= 9 && buffer.length >= 9 + buffer.readUInt32LE(5)) {
        const [channel, kind, length] = [buffer.readUInt32LE(0), buffer[4], buffer.readUInt32LE(5)];
        const payload = buffer.subarray(9, 9 + length);
        buffer = buffer.subarray(9 + length);
        if (channel !== 0 || kind !== 0) continue;
        const message = JSON.parse(payload.toString());
        if (message.id === 1) return reply(message, method);
      }
    }
    const err = await new Response(child.stderr).text();
    throw new HcError("failed", err.trim() || `hc connect gave no answer to ${method}`);
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    child.kill();
  }
}

// Returns a JSON-RPC reply's result, or throws its error with hc's kind.
function reply(
  message: {
    result?: unknown;
    error?: { message?: string; data?: { kind?: string } };
  },
  method: string,
): unknown {
  if (message.error)
    throw new HcError(message.error.data?.kind ?? "failed", message.error.message ?? method);
  return message.result;
}

// Splits a stream into lines as they arrive.
export async function* lines(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let rest = "";
  for await (const chunk of stream) {
    rest += decoder.decode(chunk, { stream: true });
    const parts = rest.split("\n");
    rest = parts.pop() ?? "";
    for (const part of parts) if (part.trim()) yield part;
  }
}
