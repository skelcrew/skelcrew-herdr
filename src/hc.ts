// Runs herdr-core's CLI, `hc`, and returns its JSON answer. Every hc command is one API call,
// and with --json it prints that call's result, or `{"error": {kind, message, hint}}` and a
// non-zero exit. HC_BIN names the binary, `hc` by default.
//
// Skelcrew's agents run on the person's own hc core, the one hc and herdr's apps reach when no
// session is chosen, so they are terminals a person sees and attaches to there. That core reads
// the person's config.toml, so how long a draft holds a delivery, and the detach key, are theirs.
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
// The hc sessions, each a core of its own, that hold Skelcrew's agents: hc's own session when
// none is chosen, the one herdr's apps show, where agents start; and `skelcrew`, where version
// 0.1.0 of this plugin started them, which may still run some.
export type Core = "default" | "skelcrew";
export const cores: Core[] = ["default", "skelcrew"];

// The socket the person's default core listens on, found as hc 0.1.21 finds it on Linux and a
// Mac: in the user's runtime folder (XDG_RUNTIME_DIR, else /run/user/<uid> when it exists), else
// in the session's state folder, named for the session.
export function coreSocket(session: Core = "default"): string {
  const user = `/run/user/${process.getuid?.()}`;
  const run =
    process.env.XDG_RUNTIME_DIR ||
    (existsSync(user) && statSync(user).isDirectory() ? user : undefined);
  const state = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  const folder = run ? join(run, "herdr-core") : join(state, "herdr-core", session);
  return join(folder, `${session}.sock`);
}

// The environment for hc, reaching the core `session`, the person's default one unless given. Inside an hc terminal, hc takes
// HC_TERMINAL_ID as the caller, so a session started from there would become that terminal's
// child and end with it, and a message sent from there would be marked as from it. Skelcrew's
// engine is nobody's child, so both go. HC_SCOPE marks processes for hc's cleanup of an ended
// terminal, which the engine isn't either, and the caller's HC_SOCKET and HC_SESSION would lead
// to another core.
export function hcEnv(session: Core = "default"): Record<string, string | undefined> {
  const {
    HC_TERMINAL_ID: _id,
    HC_SCOPE: _scope,
    HC_SOCKET: _socket,
    HC_SESSION: _session,
    ...env
  } = process.env;
  return session === "default" ? env : { ...env, HC_SESSION: session };
}

// What the core's own environment keeps from this process's, when this program is the one that
// starts it. The core hands its environment to every terminal, a person's shells too, so a token
// Skelcrew has must not reach it. start replaces it for an agent anyway. HC_QUIET_MS
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
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  "HC_QUIET_MS",
  "HC_STARTED_MS",
];

// Starts the person's default core if none runs, with only the environment it needs. One already
// running is used as it is, whoever started it.
export async function ensureCore(): Promise<void> {
  const env = Object.fromEntries(
    coreKeeps.flatMap((k) => (process.env[k] ? [[k, process.env[k]]] : [])),
  );
  await run(["server", "start"], 30_000, env);
}

// Stops the default core, which ends every terminal on it. Only the tests use it.
export async function stopCore(): Promise<void> {
  await run(["server", "stop"], 30_000, hcEnv("default"));
}

// Runs `hc <command> --json <args>` and returns its parsed answer, only for the server commands,
// which the API doesn't have. Throws HcError with hc's kind when hc reports an error, and with
// kind `timeout` when it runs longer than `timeout` milliseconds, after ending it.
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

// Calls one API method over `hc connect` on the core `session`, the person's default one unless
// given, and returns its result.
// The CLI is one call per command, but a send needs the connection: it can be given up on with
// `$/cancelRequest`, which hc honours only while the send is still held, before typing: once it
// typed, the send finishes. So at `deadline`, a time in milliseconds since the epoch, this asks
// to cancel, and the answer says for certain whether the text went in: kind `cancelled` when
// not. A killed CLI can't tell that apart from a send that typed and then watched for a turn.
// Starting the core and connecting take time too, so the deadline is looked at
// again just before the call goes, and a call whose time ran out meanwhile is never sent: kind
// `late`.
// Cancelling with an answer needs framed mode, so the connection switches to it first: each
// frame is its channel (u32), kind (u8, 0 for data) and length (u32), little-endian, then the
// JSON-RPC message, on channel 0.
export async function rpc(
  method: string,
  params: object,
  deadline?: number,
  session: Core = "default",
): Promise<unknown> {
  // Only the default core is started when none runs. Any hc command on another session would
  // start one there, and the older session must end once its last agent does.
  if (session === "default") await ensureCore();
  else if (!existsSync(coreSocket(session)))
    throw new HcError("not_found", `no hc core runs on session ${session}`);
  const child = Bun.spawn([hcBin(), "connect"], {
    env: hcEnv(session),
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
        if (deadline !== undefined && Date.now() >= deadline)
          throw new HcError("late", `${method} wasn't sent: its time ran out`);
        frame({ id: 1, method, params });
        if (deadline !== undefined)
          timer = setTimeout(
            () => frame({ method: "$/cancelRequest", params: { id: 1 } }),
            deadline - Date.now(),
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
