import { test } from "node:test"
import assert from "node:assert/strict"
import { assertMutationAllowedDuringControlPlaneTransition, CONTROL_PLANE_RESTARTING_MESSAGE, isKeptDeliveryError, isRetryableRpcError, parseRpcResponse, routeCall } from "./rpc.ts"
import { store } from "../store.ts"

test("RPC response: a stale server's plain-text missing route asks for a server restart", async () => {
  await assert.rejects(
    parseRpcResponse(new Response("404 Not Found", { status: 404 }), "setThreadPermission"),
    /Frizz server restart required/,
  )
})

test("RPC transition guard holds writes locally while preserving query access", () => {
  const previous = store.controlPlaneState
  try {
    store.controlPlaneState = "restarting"
    assert.throws(
      () => assertMutationAllowedDuringControlPlaneTransition("mutation"),
      new RegExp(CONTROL_PLANE_RESTARTING_MESSAGE),
    )
    assert.doesNotThrow(() => assertMutationAllowedDuringControlPlaneTransition("query"))
  } finally {
    store.controlPlaneState = previous
  }
})

test("RPC response: valid server errors and successful envelopes keep their normal semantics", async () => {
  await assert.rejects(
    parseRpcResponse(new Response(JSON.stringify({ error: "specific failure" }), { status: 500 }), "x"),
    /specific failure/,
  )
  assert.deepEqual(
    await parseRpcResponse(new Response(JSON.stringify({ result: { effect: "next-resume" } }), { status: 200 }), "x"),
    { effect: "next-resume" },
  )
})

// `kept`: the server holds a failed follow-up as a failed bubble (server/src/router.ts
// keepFailedFollowUp). It rides beside `retryable`, and neither implies the other.
test("a kept follow-up failure is readable on the thrown error", async () => {
  const kept = await parseRpcResponse(new Response(JSON.stringify({ error: "cold resume failed", kept: true }), { status: 500 }), "followUp").then(() => null, (e: unknown) => e)
  assert.equal(isKeptDeliveryError(kept), true)
  assert.equal(isRetryableRpcError(kept), false)
  assert.equal((kept as Error).message, "cold resume failed")
  const plain = await parseRpcResponse(new Response(JSON.stringify({ error: "stale tab" }), { status: 500 }), "followUp").then(() => null, (e: unknown) => e)
  assert.equal(isKeptDeliveryError(plain), false)
})

// ── THE CONSOLE'S ROUTING (routeCall) ─────────────────────────────────────────────────────────────
// The Console names no project, so every call must carry one: a thread procedure by its key, a project
// procedure through rpcFor. The negative cases are the point — on the Console a forgotten project used
// to mean the LAUNCHING project's `/_frizz`, which reads and writes a stranger's state and looks fine.

test("a thread key routes to its project with the real slug, from any page", () => {
  for (const page of ["/console", "/console/thread/nub~fix", "/project/frizz", "/"]) {
    assert.deepEqual(routeCall("threadTranscript", { slug: "nub~fix-auth", limit: 5 }, undefined, page), {
      base: "/_frizz/nub",
      input: { slug: "fix-auth", limit: 5 },
      project: "nub",
    }, page)
  }
})

test("a project procedure goes to the project rpcFor names", () => {
  assert.deepEqual(routeCall("dispatch", { prompt: "x" }, "reylo", "/console"), { base: "/_frizz/reylo", input: { prompt: "x" }, project: "reylo" })
  // A bare slug riding WITH a named project is that project's slug.
  assert.deepEqual(routeCall("dispatch", { prompt: "x", slug: "fix" }, "reylo", "/console"), { base: "/_frizz/reylo", input: { prompt: "x", slug: "fix" }, project: "reylo" })
  assert.throws(() => routeCall("followUp", { slug: "nub~fix" }, "reylo", "/console"), /not a thread of reylo/)
})

test("on the Console, a call that names no project is refused rather than sent to the launching project", () => {
  assert.throws(() => routeCall("threadTranscript", { slug: "fix-auth" }, undefined, "/console"), /names no project/)
  assert.throws(() => routeCall("dispatch", { prompt: "x" }, undefined, "/console"), /needs a project on the Console/)
  assert.throws(() => routeCall("localFile", { path: "/a" }, undefined, "/console/thread/nub~x"), /needs a project/)
})

test("machine-wide calls and project pages are unchanged", () => {
  assert.deepEqual(routeCall("projectsList", undefined, undefined, "/console"), { base: "/_frizz", input: undefined })
  // threadLocate searches every project for a REAL slug — machine-wide by design.
  assert.deepEqual(routeCall("threadLocate", { slug: "fix" }, undefined, "/console"), { base: "/_frizz", input: { slug: "fix" } })
  assert.deepEqual(routeCall("threadTranscript", { slug: "fix" }, undefined, "/project/nub/thread/fix"), { base: "/_frizz/nub", input: { slug: "fix" } })
  assert.deepEqual(routeCall("dispatch", { prompt: "x" }, undefined, "/"), { base: "/_frizz", input: { prompt: "x" } })
})
