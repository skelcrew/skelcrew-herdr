// The status relay: the program hc runs in each agent's terminal, around the sandboxed command.
// herdr-core takes status only from OSC 7501 in a terminal's output, and the engine, outside the
// terminal, can't write there. So the relay runs the command as its child on the same terminal,
// untouched, and writes OSC 7501 into that terminal whenever `status` hands it one over its
// socket. It runs outside the sandbox, as the plugin does.
//
// Usage: bun src/relay.ts <socket> -- <command...>
import { rmSync, writeSync } from "node:fs";
import { constants } from "node:os";

const [socket, dashes, ...command] = process.argv.slice(2);
if (!socket || dashes !== "--" || command.length === 0) {
  process.stderr.write("usage: relay.ts <socket> -- <command...>\n");
  process.exit(2);
}

// Each connection carries one report: the OSC 7501 fields, such as `state=idle`, on one line.
// They are written to the terminal in a single write, which the terminal keeps whole between two
// of the agent's own writes, and `ok` goes back once it is written. Fields with anything but
// letters, digits and `=:+/` are refused, so nothing else can reach the terminal this way.
const server = Bun.listen<{ text: string }>({
  unix: socket,
  socket: {
    open(conn) {
      conn.data = { text: "" };
    },
    data(conn, bytes) {
      conn.data.text += new TextDecoder().decode(bytes);
      const end = conn.data.text.indexOf("\n");
      if (end < 0) return;
      const fields = conn.data.text.slice(0, end);
      if (!/^[A-Za-z0-9=:+/]+$/.test(fields)) {
        conn.end("refused\n");
        return;
      }
      writeSync(1, `\x1b]7501;${fields}\x1b\\`);
      conn.end("ok\n");
    },
  },
});

// The agent shares this terminal directly, so its keys, resizes and screen pass through
// untouched, with no terminal in between. It is in the relay's process group, which hc signals
// as a whole. The sandbox may start a group of its own, so the hangup and terminate that end a
// terminal are passed on to it too. Ctrl-C, Ctrl-\ and Ctrl-Z are the agent's, never the relay's.
const child = Bun.spawn(command, { stdio: ["inherit", "inherit", "inherit"] });
for (const signal of ["SIGHUP", "SIGTERM"] as const)
  process.on(signal, () => {
    try {
      child.kill(signal);
    } catch {}
  });
for (const signal of ["SIGINT", "SIGQUIT", "SIGTSTP"] as const) process.on(signal, () => {});

// The relay ends with its agent, with the agent's exit code, so hc records how the agent ended.
// One killed by a signal exits as a shell reports it, 128 plus the signal's number.
const code = await child.exited;
server.stop(true);
rmSync(socket, { force: true });
const signal = child.signalCode;
if (signal === null) process.exit(code);
process.exit(128 + (typeof signal === "number" ? signal : constants.signals[signal]));
