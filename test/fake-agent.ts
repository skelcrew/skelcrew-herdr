// A fake agent for the tests: it shows what it was started with, then a prompt that echoes what
// is typed. Enter shows the line as `got: <line>`, Esc shows `interrupted`, ctrl+u clears the
// line. ctrl+b stops showing what is typed, so a draft can be there while the prompt looks bare,
// as hc sees it from the keys but the screen doesn't. ctrl+t starts or stops a busy line at the
// top of the screen, which counts seconds as a harness's does while a turn runs, so it redraws
// only once a second. It reports no status
// of its own, as Skelcrew's agents don't: status comes from the host.
const write = (text: string) => process.stdout.write(text);
write(`argv: ${JSON.stringify(process.argv.slice(2))}\r\n`);
write(`cwd: ${process.cwd()}\r\n`);
write(`pid: ${process.pid}\r\n`);
write(`env: ${JSON.stringify(Object.keys(process.env).sort())}\r\n`);
const { TERM, COLORTERM, TERM_PROGRAM } = process.env;
write(`terminal: ${JSON.stringify([TERM, COLORTERM, TERM_PROGRAM])}\r\n`);
write(`token: ${process.env.FAKE_TOKEN ?? ""}\r\n> `);

let line = "";
let hidden = false;
let busy: Timer | undefined;
let ticks = 0;
// Draws the busy line on the top row, then puts the cursor back where it was.
const tick = () => write(`\x1b7\x1b[1;1H\x1b[K* working ${ticks++}s (esc to interrupt)\x1b8`);
process.stdin.setRawMode(true);
process.stdin.on("data", (chunk: Buffer) => {
  for (const byte of chunk) {
    if (byte === 13) {
      write(`\r\ngot: ${line}\r\n> `);
      line = "";
      hidden = false;
    } else if (byte === 27) write("\r\ninterrupted\r\n> ");
    else if (byte === 21) {
      write(`\r\x1b[K> `);
      line = "";
      hidden = false;
    } else if (byte === 2) hidden = true;
    else if (byte === 20) {
      clearInterval(busy);
      busy = busy ? undefined : setInterval(tick, 1000);
      if (busy) tick();
      if (!busy) write("\x1b7\x1b[1;1H\x1b[K\x1b8");
    } else if (byte >= 32) {
      line += String.fromCharCode(byte);
      if (!hidden) write(String.fromCharCode(byte));
    }
  }
});
