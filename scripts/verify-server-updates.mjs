// Real npm artifacts -> stable launcher -> real server -> browser. No public package publication.
// Build first: nub scripts/prepare-package.mjs --server && nub scripts/build-package.mjs --server
//   && nub scripts/build-package.mjs --shell
// Run: nub scripts/verify-server-updates.mjs --out=/absolute/evidence
import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { createServer as createNetServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import puppeteer from "puppeteer"
import { resolveNpmCli } from "../src/server-release.ts"
import { frizzPaths } from "../packages/server/src/frizz-paths.ts"
import { createRpcClient } from "./lib/rpc-client.mjs"

const workspace = resolve(import.meta.dirname, "..")
const argument = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const out = resolve(argument("out") ?? mkdtempSync(join(tmpdir(), "frizz-server-evidence-")))
mkdirSync(out, { recursive: true })
const root = mkdtempSync(join(tmpdir(), "frizz-server-e2e-"))
const home = join(root, "home"), repo = join(root, "project"), eventFile = join(root, "children.jsonl")
mkdirSync(home); mkdirSync(repo)
writeFileSync(eventFile, "")
const npmCli = resolveNpmCli()
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(FRIZZ_|npm_|NPM_|NODE_OPTIONS|NODE_PATH|CODEX_HOME)/u.test(key)))
Object.assign(env, {
  HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
  XDG_STATE_HOME: join(home, "state"), XDG_CACHE_HOME: join(home, "cache"),
  npm_config_cache: join(root, "npm-cache"), npm_config_userconfig: join(root, "empty.npmrc"),
  npm_config_fetch_retries: "0", FRIZZ_ORPHAN_REAPER_OFF: "1", FRIZZ_TEST_CHILD_EVENTS: eventFile,
  FRIZZ_RUNTIMES_DIR: join(frizzPaths().cache, "runtimes"),
})
writeFileSync(env.npm_config_userconfig, "")
execFileSync("git", ["init", "-q"], { cwd: repo })
const events = [], failures = [], processes = []
const probes = new Set()
const packages = new Map()
let browser, page, registry, base, shellPid, listenerMonitor, monitorEnabled = false
let downloadGate
function record(event, data = {}) {
  const row = { at: new Date().toISOString(), event, ...data }
  events.push(row); console.log(JSON.stringify(row))
}
function children() { return readFileSync(eventFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) }
function alive(pid) { try { process.kill(pid, 0); return true } catch { return false } }
async function until(label, check, timeout = 90_000) {
  const deadline = Date.now() + timeout
  let lastError
  while (Date.now() < deadline) {
    try { const result = await check(); if (result) return result } catch (error) { lastError = error }
    await delay(100)
  }
  throw new Error(`Timed out: ${label}${lastError ? `: ${lastError}` : ""}`)
}
function start(name, args) {
  const child = spawn(process.execPath, args, { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] })
  processes.push(child)
  child.stdout.on("data", (bytes) => appendFileSync(join(out, `${name}.log`), bytes))
  child.stderr.on("data", (bytes) => appendFileSync(join(out, `${name}.log`), bytes))
  child.on("error", (error) => failures.push({ process: name, error: String(error) }))
  child.on("exit", (code, signal) => record("exit", { name, pid: child.pid, code, signal }))
  return child
}
async function freePort() {
  const server = createNetServer()
  server.listen(0, "127.0.0.1"); await once(server, "listening")
  const port = server.address().port
  await new Promise((done) => server.close(done)); return port
}
function pack(directory, manifest) {
  writeFileSync(join(directory, "package.json"), JSON.stringify(manifest))
  const output = JSON.parse(execFileSync(process.execPath, [npmCli, "pack", "--ignore-scripts", "--json", "--pack-destination", out, "--cache", join(root, "packing-cache")], { cwd: directory, encoding: "utf8", env, maxBuffer: 4e6 }))
  const tarball = readFileSync(join(out, output[0].filename))
  const release = { manifest, tarball, integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}` }
  if (!packages.has(manifest.name)) packages.set(manifest.name, { latest: manifest.version, releases: new Map() })
  packages.get(manifest.name).releases.set(manifest.version, release)
  return release
}
function serverFixture(version, fault) {
  const directory = join(root, `server-${version}`)
  cpSync(join(workspace, "packages/server-release"), directory, { recursive: true, filter: (source) => !source.includes("node_modules") })
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"))
  manifest.version = version
  if (fault === "epoch") manifest.frizzServer.dataEpoch++
  const entry = join(directory, "dist/dev-child.js")
  const instrumentation = `
import {appendFileSync as _proofAppend} from 'node:fs';
const _proof = (event) => _proofAppend(process.env.FRIZZ_TEST_CHILD_EVENTS, JSON.stringify({event,pid:process.pid,parent:process.ppid,version:${JSON.stringify(version)},at:Date.now()})+'\\n');
_proof('start'); process.on('exit',()=>_proof('exit'));
const _send = process.send.bind(process); process.send=(message,...args)=>{if(message.type==='frizz-ready'){_proof('ready');${fault === "crash" ? "setTimeout(()=>process.exit(86),100);" : ""}} return _send(message,...args)};
${fault === "exit" ? "throw new Error('INJECTED_BOOT_FAILURE');" : ""}
`
  let contents = readFileSync(entry, "utf8")
  if (fault === "hang") {
    const boot = /(?:const|var) server = await startServer\d*\(/u
    assert.ok(boot.test(contents), "hang injection must follow the real early disconnect guard")
    contents = contents.replace(boot, "await new Promise(()=>setInterval(()=>{},1000)); $&")
  }
  writeFileSync(entry, instrumentation + contents)
  if (fault === "missing") rmSync(join(directory, "web-dist/index.html"))
  // npm must not run this: an install that touches the sentinel is a test failure.
  manifest.scripts = { postinstall: `node -e "require('fs').writeFileSync(process.env.FRIZZ_TEST_CHILD_EVENTS+'.postinstall','bad')"` }
  return pack(directory, manifest)
}
async function status() {
  const response = await fetch(`${base}/_frizz/control/status`, { headers: { origin: base }, signal: AbortSignal.timeout(2000) })
  assert.equal(response.status, 200)
  return response.json()
}
async function action(name = "update-restart") {
  const response = await fetch(`${base}/_frizz/control/${name}`, { method: "POST", headers: { origin: base }, signal: AbortSignal.timeout(name === "restart" ? 90_000 : 5000) })
  assert.equal(response.status, 202)
}
async function healthy(version) {
  return until(`server ${version}`, async () => {
    const value = await status()
    return value.state === "ready" && value.version === version && value
  })
}
function selected() {
  const directory = join(home, "state/frizz/server-releases")
  const key = readdirSync(directory)[0]
  return JSON.parse(readFileSync(join(directory, key, "active.json"), "utf8"))
}
async function stopShell(signal = "SIGTERM") {
  monitorEnabled = false
  await Promise.allSettled([...probes])
  if (shellPid && alive(shellPid)) process.kill(shellPid, signal)
  if (shellPid) await until(`shell ${shellPid} stopped`, () => !alive(shellPid), 30_000)
}
async function launch(version = "0.13.0") {
  const before = children().length
  const child = start(`launcher-${processes.length}`, [npmCli, "exec", "--yes", `--package=frizz@${version}`, "--", "frizz", "--no-app", "--port", new URL(base).port])
  const entry = await until("server process", () => {
    if (child.exitCode !== null) throw new Error(`npm launcher exited ${child.exitCode}`)
    return children().slice(before).find((event) => event.event === "start")
  }, 180_000)
  shellPid = entry.parent
  record("shell-started", { pid: shellPid, npm: child.pid })
  return shellPid
}

try {
  const serverVersion = JSON.parse(readFileSync(join(workspace, "packages/server-release/package.json"), "utf8")).version
  assert.equal(serverVersion, "0.13.0", "update fixture baseline must match shell bootstrap pin")
  const shellDir = join(root, "shell")
  mkdirSync(shellDir); cpSync(join(workspace, "dist"), join(shellDir, "dist"), { recursive: true })
  const manifest = JSON.parse(readFileSync(join(workspace, "package.json"), "utf8"))
  delete manifest.devDependencies; delete manifest.scripts; delete manifest.pnpm
  const shellRelease = pack(shellDir, manifest)
  serverFixture("0.13.0")
  serverFixture("0.13.1")
  serverFixture("0.13.2", "epoch")
  serverFixture("0.13.3", "missing")
  serverFixture("0.13.4", "exit")
  serverFixture("0.13.5", "crash")
  serverFixture("0.13.6", "hang")
  serverFixture("0.13.7")
  serverFixture("0.13.8", "hang")
  registry = createServer(async (request, response) => {
    try {
      const path = decodeURIComponent(new URL(request.url, "http://registry").pathname)
      const packageName = path.split("/")[1]
      const entry = packages.get(packageName)
      if (!entry) {
        const upstream = await fetch(`https://registry.npmjs.org${request.url}`)
        response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/octet-stream" })
        response.end(Buffer.from(await upstream.arrayBuffer())); return
      }
      if (path.includes("/-/")) {
        const version = path.slice(path.lastIndexOf("/") + 1, -4)
        if (downloadGate?.version === version) { downloadGate.requested = true; await downloadGate.promise }
        const release = entry.releases.get(version)
        response.writeHead(release ? 200 : 404); response.end(release?.tarball); return
      }
      const versions = Object.fromEntries([...entry.releases].map(([version, release]) => [version, {
        ...release.manifest, dist: { tarball: `${env.npm_config_registry}${packageName}/-/${version}.tgz`, integrity: release.integrity },
      }]))
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ name: packageName, "dist-tags": { latest: entry.latest }, versions }))
    } catch (error) { response.writeHead(500); response.end(String(error)) }
  })
  registry.listen(0, "127.0.0.1"); await once(registry, "listening")
  env.npm_config_registry = `http://127.0.0.1:${registry.address().port}/`
  base = `http://127.0.0.1:${await freePort()}`
  record("fixture", { root, out, base, registry: env.npm_config_registry, shellIntegrity: shellRelease.integrity })
  const initialPid = await launch()
  await healthy("0.13.0")
  await until("initial selection committed", () => selected().version === "0.13.0")
  const api = createRpcClient(base)
  await api.query("board")
  listenerMonitor = setInterval(() => {
    if (monitorEnabled) {
      const probe = status().catch((error) => failures.push({ control: String(error) })).finally(() => probes.delete(probe))
      probes.add(probe)
    }
  }, 200)
  monitorEnabled = true
  browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] })
  page = await browser.newPage()
  page.on("pageerror", (error) => failures.push({ page: String(error) }))
  const project = JSON.parse(readFileSync(join(home, "data/frizz/registry.json"), "utf8")).projects[0]
  await page.setViewport({ width: 1280, height: 850, deviceScaleFactor: 2 })
  await page.goto(`${base}/project/${project.slug}/`, { waitUntil: "networkidle2" })
  await page.screenshot({ path: join(out, "before-desktop.png") })
  // Slow transfer proves preparation does not stop the healthy child or its existing browser.
  let releaseDownload
  downloadGate = { version: "0.13.1", requested: false, promise: new Promise((done) => { releaseDownload = done }), release: () => releaseDownload() }
  packages.get("frizz-server").latest = "0.13.1"
  await action()
  await until("candidate download requested", () => downloadGate.requested)
  const oldPid = children().find((event) => event.event === "ready").pid
  assert.equal(alive(oldPid), true)
  await api.query("board")
  assert.equal(selected().version, "0.13.0")
  const restartDuringUpdate = action("restart").then(() => undefined, (error) => error)
  await Promise.all([action(), action()])
  releaseDownload(); downloadGate = undefined
  assert.equal(await restartDuringUpdate, undefined)
  await healthy("0.13.1")
  assert.equal(shellPid, initialPid)
  assert.equal(alive(initialPid), true)
  await until("selection version advanced", () => selected().version === "0.13.1")
  assert.equal(children().filter((event) => event.event === "start" && event.version === "0.13.1").length, 1)
  record("slow-update-and-concurrent-actions-passed", { pid: shellPid })
  await until("browser recovered", () => page.evaluate(() => !!document.querySelector('button[aria-label="Restart Frizz"]')))
  await page.screenshot({ path: join(out, "after-desktop.png") })
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 })
  await delay(500)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.screenshot({ path: join(out, "after-narrow.png") })
  for (const [version, reason] of [["0.13.2", "incompatible epoch"], ["0.13.3", "missing asset"], ["0.13.4", "boot failure"], ["0.13.5", "early crash"], ["0.13.6", "boot timeout"]]) {
    packages.get("frizz-server").latest = version
    await action()
    const failed = await until(reason, async () => { const value = await status(); return value.state === "failed" && value })
    assert.equal(failed.version, "0.13.1")
    assert.equal(selected().version, "0.13.1")
    assert.equal(alive(initialPid), true)
    await api.query("board")
    record("candidate-rejected", { version, reason, status: failed })
  }
  packages.get("frizz-server").latest = "0.13.7"
  await page.setViewport({ width: 1280, height: 850, deviceScaleFactor: 2 })
  await delay(600)
  // The real browser button sends the final recovery update, after all injected failures.
  await page.waitForSelector('button[aria-label="Update Frizz"]:not(:disabled)', { visible: true })
  record("browser-control", { url: page.url(), control: await page.$eval('button[aria-label="Update Frizz"]', (element) => element.outerHTML) })
  const accepted = page.waitForResponse((response) => response.url().endsWith("/update-restart") && response.request().method() === "POST").catch((error) => ({ error }))
  await page.click('button[aria-label="Update Frizz"]')
  const response = await accepted
  if (response.error) throw response.error
  assert.equal(response.status(), 202)
  await healthy("0.13.7")
  assert.equal(selected().version, "0.13.7")
  record("browser-update-after-failures-passed")
  // Kill the launcher while a candidate is stuck before ready. The early disconnect guard must
  // reclaim that child; a relaunch must choose the last committed server, not the pending package.
  packages.get("frizz-server").latest = "0.13.8"
  await action()
  const stuck = await until("hanging candidate started", () => children().find((event) => event.event === "start" && event.version === "0.13.8"))
  await stopShell("SIGKILL")
  await until("orphan candidate exited", () => !alive(stuck.pid), 20_000)
  assert.equal(selected().version, "0.13.7")
  packages.get("frizz-server").latest = "0.13.7"
  await launch(); await healthy("0.13.7")
  await api.query("board")
  record("crash-before-commit-recovered", { pid: shellPid })
  await stopShell("SIGKILL")
  await launch(); await healthy("0.13.7")
  record("committed-selection-survived-launcher-crash", { pid: shellPid })
  assert.equal(existsSync(`${eventFile}.postinstall`), false, "dependency postinstall must never run")
  assert.deepEqual(failures, [])
  record("passed", { children: children() })
} catch (error) {
  record("test-failed", { error: error.stack ?? String(error) })
  if (page) await page.screenshot({ path: join(out, "failure.png") }).catch(() => {})
  throw error
} finally {
  if (listenerMonitor) clearInterval(listenerMonitor)
  monitorEnabled = false
  downloadGate?.release()
  if (browser) { await browser.close(); record("browser-closed") }
  await stopShell().catch((error) => record("stop-error", { error: String(error) }))
  const owned = new Set([...children().map((event) => event.pid), ...processes.map((child) => child.pid), shellPid].filter(Boolean))
  for (const pid of owned) if (alive(pid)) { try { process.kill(pid, "SIGKILL") } catch {} }
  if (registry) { registry.closeAllConnections(); await new Promise((done) => registry.close(done)) }
  await delay(500)
  const remaining = [...owned].filter(alive)
  record("cleanup", { remaining })
  writeFileSync(join(out, "evidence.json"), JSON.stringify({ root, events, failures, children: children() }, null, 2))
  assert.deepEqual(remaining, [])
  if (!argument("keep")) rmSync(root, { recursive: true, force: true })
}
