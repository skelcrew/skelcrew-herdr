# skelcrew-herdr

Skelcrew's runtime plugin for [herdr-core](https://github.com/herdrdev/herdr-core) (`hc`). It runs Skelcrew's leads and builders in hc terminals instead of tmux, where hc and herdr can show them. It provides Skelcrew's sessions, transport and status base modules.

## Try it

You need Skelcrew with runtime plugins (0.1.3, or a checkout of `main`) and `hc` on your `PATH`:

```sh
curl -fsSL https://releases.herdr.dev/core/install.sh | HC_INSTALL_DIR=~/.local/bin sh
sc plugin install skelcrew/skelcrew-herdr
```

Then set `session: herdr` in `~/.config/skelcrew/config.yaml`. New leads and builders start on herdr. A lead or builder already running stays on tmux until it ends. Plain `sc` attaches you to the repository's lead full screen, through this plugin's attach, which runs `hc attach`. In `sc --list`, Enter on a builder attaches to it full screen the same way. Either way, your hc detach key brings you back.

Not done yet: on herdr, Skelcrew can't tell a lead you exited, such as with `/exit`, from one you detached from ([skelcrew/skelcrew#483](https://github.com/skelcrew/skelcrew/issues/483)).

The agents run on your own hc core, the one `hc` and herdr's apps show, so its config is yours. Set these in `~/.config/herdr-core/config.toml`:

```toml
notes = false
draft_wait = 1000000000
detach_key = "ctrl+q"
```

- `draft_wait` is how long, in seconds, your unsent draft holds back Skelcrew's message to an agent. hc's default is 60. After that, hc types the message on top of a draft that the agent's screen doesn't show.
- `detach_key = "ctrl+q"` leaves an agent with Ctrl-Q, as on tmux. Without it, Ctrl+\ leaves. Alt-Q can't, as hc's detach key is always a Ctrl chord.
- `notes = false` keeps hc from typing notes of its own into your agents.

## Seeing Skelcrew's agents from herdr

Each agent is a terminal on your default hc core, named after its session, such as `skelcrew-430`. `hc ls` lists them, and herdr's apps show them. Skelcrew's carry the label `by=skelcrew`, and `repo`, `role`, `task` and `name` too, so you can filter by them:

```sh
hc ls --label by=skelcrew
hc ls --label repo=simon/app
```

**Workspaces in herdr's app.** Each repository gets a workspace named after it without its owner, such as `skelcrew`, with a tab per session. The lead's tab, `lead`, goes first. A builder's tab is the thread's title as Skelcrew shows it, its short title when it has one, if Skelcrew passes `title` in the session's labels. Otherwise it is the thread's number, such as `430`. So the app lists an agent as `skelcrew · Tabs for agents`. Two repositories with the same name under different owners share a workspace. A restarted agent takes over its thread's tab, and ending a session closes its tab, and its workspace once that is empty. The app keeps its workspaces in the hc document `herdr-app`. The plugin writes that document only if nobody wrote it since it was read, so nothing you change in the app is lost. Each terminal also gets the app's labels, `herdr.space`, `herdr.tab` and `where`, so `hc ls` says where it is. Reviewers run headless, so they have no tab.

herdr shows each agent as its harness, `claude` or `codex`, from the `app` the relay puts in every status report. Until Skelcrew's first report, it shows the relay's own program.

A name is unique only among live terminals. If one of yours already has it, the agent's terminal runs unnamed, and its `name` label still says which session it is.

**Agents on a server.** To see a server's agents from your laptop, add the server as an hc machine with `hc machine add you@server`. This is separate from `sc --remote`. `sc --remote server --list` runs Skelcrew's list on the server over ssh, and Enter there runs `hc attach` on the server.

## How Skelcrew calls it

`skelcrew-plugin.yaml` names two commands. `session` (`bun src/call.ts`) reads one JSON question on stdin and prints one answer on stdout. An error exits 1, with its message as the last line of stderr. `attach` (`bun src/attach.ts <id>`) runs in your terminal and returns when you detach.

```sh
echo '{"ask":"list"}' | bun src/call.ts
```

| `ask` | Takes | Answers | On hc |
| --- | --- | --- | --- |
| `start` | `name`, `command`, `folder`, `env`, `labels` (`repository`, `role`, `task`, and `title` for its tab), and optionally `files`, the marker for the session's files folder (see below) | `id`, the terminal's hc address, such as `t7` | `terminal.run` (`hc run --bg --no-parent --cwd --label`), with the environment handed to the relay |
| `list` | | `sessions`: each with `id`, `running` and `labels` | `terminal.list` with the `by=skelcrew` label |
| `read` | `id` | `screen` | `terminal.read` (`hc read`) |
| `keys` | `id`, `key`: `Enter` or `Escape` | | `terminal.keys` (`hc keys`) |
| `interrupt` | `id` | `key`, `outcome` | `terminal.interrupt` (`hc interrupt`) |
| `end` | `id` | | `terminal.kill`, then `terminal.rm` (`hc kill`, `hc rm`) |
| `deliver` | `id`, `text`, `timeout` in milliseconds or null for none, and optionally the harness's screen `marks` (`busy`, `prompt`) | nothing when it went in. Exits 1 with why when it didn't, and then nothing was typed | `hc read` when given marks, then `terminal.send` with `if: idle`, never sent after the deadline, and cancelled if still held at it |
| `idle` | `id` | `idle`, at once | `terminal.get` |
| `status` | `id`, `status`, `reason` | the `status` hc then shows | OSC 7501, written into the session's terminal by its relay |

`paste` isn't answered. It serves only Skelcrew's built-in transport, which this plugin's `deliver` replaces.

**IDs.** A session's ID is its hc address. hc never gives an address to another terminal, even after `hc rm` or a core restart. A name could pass to a later terminal once this one finished, and Skelcrew's names, such as one for a repository with a dot in it, can break hc's rule for names. Skelcrew's name for the session goes in the `name` label instead.

**Labels.** Skelcrew's `repository` label is `repo` on hc, beside `role`, `task`, `name` and `by=skelcrew`.

`status` takes Skelcrew's words and answers in them: `working`, `idle`, `needs you`, `ready`, `error`. In OSC 7501 they become `working`, `idle`, `blocked` (with `kind=question` or `kind=permission` when that is the reason), `done` and `error`, and the reason goes in as the message. `idle` says an agent is free for a message unless it is working, has reported nothing yet, has a question or permission open, or has ended.

hc is found as `HC_BIN`, or `hc` on `PATH`. `HC_TERMINAL_ID` and `HC_SCOPE` are dropped from hc's environment, so an engine running inside an hc terminal doesn't make its agents that terminal's children.

### The default hc core

The agents run on the person's default hc core, the one `hc` and herdr's apps reach when no session is chosen, so they are terminals a person sees and attaches to there.

- **Started when needed.** Every call first runs `hc server start`, which does nothing when a core runs. A core this program starts gets only the environment a core needs: the core passes its environment to every terminal, a person's shells included, and a token Skelcrew has must not reach them. A core started some other way is used as it is.
- **Sessions 0.1.0 started.** Version 0.1.0 ran agents on a core of its own, the hc session `skelcrew`. While that core runs, every call also looks there, so `list` still shows those agents and `end` stops them. Only a terminal labelled `by=skelcrew` counts, so a person's own terminal at the same address is never touched. If both cores run one of Skelcrew's agents at the same address, a call fails and says how to end the older one, since neither can be told apart. `end` fails, too, when the agent still runs afterwards.
- **The person's config.** That core reads the person's `config.toml`. How long a draft holds a delivery (`draft_wait`) and the detach key are theirs, so the README asks them to set both.
- **Reaching it.** Every call here runs without `HC_SESSION` and `HC_SOCKET`. `attach` answers a command that names the default core's own socket (`HC_SOCKET`, found as hc finds it, and checked to exist), so it reaches the same core whatever the caller's environment holds, other runtime and state folders included.

## Tests

```sh
bun install
bun run check    # biome, tsc, and bun test
```

The tests run against a real hc core. They start a default core of their own, with its own state, config and socket folders, and a config with the settings above, so they never touch the machine's own core or its terminals, and they stop it at the end. Without `hc` on `PATH` or in `HC_BIN`, they are skipped, and say why. To get hc:

```sh
curl -fsSL https://releases.herdr.dev/core/install.sh | HC_INSTALL_DIR=~/.local/bin sh
```

The installer doesn't start a core. The fake agent, `test/fake-agent.ts`, prints what it was started with, then shows a prompt that echoes what is typed. Like Skelcrew's agents, it reports no status itself. The tests cover:

- `start` with the exact command, folder and environment, under any name Skelcrew gives
- `list` with labels, ignoring hc terminals that aren't Skelcrew's, and an agent that exited
- `read` and `keys`
- `deliver` only once the agent is idle
- `deliver` to a ready agent but never into an open question, putting its status back afterwards
- a person's draft, typed through a real `hc attach`, holding a delivery, including one older than hc's `draft_wait`, one typed while the delivery waits, and one the screen doesn't show
- a report of working while a delivery is held, by a draft or by hc itself, stopping it
- `idle` for each status, and a `deliver` that didn't go in exiting 1
- `interrupt`
- `end`
- the status hc shows after each report, through the relay, which refuses anything but a report
- the agent's exit code passing through the relay, and `end` ending the agent under it
- a dropped file, a PDF or a screenshot with spaces in its name, landing in the session's own files folder, which the relay makes and names in the command in place of Skelcrew's marker, and never in another session's. Where bubblewrap can make namespaces, a sandboxed agent reads its own drops whole, a screenshot and a valid PDF with spaces in their names, by the path hc gives. It can't write beside them, and can't see another session's

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
- **An environment of exactly what is given, never on a command line.** Every terminal gets the core's environment, and `terminal.run`'s `env` only adds to it. So `start` puts the agent's whole environment, as JSON, in the relay's `SKELCREW_AGENT_ENV`, and the relay starts the agent with exactly that, terminal variables included. It never goes on a command line, as `ps` shows any command line to every local user, and hc shows it in its record. An environment only its owner can read. hc's own `TERM`, `COLORTERM` and `TERM_PROGRAM` (`xterm-256color`, `truecolor`, `ghostty`) reach the agent only when Skelcrew passes them. On tmux, Skelcrew keeps the pane's `TERM` and `TERM_PROGRAM` instead, so on hc it should pass the ones it wants.
- **Status of its own.** hc never infers status from the screen. Its status is only what was written to the terminal as OSC 7501. Here that is whatever Skelcrew reports, so hc's idle is Skelcrew's idle passed back: `deliver` and `idle` depend on `status` being called on every change.
- **A paste without Enter.** `send` is always paste then Enter. That covers `deliver`, but not the `paste` that the v6 sessions table lists for the built-in transport. That transport isn't needed on hc, since hc's own is better, so this plugin has no `paste`.
- **Skelcrew's detach key.** `hc attach` detaches only with a Ctrl chord, Ctrl+\ by default, from the person's config. Ctrl-Q, which tmux sessions also take, needs `detach_key = "ctrl+q"` there. Alt-Q can't work.
- **A draft hold of its own.** hc holds a delivery for a person's draft only as long as their `draft_wait`, then types on top. Nothing outside hc can see a draft the screen doesn't show, so only the person's config keeps every draft safe.

## Files dropped into a session

A file a person drops into an agent's session in herdr, such as a screenshot or a PDF, goes to hc's `terminal.put`. hc saves it in the terminal's own folder, `files/<address>` in the core's state folder, such as `~/.local/state/herdr-core/default/files/t1z/`, and herdr types its path to the agent. hc keeps nothing else there, makes the folder at the first drop, and removes it with the terminal. A name's spaces become `_`, and a name already taken gets a suffix. hc has no setting for another folder, and the path it types is always this one, even when the folder is a link elsewhere.

Skelcrew's sandbox hides the home folder, so the agent can open a dropped file only if its sandbox shows that folder. Showing it is Skelcrew's job, as it builds the sandbox, but the folder's name is the session's hc address, which hc gives only once the terminal starts, after the sandbox's command is built. So:

- **Skelcrew** puts a marker where the folder goes: a path of its own, `/skelcrew-files-` and 32 hex digits, mounted read-only (`--ro-bind <marker> <marker>` for bubblewrap). It passes the marker to `start` as `files`.
- **The relay** makes the session's folder, empty and only its owner's, and puts its path in place of every occurrence of the marker before it starts the agent. It knows the folder as hc does: the relay runs with the core's own environment (`XDG_STATE_HOME`, `HC_SESSION`) and the terminal's `HC_TERMINAL_ID`.

So each agent sees its own session's drops, read-only, and no other session's. Without `files`, the command runs as given, and the agent can't open what is dropped.

**Not working yet.** Skelcrew doesn't pass `files` or mount the marker yet, so in real sessions, leads and builders alike, agents still can't open dropped files. That waits on a change in Skelcrew's sandbox. Until it lands, nobody has seen a dropped screenshot show as `[Image 1]` in Claude Code, or an agent read a dropped PDF.

## How status reaches herdr

The core reads OSC 7501 out of a terminal's output, with its terminal parser. The agent runs in Skelcrew's sandbox, and its hooks call `sc`, not the terminal, so it can't report Skelcrew's status (needs you and ready come from the engine anyway). And the engine, outside the terminal, can't write into it.

So `start` runs the sandboxed command under a small relay, `src/relay.ts`, as the spec says:

- **Untouched.** The agent is the relay's child on the same terminal, with no terminal in between. Keys, resizes, the alternate screen and bracketed paste reach it exactly as hc sends them. The relay ignores Ctrl-C, Ctrl-\ and Ctrl-Z, which are the agent's.
- **Its own socket.** The relay listens on a socket in `/tmp/skelcrew-herdr-<uid>/`, named by a random token kept in the terminal's `relay` label. `status` connects there and hands it one report's fields, such as `state=blocked:kind=question:msg=...`. The relay writes them as OSC 7501 to the terminal in a single write, and answers `ok`. It refuses anything but those fields, so nothing else reaches the terminal this way.
- **Ends with the agent.** It exits with the agent's exit code, so hc records how the agent ended. hc's kill signals the terminal's whole process group, and the relay passes hangup and terminate on to the agent too, in case the sandbox started a group of its own.

Its limits:

- **One write is never split, but it can land between two writes of the agent's.** Linux keeps each write to a terminal whole, so a report can't land in the middle of one of the agent's writes. If the agent writes one escape sequence across two writes, a report could land between them. Agents usually draw a frame with one write, but nothing guarantees it.
- **A Bun process per agent.** The relay runs on the same Bun as the plugin, so each agent has one more small process beside it.
- **Better: an API call.** The tidiest route would be a `terminal.status` call in hc's API that applies a report as if the program wrote it. The maintainers' rule is "Status comes only from OSC 7501", so this would have to be proposed as a report arriving over the API, not as status that hc infers.

## Findings for phase 5

- **Only `if: idle` guards typing, so every delivery goes through it.** hc checks `if` at the moment it types, however long the send was held, and that is the only check that holds through a hold. But `if` takes only `idle` or `working`, and ready shows as `done`, needs you as `blocked`. So for a ready, errored, or needs-you agent with no dialog open, `deliver` first reports `idle` with the message `delivering`, sends with `if: idle`, and afterwards puts back the status it displaced, unless Skelcrew reported another meanwhile. A report of working while the send is held then stops it. A delivery held for a long time shows the agent as idle (delivering) meanwhile. Reports for one session take turns through a lock: a file in `/tmp`, named for the core's own ID and the session, so every caller reaching that terminal takes the same lock, whatever its environment. The lock is the system's own lock on a file (`flock`, called through `bun:ffi`), which the system lets go of when its holder exits or dies, however long it held it. So nothing has to decide that a holder died, or take a lock away from one, and the file is never removed. Each report waits until hc shows it, so putting a status back can never undo a newer report. An agent that ends right after taking the text leaves nothing to put back, and nothing about putting it back can turn a delivered message into a failed one, which Skelcrew would send again. hc refuses to type into `blocked` anyway without `force`, since typing would answer the dialog.
- **Giving up on a send must be done by cancelling it, not by killing `hc send`.** After typing, a send watches up to 5 seconds (`HC_STARTED_MS`) for the agent to start working. A killed CLI can't tell "held by a draft, nothing typed" from "typed, still watching". Only framed mode answers `$/cancelRequest`: hc cancels only before typing, and answers `cancelled` or the result. That certainty is what keeps a message from being typed twice, so calls speak framed mode over `hc connect`. Plain mode cancels only by hanging up, and then sends no answer.
- **hc's draft hold isn't "never" by default.** A send waits while a person has a draft, but only up to `draft_wait` (60 seconds by default) after their last key, and then types on top of it. Skelcrew's rule is never. Only hc knows about a draft the screen doesn't show, since it counts the person's keys, and nothing outside hc can see that count. So the only guard that covers every draft is a hold that doesn't end, which the person's `draft_wait` must set, as above. On top of that, `deliver` reads the screen as Skelcrew's built-in transport does. It looks twice, half a second apart, and sends only once the screen stands still and shows an empty prompt. The busy mark counts only on a line that is new since the earlier look, as a running turn's spinner or clock redraws it. When the mark sits still at a ready prompt, `deliver` watches 1.5 seconds more, since a status line that counts seconds redraws at least once a second and the first two looks can fall between ticks. Output that merely quotes the mark, such as `esc to interrupt`, never holds a delivery. The prompt is read by the harness's marks as Skelcrew's built-in transport reads them. That catches a draft hc never counted, such as one typed before the core restarted. The prompt's mark is its first word, and the rest is the placeholder an empty prompt shows, such as Codex's `› Ask Codex to do anything`, which typing replaces.
- **Interrupt.** `hc interrupt` presses Esc for a program that ever reported a status, which every session has once `status` ran, and ctrl+c for one that never did. It then waits for the status to leave `working`. Claude Code has no hook for Esc, so hc says `still_working` until Skelcrew's screen check reports `idle`. Its outcome is advisory.
- **`hc ls --json` has no labels.** `list` uses the API's `terminal.list`, which gives whole records.
- **Every send waits for a starting agent to settle.** During an agent's first 10 seconds, a send first waits, up to 5 seconds, for the screen to stop changing.

## Open questions

1. **Can anything print a fake status?** Anything that prints OSC 7501 to the terminal changes hc's status, including the agent printing a file that holds one. A false `idle` would let `deliver` type into a running turn. `deliver`'s screen check also refuses a screen whose busy mark is moving, as a running turn's status line does, which covers most of that. Skelcrew doesn't pass the harness's marks yet, so until it does, that check doesn't run.
2. **Status from the API.** Ask herdr-core for a `terminal.status` call, or keep the relay (see above)? Either way, if a harness ever writes OSC 7501 itself, two writers will fight over the root record. Should Skelcrew then report under a child record (`id=skelcrew`)?
3. **Never typing onto a draft, and guarding other states, in hc itself.** Two things would keep every draft safe whatever the person's config says, and remove `deliver`'s temporary `idle` report. Ask herdr-core for them?
   - A per-send option to hold for a draft with no time limit.
   - `if` taking any status word, such as `if: done`.
4. **Which labels does herdr's app group by?** This plugin uses `repo`, `task`, `role` and `name`, plus `by=skelcrew` to find its own. Will herdr's app group by `repo`?
