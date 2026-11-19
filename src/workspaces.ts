// Places Skelcrew's sessions in herdr's app: one workspace per repository, named like
// skelcrew/skelcrew, with one tab per session, the lead's first. The app keeps its workspaces in
// an hc document on the core, `herdr-app`, and shows a terminal only once a tab there holds it.
// Each placed terminal also carries labels naming its workspace and tab, as the app's own do.
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { HcError, rpc } from "./hc.ts";

// The app's document, as far as this file reads it. Everything else in it, the person's own
// workspaces and anything a later app adds, is kept as it is.
const Block = z.looseObject({ content: z.looseObject({ terminal: z.string() }).optional() });
const Tab = z.looseObject({
  id: z.string(),
  name: z.string(),
  root: z.looseObject({ children: z.array(Block).default([]) }),
});
const Space = z.looseObject({ id: z.string(), name: z.string(), tabs: z.array(Tab) });
const Layout = z.looseObject({ spaces: z.array(Space).default([]) });
type Layout = z.infer<typeof Layout>;
type Tab = z.infer<typeof Tab>;

const doc = "herdr-app";

// An ID in the app's own shape: a prefix and 32 random hex digits.
const newId = (prefix: string) => `${prefix}${randomBytes(16).toString("hex")}`;

// Changes the app's document with `change`, which edits the layout in place. The document is
// written only if nobody, the app included, wrote it since it was read, so nothing the person
// did meanwhile is lost: on a conflict it is read and changed again. A change that changes
// nothing writes nothing.
async function update<T>(change: (layout: Layout) => T): Promise<T> {
  while (true) {
    const read = z
      .object({ value: z.unknown(), version: z.number() })
      .parse(await rpc("doc.get", { name: doc }));
    const layout = Layout.parse(read.value ?? {});
    const before = JSON.stringify(layout);
    const result = change(layout);
    if (JSON.stringify(layout) === before) return result;
    try {
      await rpc("doc.set", { name: doc, value: layout, version: read.version });
      return result;
    } catch (error) {
      if (!(error instanceof HcError && error.kind === "conflict")) throw error;
    }
  }
}

// The tab's name for a session: `lead` for the lead, else its task, such as skelcrew-430, else
// Skelcrew's name for it.
const tabName = (role: string, task: string | undefined, name: string) =>
  role === "lead" ? "lead" : (task ?? name);

// Puts the terminal at `address` in a tab of its repository's workspace, making either when
// missing. A tab of the same name, from an earlier session of the same thread, takes the new
// terminal instead, so a restarted agent keeps its place. The lead's tab goes first.
export async function place(
  address: string,
  labels: { repository: string; role: string; task?: string | undefined },
  name: string,
): Promise<void> {
  const tab = tabName(labels.role, labels.task, name);
  const at = await update((layout) => {
    let space = layout.spaces.find((s) => s.name === labels.repository);
    if (!space) {
      space = { id: newId("sp"), name: labels.repository, folder: "", tabs: [] };
      layout.spaces.push(space);
    }
    const block = { type: "block", id: newId("p"), content: { terminal: address } };
    let found = space.tabs.find((t) => t.name === tab);
    if (found) found.root = { ...found.root, children: [block] };
    else {
      const id = newId("tb");
      found = { id, name: tab, root: { type: "row", id, children: [block] } };
      if (labels.role === "lead") space.tabs.unshift(found);
      else space.tabs.push(found);
    }
    return { space: space.id, tab: found.id };
  });
  await rpc("terminal.label", {
    terminal: address,
    labels: {
      "herdr.space": at.space,
      "herdr.tab": at.tab,
      where: `${labels.repository} / ${tab}`,
      "herdr.seen": "0",
    },
  });
}

// Closes the tabs that hold the terminal at `address`, and its workspace once that leaves it
// with no tabs.
export async function unplace(address: string): Promise<void> {
  const holds = (t: Tab) => t.root.children.some((b) => b.content?.terminal === address);
  await update((layout) => {
    layout.spaces = layout.spaces.filter((space) => {
      if (!space.tabs.some(holds)) return true;
      space.tabs = space.tabs.filter((t) => !holds(t));
      return space.tabs.length > 0;
    });
  });
}
