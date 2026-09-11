#!/usr/bin/env nub
// Clean npm tarballs -> private registry -> npm exec -> stable launcher -> browser -> restart.
// Run after creating tarballs with the root npm lifecycle:
//   nub scripts/verify-server-package.mjs --shell=/abs/frizz-0.13.0.tgz --server=/abs/frizz-server-0.13.0.tgz --out=/abs/evidence
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { createServer } from "node:http"
import { createServer as createNetServer } from "node:net"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import puppeteer from "puppeteer"

const arg = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const shellTarball = resolve(arg("shell") ?? "")
const serverTarball = resolve(arg("server") ?? "")
const out = resolve(arg("out") ?? "")
if (!existsSync(shellTarball) || !existsSync(serverTarball) || !arg("out"))
  throw new Error("usage: verify-server-package.mjs --shell=/abs/frizz.tgz --server=/abs/frizz-server.tgz --out=/abs/evidence")
mkdirSync(out, { recursive: true })

const root = mkdtempSync(join(tmpdir(), "frizz-package-smoke-"))
const home = join(root, "home"), project = join(root, "project"), cache = join(root, "npm-cache")
mkdirSync(home); mkdirSync(project)
execFileSync("git", ["init", "-q"], { cwd: project })
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(FRIZZ_|npm_|NPM_|NODE_OPTIONS|NODE_PATH|XDG_|HOME|USERPROFILE)/u.test(key)))
Object.assign(env, {
  HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
  XDG_STATE_HOME: join(home, "state"), XDG_CACHE_HOME: join(home, "cache"), npm_config_cache: cache,
  npm_config_userconfig: join(root, "npmrc"), npm_config_fetch_retries: "0", npm_config_audit: "false", npm_config_fund: "false",
  FRIZZ_ORPHAN_REAPER_OFF: "1",
})
writeFileSync(env.npm_config_userconfig, "")

function sha(file) { return `sha512-${createHash("sha512").update(readFileSync(file)).digest("base64")}` }
function packed(file) {
  const manifest = JSON.parse(execFileSync("tar", ["-xOzf", file, "package/package.json"], { encoding: "utf8" }))
  return { file, bytes: readFileSync(file), manifest, integrity: sha(file) }
}
const shell = packed(shellTarball), server = packed(serverTarball)
assert.equal(shell.manifest.name, "frizz"); assert.equal(server.manifest.name, "frizz-server")
assert.equal(shell.manifest.frizzServer?.package, "frizz-server"); assert.equal(shell.manifest.frizzServer?.version, server.manifest.version)

async function port() {
  const socket = createNetServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening")
  const value = socket.address().port; await new Promise((done) => socket.close(done)); return value
}
async function until(label, test, timeout = 120_000) {
  const deadline = Date.now() + timeout; let last
  while (Date.now() < deadline) {
    try { const value = await test(); if (value) return value } catch (error) { last = error }
    await delay(200)
  }
  throw new Error(`timed out waiting for ${label}${last ? `: ${last}` : ""}`)
}
function ownerAddress() {
  const file = join(home, "state", "frizz", "frizz-server", "address.json")
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined
}
function childGeneration() {
  const projects = join(home, "data", "frizz", "projects")
  for (const id of existsSync(projects) ? readdirSync(projects) : []) {
    const lock = join(projects, id, "server.lock")
    if (existsSync(lock)) return JSON.parse(readFileSync(lock, "utf8"))
  }
  return undefined
}
function alive(pid) { try { process.kill(pid, 0); return true } catch { return false } }

const packages = new Map([[shell.manifest.name, shell], [server.manifest.name, server]])
let registry, launcher, browser
const childPids = new Set()
const errors = [], expectedBrowserEvents = []
let restartRequested = false
const evidence = { tarballs: { shell: { file: shellTarball, integrity: shell.integrity }, server: { file: serverTarball, integrity: server.integrity } }, browserErrors: errors, expectedBrowserEvents }
try {
  registry = createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://registry").pathname)
    const name = pathname.split("/")[1]
    const release = packages.get(name)
    if (!release) {
      const upstream = await fetch(`https://registry.npmjs.org${request.url}`)
      response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/octet-stream" })
      response.end(Buffer.from(await upstream.arrayBuffer())); return
    }
    if (pathname.includes("/-/")) { response.writeHead(200, { "content-type": "application/octet-stream" }); response.end(release.bytes); return }
    const registryUrl = env.npm_config_registry
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ name, "dist-tags": { latest: release.manifest.version }, versions: {
      [release.manifest.version]: { ...release.manifest, dist: { tarball: `${registryUrl}${name}/-/${name}-${release.manifest.version}.tgz`, integrity: release.integrity } },
    } }))
  })
  registry.listen(0, "127.0.0.1"); await once(registry, "listening")
  env.npm_config_registry = `http://127.0.0.1:${registry.address().port}/`
  const publicPort = await port(); const base = `http://127.0.0.1:${publicPort}`
  evidence.registry = env.npm_config_registry; evidence.url = base
  launcher = spawn("npm", ["exec", "--yes", `--package=frizz@${shell.manifest.version}`, "--", "frizz", "--no-app", "--port", String(publicPort)], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] })
  let launcherLog = ""; launcher.stdout.on("data", (b) => { launcherLog += b }); launcher.stderr.on("data", (b) => { launcherLog += b })
  const status = async () => {
    const response = await fetch(`${base}/_frizz/control/status`, { headers: { origin: base }, signal: AbortSignal.timeout(2000) })
    assert.equal(response.status, 200); return response.json()
  }
  const before = await until("cold package boot", async () => {
    const state = await status(); return state.state === "ready" ? state : undefined
  })
  assert.equal(before.version, server.manifest.version)
  assert.equal(before.launcherVersion, shell.manifest.version)
  const owner = await until("stable launcher owner", () => ownerAddress())
  const childBefore = await until("cold control-plane generation", () => childGeneration())
  childPids.add(childBefore.pid)
  assert.ok(alive(owner.pid), `stable launcher ${owner.pid} is alive`)
  assert.equal(owner.port, publicPort)
  evidence.cold = { ownerPid: owner.pid, npmExecPid: launcher.pid, status: before, owner, child: childBefore }
  browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] })
  const page = await browser.newPage()
  page.on("pageerror", (error) => errors.push(`pageerror: ${error}`))
  page.on("console", (message) => {
    if (message.type() !== "error") return
    const event = `console: ${message.text()} @ ${message.location().url}`
    if (message.location().url.includes("/_frizz/project-icon?") && message.text().includes("404")) expectedBrowserEvents.push(event)
    else if (restartRequested && /^WebSocket connection to .*failed: (Connection closed before receiving a handshake response|Error during WebSocket handshake: Unexpected response code: 503)/u.test(message.text())) expectedBrowserEvents.push(`restart: ${event}`)
    else errors.push(event)
  })
  await page.setViewport({ width: 1280, height: 850, deviceScaleFactor: 2 })
  await page.goto(base, { waitUntil: "networkidle2" }); await page.screenshot({ path: join(out, "cold-desktop.png") })
  await page.setViewport({ width: 420, height: 880, deviceScaleFactor: 2 })
  await page.goto(base, { waitUntil: "networkidle2" }); await page.screenshot({ path: join(out, "cold-narrow.png") })
  assert.equal(errors.length, 0, errors.join("\n"))
  restartRequested = true
  const restarting = await fetch(`${base}/_frizz/control/restart`, { method: "POST", headers: { origin: base } })
  assert.equal(restarting.status, 202)
  const after = await until("server restart", async () => {
    const state = await status(); return state.state === "ready" ? state : undefined
  })
  assert.equal(after.version, server.manifest.version)
  assert.equal(after.launcherVersion, shell.manifest.version)
  const childAfter = await until("restarted control-plane generation", () => {
    const next = childGeneration(); return next?.bootId && next.bootId !== childBefore.bootId ? next : undefined
  })
  childPids.add(childAfter.pid)
  const ownerAfter = ownerAddress()
  assert.equal(ownerAfter.pid, owner.pid, "restart keeps the stable launcher PID")
  assert.equal(ownerAfter.port, publicPort, "restart keeps the public listener")
  assert.ok(alive(owner.pid), "stable launcher remains alive after restart")
  restartRequested = false
  await page.goto(base, { waitUntil: "networkidle2" }); await page.screenshot({ path: join(out, "after-restart.png") })
  assert.equal(errors.length, 0, errors.join("\n"))
  evidence.restart = { status: after, ownerPid: ownerAfter.pid, port: ownerAfter.port, child: childAfter }
  evidence.packageGitHeads = { shell: shell.manifest.gitHead ?? null, server: server.manifest.gitHead ?? null }
  evidence.launcherLog = launcherLog
  writeFileSync(join(out, "result.json"), `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(JSON.stringify(evidence, null, 2))
} finally {
  const browserPid = browser?.process()?.pid
  if (browser) await browser.close()
  const lastChild = childGeneration()
  if (lastChild?.pid) childPids.add(lastChild.pid)
  const owner = ownerAddress()
  if (owner?.pid && alive(owner.pid)) process.kill(owner.pid, "SIGTERM")
  if (launcher && launcher.exitCode === null) launcher.kill("SIGTERM")
  if (owner?.pid) await until("stable launcher cleanup", () => !alive(owner.pid), 30_000)
  if (launcher?.pid) await until("npm exec cleanup", () => !alive(launcher.pid), 30_000)
  await until("server child cleanup", () => [...childPids].every((pid) => !alive(pid)), 30_000)
  if (browserPid) await until("browser cleanup", () => !alive(browserPid), 30_000)
  if (registry) await new Promise((done) => registry.close(done))
  evidence.cleanup = { npmExecAlive: launcher?.pid ? alive(launcher.pid) : false, stableLauncherAlive: owner?.pid ? alive(owner.pid) : false, browserAlive: browserPid ? alive(browserPid) : false, remainingChildren: [...childPids].filter(alive) }
  writeFileSync(join(out, "cleanup.json"), `${JSON.stringify(evidence.cleanup, null, 2)}\n`)
  rmSync(root, { recursive: true, force: true })
}
