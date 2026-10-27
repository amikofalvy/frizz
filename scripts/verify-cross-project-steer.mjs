// `frizzctl steer` ACROSS PROJECTS (2026-10-26), driven through the real path: two projects on one
// Frizz, a scripted worker in each (scripts/scripted-claude.mjs under the real broker daemon), and the
// workers' own `frizzctl` — the checkout's, run as real Bash tool calls in the daemon's environment — doing
// the steering. Only the model is replaced.
//
// What it pins, in each worker's own transcript and on each project's own RPC:
//   1. A worker in the LAUNCHING project steers a thread in the TENANT by bare slug: its own project has
//      no such thread, so the server finds it in the other one. The receipt says which project, and its
//      link names it (`/project/<tenant>/thread/<slug>`).
//   2. The message reaches the tenant's worker as a `<thread-message … from-project="<launcher>">`, whose
//      guidance names the reply command, and the tenant's transcript RPC draws it with the sender's project.
//   3. The tenant's worker answers with `--project <launcher>`, and the reply lands back in the launcher's
//      thread, drawn there with the tenant's project.
//   4. Refusals: `--project` naming no project, and a slug that is in no project, exit 1 and say so, and
//      neither reaches a worker.
//
// Boot a two-project stack with the scripted worker, from a shell with no Frizz worker variables in it:
//   env -u FRIZZ_STATE_DIR -u FRIZZ_SERVER_LOCK -u FRIZZ_PROJECT_ID -u FRIZZ_NODE -u FRIZZ_THREAD \
//     -u FRIZZ_THREAD_SLUG -u FRIZZ_PERM_DIR -u FRIZZ_NATIVE_ASK -u NODE_COMPAT \
//     nub scripts/adhoc-stack.mjs --port=NNNN --project=/abs/repo-a --also-project=/abs/repo-b \
//     --claude-bin=/abs/path/to/scripts/scripted-claude.mjs > /abs/stack.log 2>&1
// then hand this the stack's json line (the first line of that log):
//   nub scripts/verify-cross-project-steer.mjs --stack=/abs/stack.log
// The dispatched workers are DETACHED broker daemons: kill each by pid when done (this prints them).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { createRpcClient } from "./lib/rpc-client.mjs"

const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")))
if (!flags.stack) {
  console.error("usage: nub scripts/verify-cross-project-steer.mjs --stack=/abs/stack.log")
  process.exit(1)
}
const line = readFileSync(flags.stack, "utf8").split("\n").find((l) => l.startsWith("{"))
if (!line) throw new Error(`no json line in ${flags.stack} — is the stack booted?`)
const stack = JSON.parse(line)
const launcher = { slug: stack.launcher.slug, dir: stack.project }
const tenant = stack.tenants[0]
if (!tenant?.slug) throw new Error("the stack has no second project — boot it with --also-project")

const base = `http://127.0.0.1:${stack.port}/`
const apiA = createRpcClient(base, launcher.slug)
const apiB = createRpcClient(base, tenant.slug)
await apiA.waitForHealth()

const run = Date.now().toString(36)
const A = `cross-sender-${run}`
const B = `cross-receiver-${run}`
const scratch = join(stack.home, "cross-steer")
mkdirSync(scratch, { recursive: true })

const turns = (file, list) => {
  writeFileSync(file, JSON.stringify({ think: 150, turns: list, otherwise: { name: "unscripted", text: "Nothing was scripted for that message." } }, null, 1))
  return file
}
const fileA = turns(join(scratch, `${A}.json`), [
  { name: "start", text: "Ready." },
  { name: "send", on: "go steer", tools: [`frizzctl steer ${B} --message 'Alpha says hello across projects.'`], text: "Sent." },
  { name: "reply", on: "<thread-message", text: "Got the reply." },
  {
    name: "refusals",
    on: "try the refusals",
    tools: [
      `frizzctl steer ${B} --project no-such-project --message x; echo "exit=$?"`,
      `frizzctl steer no-such-thread-${run} --message x; echo "exit=$?"`,
    ],
    text: "Tried.",
  },
])
const fileB = turns(join(scratch, `${B}.json`), [
  { name: "start", text: "Ready." },
  { name: "answer", on: `from-project="${launcher.slug}"`, tools: [`frizzctl steer ${A} --project ${launcher.slug} --message 'Beta got it.'`], text: "Replied." },
])

const jsonl = (dir, sessionId) => join(stack.home, ".claude", "projects", dir.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`)
const records = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").flatMap((l) => { try { return l ? [JSON.parse(l)] : [] } catch { return [] } }) : [])
const userTexts = (path) => records(path).filter((r) => r.type === "user" && typeof r.message?.content === "string").map((r) => r.message.content)
const rests = (path) => records(path).filter((r) => r.type === "assistant" && r.message?.stop_reason === "end_turn").map((r) => r.message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n"))
const toolResults = (path) => records(path).flatMap((r) => (r.type === "user" && Array.isArray(r.message?.content) ? r.message.content.filter((b) => b.type === "tool_result") : []))
  .map((b) => (typeof b.content === "string" ? b.content : (b.content ?? []).map((c) => c.text ?? "").join("")))

async function until(what, probe, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 250))
  }
}
const results = []
const check = (name, ok, detail = "") => {
  results.push({ name, ok })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${detail}` : ""}`)
}

const a = await apiA.mutate("dispatch", { prompt: `[script file=${fileA}] sender`, backend: "claude", slug: A, title: "Cross-project sender" })
const b = await apiB.mutate("dispatch", { prompt: `[script file=${fileB}] receiver`, backend: "claude", slug: B, title: "Cross-project receiver" })
const pathA = jsonl(launcher.dir, a.sessionId)
const pathB = jsonl(tenant.dir, b.sessionId)
await until("both workers' first rest", () => rests(pathA).includes("Ready.") && rests(pathB).includes("Ready."))

await apiA.mutate("followUp", { slug: A, sessionId: a.sessionId, message: "go steer" })

// 1. The sender's receipt.
const receipt = await until("the sender's steer receipt", () => toolResults(pathA).find((t) => t.includes("Delivered to") || t.includes("failed")))
check("a bare slug in another project is found there, and the receipt names it",
  receipt.includes(`(\`${B}\`) on the \`${tenant.slug}\` project`) && receipt.includes(`(/project/${tenant.slug}/thread/${B})`), receipt.split("\n")[0])

// 2. The receiver gets it, wrapped with the sender's project, and the reply command.
const got = await until("the message in the receiver's transcript", () => userTexts(pathB).find((t) => t.startsWith("<thread-message")))
check("the receiver's worker reads a thread-message naming the sender's project",
  got.includes(`from-thread="${A}"`) && got.includes(`from-project="${launcher.slug}"`) && got.includes("Alpha says hello across projects."), got.split("\n")[0])
check("its guidance names the command that answers across projects", got.includes(`frizzctl steer ${A} --project ${launcher.slug}`))
const pageB = await until("the receiver's transcript RPC", async () => {
  const page = await apiB.query("threadTranscript", { slug: B })
  return page.messages.find((m) => m.sessionPeer?.thread?.slug === A) ? page : undefined
})
const peerB = pageB.messages.find((m) => m.sessionPeer?.thread?.slug === A).sessionPeer.thread
check("the receiver's chat draws the sender with its project", peerB.project === launcher.slug, JSON.stringify(peerB))

// 3. The reply comes back across.
const replyReceipt = await until("the receiver's reply receipt", () => toolResults(pathB).find((t) => t.includes("Delivered to") || t.includes("failed")))
check("the receiver answers with --project and is delivered back", replyReceipt.includes(`on the \`${launcher.slug}\` project`), replyReceipt.split("\n")[0])
const back = await until("the reply in the sender's transcript", () => userTexts(pathA).find((t) => t.startsWith("<thread-message")))
check("the sender reads the reply, naming the receiver's project", back.includes(`from-thread="${B}"`) && back.includes(`from-project="${tenant.slug}"`) && back.includes("Beta got it."), back.split("\n")[0])
await until("the sender's rest on the reply", () => rests(pathA).includes("Got the reply."))
const pageA = await apiA.query("threadTranscript", { slug: A })
const peerA = pageA.messages.find((m) => m.sessionPeer?.thread?.slug === B)?.sessionPeer.thread
check("the sender's chat draws the receiver with its project", peerA?.project === tenant.slug, JSON.stringify(peerA))

// 4. Refusals.
const before = userTexts(pathB).length
await apiA.mutate("followUp", { slug: A, sessionId: a.sessionId, message: "try the refusals" })
await until("the refusals turn", () => rests(pathA).includes("Tried."))
const [noProject, noThread] = toolResults(pathA).slice(-2)
check("--project naming no project exits 1 and lists the projects",
  /no project `no-such-project` on this machine/.test(noProject) && noProject.includes(`\`${tenant.slug}\``) && noProject.includes("exit=1"), noProject.split("\n")[0])
check("a slug in no project exits 1", /no thread `no-such-thread-[a-z0-9]+` in this project or any other open one/.test(noThread) && noThread.includes("exit=1"), noThread.split("\n")[0])
check("neither refusal reaches the other worker", userTexts(pathB).length === before)

const daemons = execFileSync("ps", ["-Ao", "pid,command"], { encoding: "utf8" }).split("\n").filter((l) => l.includes(a.sessionId) || l.includes(b.sessionId)).map((l) => l.trim().split(/\s+/)[0])
console.log(`\nworker processes to kill: ${daemons.join(" ") || "(none found by session id)"}`)
const failed = results.filter((r) => !r.ok).length
console.log(`${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
