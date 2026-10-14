import assert from "node:assert/strict"
import { globSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import test from "node:test"

// A THREAD BEHAVIOUR IS WIRED ONCE, IN THE SHELL (components/ThreadSurface.tsx), and never in a surface's
// own component. A thread is drawn on its queue card (TodosView), in its drawer and on its full-screen
// page (both ChatView); until 2026-10-13 each of those two components assembled the thread's contexts,
// its answering controller and its send scope by hand, so whatever was added to one was simply absent
// from the other — a file dropped anywhere on a queue card went into its prompt box, and the same drop on
// the drawer or the full-screen page did nothing (maintainer: "This shouldn't even be structurally
// possible"). These pin the structure that makes it so: the pieces below appear in the shell and nowhere
// else, every surface mounts the shell, and the prompt box takes its surface from the shell alone.
//
// If one of these fails on your change, the thing you are adding belongs in ThreadSurface.tsx, where
// every surface gets it. Fixtures and tests are exempt: they mount pieces in isolation on purpose.

const src = fileURLToPath(new URL("../", import.meta.url))
const production = globSync("**/*.{ts,tsx}", { cwd: src })
  .map((file) => file.split("\\").join("/"))
  .filter((file) => !/\.test\.tsx?$/.test(file) && !/-fixture\.tsx$/.test(file))
const sources = new Map(production.map((file) => [file, readFileSync(`${src}/${file}`, "utf8")]))
const filesWith = (needle: string) => [...sources].filter(([, text]) => text.includes(needle)).map(([file]) => file).sort()

const SHELL = "components/ThreadSurface.tsx"

test("the thread's contexts, its answering controller and its drop zone are wired in the shell alone", () => {
  // What the shell provides — a provider anywhere else is a second, partial shell.
  for (const provider of ["ThreadSlugContext.Provider", "QueueDismissContext.Provider", "SendScopeContext.Provider", "<RegisteredAnsweringProvider"]) {
    assert.deepEqual(filesWith(provider), [SHELL], `${provider} is mounted by ThreadSurface, for every surface at once`)
  }
  // What the shell calls — each also appears in the module that defines it.
  assert.deepEqual(filesWith("useLiveAnswering("), [SHELL, "lib/answering.ts"].sort())
  assert.deepEqual(filesWith("useSendScope("), [SHELL, "lib/sendScope.tsx"].sort())
  assert.deepEqual(filesWith("useComposerSendHandle("), [SHELL, "lib/sendScope.tsx"].sort())
  assert.deepEqual(filesWith("useFileIntakeHandle("), [SHELL, "lib/fileDrop.ts"].sort())
  // A drop zone is the thread surface's, or a prompt box's own where the box is not a thread's.
  assert.deepEqual(filesWith("useFileDropZone("), ["components/Composer.tsx", SHELL, "lib/fileDrop.ts"].sort())
})

test("every surface that draws a thread's prompt box mounts the shell, once", () => {
  const surfaces = ["components/ChatView.tsx", "components/TodosView.tsx"]
  assert.deepEqual(filesWith("<ThreadSurface").filter((file) => file !== SHELL), surfaces, "a new surface is added here on purpose")
  for (const file of surfaces) {
    const text = sources.get(file)!
    assert.equal((text.match(/useThreadSurface\(/g) ?? []).length, 1, `${file} calls useThreadSurface once`)
    assert.equal((text.match(/<ThreadSurface\b/g) ?? []).length, 1, `${file} mounts one ThreadSurface`)
    // The zone is the shell's: a surface that binds a drag handler of its own has forked it.
    assert.doesNotMatch(text, /\bon(?:Drop|DragOver|DragEnter|DragLeave)=/, `${file} binds no drag handlers of its own`)
  }
  // The box is drawn directly by the queue card, and through ThreadActionBar by ChatView.
  assert.deepEqual(filesWith("<ThreadComposerBox"), ["components/ThreadActionBar.tsx", "components/TodosView.tsx"])
  assert.deepEqual(filesWith("<ThreadActionBar"), ["components/ChatView.tsx"])
})

test("the prompt box takes its surface from the shell and has no way to be handed one", () => {
  const box = sources.get("components/ThreadComposerBox.tsx")!
  assert.match(box, /const \{ fileDrop \} = useThreadSurfaceBox\(\)/)
  assert.equal((box.match(/fileDrop=\{fileDrop\}/g) ?? []).length, 2, "both of its layouts hand the surface's zone to the box")
  // Outside a surface it throws rather than mounting without whatever the shell wires.
  assert.match(sources.get(SHELL)!, /if \(!box\) throw new Error\(/)
})
