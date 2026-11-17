# skelcrew-herdr

A prototype of Skelcrew's sessions, transport and status on [herdr-core](https://github.com/herdrdev/herdr-core) (`hc`). It's a small standalone program that phase 5 of [Skelcrew v6](https://github.com/skelcrew/skelcrew/blob/main/docs/v6.md) can later call as a runtime plugin. There is no manifest yet, and Skelcrew doesn't call it yet.

Everything goes in and out as plain JSON. `src/call.ts` reads one question on stdin and prints one answer on stdout, the way Skelcrew asks its plugins today. An error exits 1, with its message as the last line of stderr.

```sh
echo '{"ask":"list"}' | bun src/call.ts
```

| `ask` | Takes | Answers | On hc |
| --- | --- | --- | --- |
| `start` | `session`, `argv`, `folder`, `env`, `labels` (`repo`, `role`, `task`) | `session`, `address` | `terminal.run` (`hc run --bg --no-parent --name --cwd --label`), under `env -i` |
| `list` | | `sessions`: each with `session`, `running`, `labels`, `status`, and `ended` once it has ended | `terminal.list` with the `by=skelcrew` label |
| `read` | `session`, `lines` of history | `text` | `terminal.read` (`hc read --lines`) |
| `keys` | `session`, `keys` such as `["esc"]` | | `terminal.keys` (`hc keys`) |
| `interrupt` | `session`, `timeout` | `key`, `outcome` | `terminal.interrupt` (`hc interrupt`) |
| `end` | `session` | | `terminal.kill`, then `terminal.rm` (`hc kill`, `hc rm`) |
| `attach` | `session` | `argv` for Skelcrew to run in your terminal as it is: `/usr/bin/env -u HC_SOCKET … HC_SESSION=… XDG_CONFIG_HOME=… hc attach <session>` | `hc attach` (Ctrl+\ detaches) |
| `deliver` | `session`, `text`, the harness's screen `marks` (`busy`, `prompt`), `timeout` | `delivered`, and `why` when not | `hc read`, then `terminal.send` with `if: idle`, cancelled at the deadline |
| `idle` | `session`, `timeout` | `idle`, `status`, and `ended` only when hc says the session finished or went | `terminal.get`, then `hc events --terminal` |
| `status` | `session`, `status`, `reason` | the `status` hc then shows | OSC 7501 written to the session's terminal |

`status` takes Skelcrew's words and answers in them: `working`, `idle`, `needs you`, `ready`, `error`. In OSC 7501 they become `working`, `idle`, `blocked` (with `kind=question` or `kind=permission` when that is the reason), `done` and `error`, and the reason goes in as the message.

hc is found as `HC_BIN`, or `hc` on `PATH`. `HC_TERMINAL_ID` and `HC_SCOPE` are dropped from hc's environment, so an engine running inside an hc terminal doesn't make its agents that terminal's children.

### Skelcrew's own hc core

The agents run on an hc core of their own, the hc session `skelcrew` (`SKELCREW_HC_SESSION` changes it), the way they run on Skelcrew's own tmux server today.

- **Its own config.** That core reads a config file this program writes and owns, in `$XDG_STATE_HOME/skelcrew-herdr/config/herdr-core/config.toml` (`SKELCREW_HERDR_HOME` moves the folder). It sets `notes = false` and `draft_wait = 1000000000`: a person's draft holds a send for over 31 years after their last key. It never reads the person's own `config.toml`, so nothing there can shorten the hold or have a different meaning.
- **Started and checked on every call.** Every call first runs `hc server start` on that session, with that config folder and only the environment a core needs. If a core is already running, that does nothing. The call itself then goes over `hc connect`. On that connection, `server.status` first gives the core's pid, and the call is sent only if that process's environment shows the same config folder. A connection reaches one core, so the call can only reach the core that was checked. Nothing is cached between calls, so a core stopped and replaced in between is found. A core started any other way is refused, with an error saying how to stop it. That includes one started by any hc command run on that session, which starts a core on the person's config if none runs.
- **Reaching it.** Every call here runs with `HC_SESSION` and `XDG_CONFIG_HOME` set to Skelcrew's, and without `HC_SOCKET`. `attach` answers a command that sets and unsets them itself (`env -u`), so it reaches the same core whatever the caller's environment holds.
- **For herdr's apps.** To show Skelcrew's agents, they must look at that session.

## Tests

```sh
bun install
bun run check    # biome, tsc, and bun test
```

The tests run against a real hc core. They start their own Skelcrew core, with its own session, state, config and socket folders, so they never touch the machine's own core or its terminals, and they stop it at the end. Without `hc` on `PATH` or in `HC_BIN`, they are skipped, and say why. To get hc:

```sh
curl -fsSL https://releases.herdr.dev/core/install.sh | HC_INSTALL_DIR=~/.local/bin sh
```

The installer doesn't start a core. The fake agent, `test/fake-agent.ts`, prints what it was started with, then shows a prompt that echoes what is typed. Like Skelcrew's agents, it reports no status itself. The tests cover:

- `start` with the exact argv, folder and environment
- `list` with labels, ignoring hc terminals that aren't Skelcrew's, and an agent that exited
- `read`
- `deliver` only once the agent is idle
- `deliver` to a ready agent but never into an open question, putting its status back afterwards
- a person's draft, typed through a real `hc attach`, holding a delivery, including one older than hc's `draft_wait`, one typed while the delivery waits, and one the screen doesn't show
- a report of working while a delivery is held, by a draft or by hc itself, stopping it
- `idle`
- `interrupt`
- `end`
- the status hc shows after each report

Tested with hc 0.1.21.

## herdr-core as Skelcrew's session host

**What it gives Skelcrew**

- **Sessions that outlive the engine.** Terminals outlive the client that started them, and the core keeps their records. `hc server restart` and `hc update` keep programs running. An agent that exits keeps its record and last screen until `hc rm`, with how it ended (`reason`, `exit_code`), as `remain-on-exit` does on tmux.
- **Labels, kept by the core.** `terminal.list` filters on them, so a starting engine finds its sessions again.
- **A transport with a draft check built in.** `send` holds while a person has an unsent draft, whether the screen shows it or not, for up to `draft_wait` after their last key, and `if: idle` types only if the status is still idle at that moment. Each terminal has one input queue, so two sends never interleave, nor a send and a person typing. A cancelled send is never typed.
- **Events.** `hc events` streams status, turn, finished and label changes, so `idle` waits on an event instead of polling the screen.
- **Status in herdr's apps** through OSC 7501, with a turn counter.
- **An API.** JSON-RPC over a socket or `hc connect`, described by `hc schema`. It also covers remote machines (`hc run --on box`), which Skelcrew could use later.

**What it doesn't give Skelcrew**

- **Workspaces.** hc has none, by design ("a runtime, not a multiplexer"). Repositories are grouped by the `repo` label, and herdr's app would have to group by it.
- **An environment of exactly what is given.** Every terminal gets the core's environment, and `terminal.run`'s `env` only adds to it. So `start` runs the command under `/usr/bin/env -i`, with exactly the variables given, terminal ones included. hc's own `TERM`, `COLORTERM` and `TERM_PROGRAM` (`xterm-256color`, `truecolor`, `ghostty`) reach the agent only when Skelcrew passes them. On tmux, Skelcrew keeps the pane's `TERM` and `TERM_PROGRAM` instead, so on hc it should pass the ones it wants.
- **Status of its own.** hc never infers status from the screen. Its status is only what was written to the terminal as OSC 7501. Here that is whatever Skelcrew reports, so hc's idle is Skelcrew's idle passed back: `deliver` and `idle` depend on `status` being called on every change.
- **A paste without Enter.** `send` is always paste then Enter. That covers `deliver`, but not the `paste` that the v6 sessions table lists for the built-in transport. That transport isn't needed on hc, since hc's own is better, so this prototype has no `paste`.
- **Skelcrew's detach key.** `hc attach` detaches with Ctrl+\, not Alt-Q.
- **A core that is safe whoever starts it.** The first hc command starts a core if none runs, with that command's environment and config, and the core passes its environment to every terminal. That is why this program starts Skelcrew's core itself and refuses one started otherwise.

## How status reaches herdr

The core reads OSC 7501 out of a terminal's output, with its terminal parser. Anything written to the terminal's device counts, whoever writes it. The agent's process is one writer. But the agent runs in Skelcrew's sandbox, and its hooks call `sc`, not the terminal, so it can't report Skelcrew's status (needs you and ready come from the engine anyway). v6 proposes a relay: a program of the plugin's own between hc and the agent, writing OSC 7501 into the stream.

**What this prototype does instead, and the proposal: the plugin writes the report to the session's terminal device.** `status` takes the terminal's `pid` from `hc get`, finds its tty with `ps -o tty= -p <pid>` (`/dev/pts/N` on Linux, `/dev/ttysNNN` on a Mac), and writes the report there in a single write. To hc, it is the program speaking. This has three advantages over a relay:

- No program sits between hc and the agent, so keys, resizes, the alternate screen and bracketed paste reach the agent exactly as hc sends them.
- The sandboxed command is the pane's own process, with no PTY inside a PTY.
- Nothing has to stay running to keep the channel open.

The engine runs as the same user, so it can open the device, and the sandbox never sees it. Its limits:

- **One write is never split, but it can land between two writes of the agent's.** Linux keeps each write to a terminal whole, so a report can't land in the middle of one of the agent's writes. If the agent writes one escape sequence across two writes, a report could land between them. Agents usually draw a frame with one write, but nothing guarantees it.
- **It needs a local core.** It works only where the engine runs on the same machine as the terminal, which is how Skelcrew runs today. For a terminal on another machine (`hc run --on`), the report would have to be written there, such as through `hc exec --on <machine>`.
- **Better: an API call.** The tidiest route would be a `terminal.status` call in hc's API that applies a report as if the program wrote it. The maintainers' rule is "Status comes only from OSC 7501", so this would have to be proposed as a report arriving over the API, not as status that hc infers.

## Findings for phase 5

- **Only `if: idle` guards typing, so every delivery goes through it.** hc checks `if` at the moment it types, however long the send was held, and that is the only check that holds through a hold. But `if` takes only `idle` or `working`, and ready shows as `done`, needs you as `blocked`. So for a ready, errored, or needs-you agent with no dialog open, `deliver` first reports `idle` with the message `delivering`, sends with `if: idle`, and afterwards puts back the status it displaced, unless Skelcrew reported another meanwhile. A report of working while the send is held then stops it. A delivery held for a long time shows the agent as idle (delivering) meanwhile. Reports for one session take turns through a lock: a folder in `/tmp`, named for the core's own ID and the session, so every caller reaching that terminal takes the same lock, whatever its environment. Each report waits until hc shows it, so putting a status back can never undo a newer report. An agent that ends right after taking the text leaves nothing to put back, and nothing about putting it back can turn a delivered message into a failed one, which Skelcrew would send again. hc refuses to type into `blocked` anyway without `force`, since typing would answer the dialog.
- **Giving up on a send must be done by cancelling it, not by killing `hc send`.** After typing, a send watches up to 5 seconds (`HC_STARTED_MS`) for the agent to start working. A killed CLI can't tell "held by a draft, nothing typed" from "typed, still watching". Only framed mode answers `$/cancelRequest`: hc cancels only before typing, and answers `cancelled` or the result. That certainty is what keeps a message from being typed twice, so calls speak framed mode over `hc connect`. Plain mode cancels only by hanging up, and then sends no answer.
- **hc's draft hold isn't "never" by default.** A send waits while a person has a draft, but only up to `draft_wait` (60 seconds by default) after their last key, and then types on top of it. Skelcrew's rule is never. Only hc knows about a draft the screen doesn't show, since it counts the person's keys, and nothing outside hc can see that count. So the only guard that covers every draft is a hold that doesn't end. That needs Skelcrew's own core with its own config, as above. On top of that, `deliver` reads the screen as Skelcrew's built-in transport does. It looks twice, half a second apart, and sends only once the screen stands still and shows an empty prompt. The busy mark counts only on a line that is new since the earlier look, as a running turn's spinner or clock redraws it. When the mark sits still at a ready prompt, `deliver` watches 1.5 seconds more, since a status line that counts seconds redraws at least once a second and the first two looks can fall between ticks. Output that merely quotes the mark, such as `esc to interrupt`, never holds a delivery. The prompt is read by the harness's marks as Skelcrew's built-in transport reads them. That catches a draft hc never counted, such as one typed before the core restarted. The prompt's mark is its first word, and the rest is the placeholder an empty prompt shows, such as Codex's `› Ask Codex to do anything`, which typing replaces.
- **Interrupt.** `hc interrupt` presses Esc for a program that ever reported a status, which every session has once `status` ran, and ctrl+c for one that never did. It then waits for the status to leave `working`. Claude Code has no hook for Esc, so hc says `still_working` until Skelcrew's screen check reports `idle`. Its outcome is advisory.
- **`hc ls --json` has no labels.** `list` uses the API's `terminal.list`, which gives whole records.
- **Every send waits for a starting agent to settle.** During an agent's first 10 seconds, a send first waits, up to 5 seconds, for the screen to stop changing.

## Open questions for phase 5's protocol

1. **Long calls.** `deliver` and `idle` wait, and a plugin call is killed after 60 seconds. Should the protocol have a long-running call, or a stream for `idle`, such as one line per status change from `hc events`, instead of a call that waits and returns?
2. **Who calls `status`, and how often?** hc's idle is only what Skelcrew reported. If a call is missed or arrives late, `deliver` waits on a stale status. Should the engine report again when it starts, for every running session?
3. **Can anything print a fake status?** Anything that prints OSC 7501 to the terminal changes hc's status, including the agent printing a file that holds one. A false `idle` would let `deliver` type into a running turn. `deliver`'s screen check also refuses a screen whose busy mark is moving, as a running turn's status line does, which covers most of that. Is that enough?
4. **Status from the API.** Ask herdr-core for a `terminal.status` call, or keep writing to the tty (see above)? Either way, if a harness ever writes OSC 7501 itself, two writers will fight over the root record. Should Skelcrew then report under a child record (`id=skelcrew`)?
5. **Never typing onto a draft, and guarding other states, in hc itself.** Two things would let Skelcrew run on the person's own core, and remove `deliver`'s temporary `idle` report. Ask herdr-core for them?
   - A per-send option to hold for a draft with no time limit.
   - `if` taking any status word, such as `if: done`.
6. **Which labels does herdr's app group by?** This prototype uses `repo`, `task` and `role`, plus `by=skelcrew` to find its own. Should Skelcrew prefix them (`skelcrew.repo`), and will herdr's app group by `repo`?
7. **Session IDs.** The ID here is the hc name Skelcrew gives (a-z, 0-9, `-` and `_`, at most 32), unique among live terminals only. A finished one keeps the name until `end` removes it, and `start` under that name fails until then. Should the ID be hc's address (`t7`) instead, or both?
8. **Which core?** This prototype uses a session of Skelcrew's own, since only a config of its own keeps every draft safe today. herdr's apps then have to look at that session too. Can they show more than one session, or should herdr-core take a draft hold per send (question 5), so Skelcrew can run on the default core?
9. **Attach.** Should `attach` answer with a command for Skelcrew to run, as here, or run in the terminal itself, as v6's `attach:` manifest entry does?
