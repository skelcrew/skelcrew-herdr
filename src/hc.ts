// Runs herdr-core's CLI, `hc`, and returns its JSON answer. Every hc command is one API call,
// and with --json it prints that call's result, or `{"error": {kind, message, hint}}` and a
// non-zero exit. Which core it reaches is hc's own business: HC_SESSION, HC_SOCKET and the XDG
// folders pass through from this process's environment. HC_BIN names the binary, `hc` by default.

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

// The environment for hc. Inside an hc terminal, hc takes HC_TERMINAL_ID as the caller, so a
// session started from there would become that terminal's child and end with it, and a message
// sent from there would be marked as from it. Skelcrew's engine is nobody's child, so both go.
// HC_SCOPE marks processes for hc's cleanup of an ended terminal, which the engine isn't either.
export function hcEnv(): Record<string, string | undefined> {
  const { HC_TERMINAL_ID: _id, HC_SCOPE: _scope, ...env } = process.env;
  return env;
}

// Runs `hc <command> --json <args>` and returns its parsed answer. Throws HcError with hc's kind when hc
// reports an error, and with kind `timeout` when it runs longer than `timeout` milliseconds,
// after ending it.
export async function hc(args: string[], timeout = 30_000): Promise<unknown> {
  // --json goes before the arguments, as a program's own arguments follow `--` at the end.
  const child = Bun.spawn([hcBin(), ...args.slice(0, 1), "--json", ...args.slice(1)], {
    env: hcEnv(),
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
