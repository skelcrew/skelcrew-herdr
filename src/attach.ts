// The attach command Skelcrew runs in your terminal: `bun src/attach.ts <id>` puts your terminal
// full screen on that session, through hc attach on hc's default core, and returns when you detach
// with your hc detach key. It exits with hc attach's own code, so Skelcrew sees a failed attach as failed.
import { attachCommand } from "./host.ts";

try {
  const argv = await attachCommand(process.argv[2] ?? "");
  const child = Bun.spawn(argv, { stdio: ["inherit", "inherit", "inherit"] });
  process.exit(await child.exited);
} catch (error) {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
}
