// Holds a session's lock, as a caller in the middle of a status report does, until it is
// killed. Says `held` once it has it. The session is its argument.
import { locked } from "../src/host.ts";

await locked(process.argv[2] ?? "", async () => {
  console.log("held");
  await new Promise(() => {});
});
