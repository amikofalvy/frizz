import { test } from "node:test"
import assert from "node:assert/strict"
import { powershellQuote, providerResumeCommand, shellQuote } from "./external-terminal.ts"

// The resume line is pasted into whatever shell the operator has open, so its spelling is per
// platform: the POSIX form fails in cmd.exe (`'` is literal) and in Windows PowerShell 5.1 (no `&&`),
// which is why win32 gets the PowerShell form (Windows audit 2026-09-11, finding 13). Both are pinned
// byte for byte, including the quoting of the one character each form has to escape.

test("posix: cd && provider resume, single-quoted with the POSIX escape for an embedded quote", () => {
  for (const platform of ["darwin", "linux"] as const) {
    assert.equal(providerResumeCommand("claude", "/work/frizz", "session-id", platform), "cd '/work/frizz' && claude --resume 'session-id' --dangerously-skip-permissions")
    assert.equal(providerResumeCommand("codex", "/work/it's frizz", "session-id", platform), "cd '/work/it'\"'\"'s frizz' && codex resume 'session-id' --dangerously-bypass-approvals-and-sandbox")
  }
  assert.equal(shellQuote("a'b"), `'a'"'"'b'`)
})

test("win32: Set-Location -LiteralPath; & provider resume — runs in every PowerShell version", () => {
  assert.equal(
    providerResumeCommand("claude", "C:\\Users\\op\\frizz", "session-id", "win32"),
    "Set-Location -LiteralPath 'C:\\Users\\op\\frizz'; & claude --resume 'session-id' --dangerously-skip-permissions",
  )
  assert.equal(
    providerResumeCommand("codex", "C:\\Users\\op\\it's frizz", "session-id", "win32"),
    "Set-Location -LiteralPath 'C:\\Users\\op\\it''s frizz'; & codex resume 'session-id' --dangerously-bypass-approvals-and-sandbox",
  )
  assert.equal(powershellQuote("a'b"), "'a''b'")
  // Backslashes are not escapes inside a PowerShell single-quoted string, so a Windows path is verbatim.
  assert.equal(powershellQuote("C:\\x\\y"), "'C:\\x\\y'")
})

test("the default platform is this process's", () => {
  assert.equal(providerResumeCommand("claude", "/w", "s"), providerResumeCommand("claude", "/w", "s", process.platform))
})
