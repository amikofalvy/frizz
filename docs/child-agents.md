# Cross-harness child agents

`frizzctl child` connects portable child-agent clients to Frizz's bundled
supervisor, existing child rows, transcript drawer and control interface. A Claude
parent can own a Codex child, and vice versa. The child has its own runtime and
native session identity; Frizz does not counterfeit provider dispatch events or
register it in a provider's native agent roster.
New workers advertise `FRIZZ_CHILD_AGENTS_PROTOCOL=1`. Portable clients should
select this path from that capability or an explicitly configured adapter, not
from a generic Frizz thread marker. Legacy workers and older Frizz versions keep
their existing launch behavior until the capability is available. An explicitly
selected adapter failure must not fall back to an untracked launch.

## Worker interface

Run `frizzctl child --help` and `frizzctl child --schema` before first use. The CLI
binds the parent from its worker environment. Requests are versioned JSON on
stdin, with an outer `request` field:

```json
{
  "request": {
    "version": 1,
    "action": "start",
    "id": "review-unique-attempt",
    "runtime": "codex",
    "model": "the-selected-model",
    "effort": "medium",
    "permissions": "read-only",
    "label": "Reviewing the change",
    "prompt": "The complete authorized task and return contract",
    "cwd": "/absolute/checkout"
  }
}
```

Frizz bundles its protocol-v1 supervisor and invokes it with its own Node
executable and the validated request on stdin. It selects the native executable
from the same host configuration as normal workers. Worker-supplied helper paths
are ignored; different executable or credential-store overrides are refused.
This is an explicit adapter entry point, not recognition or execution of an
arbitrary shell command. The runtime supports Node 22 or newer on macOS/Linux.
Native tool policies are not OS isolation; this feature is not an authentication
boundary between processes belonging to the same OS user.

Start requires an explicit runtime, model, effort, permissions, prompt and cwd.
An id is 1–100 letters, digits, underscores or hyphens. Frizz chooses the private
run directory. Identical retries return the existing child; a reused id with
different intent is refused. A writing subprocess child requires an explicit bypass
grant on its parent thread. A read-only parent cannot create a writing child;
forwarded descendants cannot exceed their parent agent's recorded grant.
Read-only Claude uses safe mode, user-only settings, disabled hooks and MCP,
noninteractive plan permissions and only `Read`, `Grep`, `Glob`. User-level
authentication settings remain available; project/local customizations do not.
Bounded Codex modes disable configured MCP servers, Apps, plugins and hooks before the
model starts; private configuration reads are not logged. Original session-level
CLI settings remain in force, and the native sandbox response is verified.

For subsequent calls, supply version, action and id:

| Action | Additional fields | Result |
|---|---|---|
| `list` | No id needed | Children owned by this parent |
| `status` | None | Current record and bounded result |
| `message` | `text`, unique `request_id` | Acceptance receipt, not proof of execution |
| `wait` | `after`, initially `0` | A newer completed generation or runtime closure |
| `stop` | None | Close the registered branch and join its runtimes |
| `resume` | `text`, unique `request_id` | Reopen a recorded closed native session with its original profile |

After collecting generation N, a follow-up to an idle child starts the next
generation; wait with `after: N`. Busy-runtime steering can remain in the current
generation. Inspect the task's artifacts rather than treating turn completion as
proof of correctness. Close idle runtimes when no further follow-up is needed.
Resume refuses a live or unresolved writer, missing native identity, changed
profile/grant, or an unfinished branch stop. A message through the child drawer
uses the same safe resume path when the runtime has closed. It never falls back
to a fresh session if native resume fails.

## Supervisor protocol

The bundled supervisor writes `request.json`, atomically replaced `state.json`, and
`events.jsonl` under the supplied run directory. Its launch response is the same
state record, after the control channel becomes ready, not after the task ends.
Frizz checks the receipt against the recorded child before accepting it.

State contains `version`, `id`, owning-thread `parent_id`, optional
`parent_agent_id`, runtime, model, effort, label, run directory, private Unix
socket, timestamps, generation, completed generation, result, alive and
capabilities (`message`, `stop`, `wait`). Status is `starting`, `running`,
`completed`, `failed` or `closed`; an optional outcome distinguishes completed
work from interruption. Native `session_id` is retained for diagnosis and
excluded from foreign-session discovery, so a child does not also appear as a
second top-level thread. Selected native executable and config-store paths are
launch metadata, not credentials.

Control accepts one newline-delimited JSON request per socket connection and
returns one newline-delimited receipt. `error` is a failed/refused operation.
The supervisor owns the actual process handle; a stop never signals a PID
recovered from disk. It publishes heartbeats while alive. After 30 seconds
without one, Frizz reports stale liveness, not successful completion.

Events contain version, monotonic seq, ISO at and kind. Messages carry role and
text. Tool starts carry native id, name and optional input; tool results carry
id, output and completed/failed status. Frizz coalesces text deltas and reads the
latest 1 MiB / 500 complete events for the child drawer. Full native logs remain
on disk. Frizz-owned `ExternalAgent` dispatch cards stay in the parent transcript
after settlement without rewriting its native transcript.

## Host forwarding and lifecycle

Frizz supplies its own callback command and private environment; it does not run
a caller-supplied host command. The child receives a forwarding command rather than the
root's hook identity. Descendant requests carry `parent_agent_id`, which must
name an existing owned agent. Completed ancestors remain as rested anchors while
their branch runs. Stop closes admission to new descendants durably, joins
in-flight launches and closes the branch through each owned control channel.

Completion notifications use Frizz's durable wake outbox, keyed by parent
session, child and generation. Separate durable observed/notified generation
marks prevent notifications after result collection, later rest, outbox pruning
or a server restart. Heartbeats do not republish the transcript, and portable
history has a separate retention quota from native retired drawers. Controls select the
child's adapter rather than the parent backend. Adapter failure never triggers
an untracked standalone replacement. A dead control channel with no terminal
record is unknown work, not permission to start a second writer.

An explicit stop against a missing/refused socket with a stale heartbeat records
`lost: true` and a failed outcome with native closure unverified. It closes branch
admission bookkeeping without signalling a recovered PID or claiming success;
all controls, including native resume, stay disabled for that lost identity.
