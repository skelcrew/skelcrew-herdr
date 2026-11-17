// A fake agent for the tests: it shows what it was started with, then a prompt that echoes what
// is typed. Enter shows the line as `got: <line>`, Esc shows `interrupted`, ctrl+u clears the
// line. It reports no status of its own, as Skelcrew's agents don't: status comes from the host.
const write = (text: string) => process.stdout.write(text);
write(`argv: ${JSON.stringify(process.argv.slice(2))}\r\n`);
write(`cwd: ${process.cwd()}\r\n`);
write(`env: ${JSON.stringify(Object.keys(process.env).sort())}\r\n`);
write(`token: ${process.env.FAKE_TOKEN ?? ""}\r\n> `);

let line = "";
process.stdin.setRawMode(true);
process.stdin.on("data", (chunk: Buffer) => {
  for (const byte of chunk) {
    if (byte === 13) {
      write(`\r\ngot: ${line}\r\n> `);
      line = "";
    } else if (byte === 27) write("\r\ninterrupted\r\n> ");
    else if (byte === 21) {
      write(`\r\x1b[K> `);
      line = "";
    } else if (byte >= 32) {
      line += String.fromCharCode(byte);
      write(String.fromCharCode(byte));
    }
  }
});
