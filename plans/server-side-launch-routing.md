# Launch routing belongs to the server: one request, one fixed host, one more shell release

Design plan, 2026-10-11. Prompted by two `frizz` shell releases in one day that changed nothing but where a launch lands (0.13.10 and 0.13.11, which npm then served out of order), and by the maintainer's question that day: *"why did we need to bump Frizz in the first place. The whole point is that we don't need to bump Frizz very often, and we can just bump Frizz server."* Status: **PROPOSED. Only the items marked done in §8 are built.**

**Verdict: stop deciding anything about projects in the shell.** The shell keeps the machinery that has to work while the server is down: the supervisor, the public listener, the sign-in gate, the terminal readout, the installer. Everything that is a rule about folders moves to the server: which folder a launch is about, whether it is a project, whether to register it, and where the browser lands. Two changes do that, and they only work together:

1. **The shell asks the running server where to land** (`POST /_frizz/control/launch`), instead of working it out.
2. **The shell always starts the server on Frizz's own folder**, never on the folder the command was typed in, so it needs no rule about folders before a server exists to ask.

Both ride in ONE shell release. After it, a change to launch behaviour is a `frizz-server` release, which npm serves in minutes, not a shell release, which npm has held for 1h, 3.4h, 15h and 9h this week.

---

## 1. What has been forcing shell releases

Every shell release since 2026-10-01, and the launcher commits that made each one necessary (`git log <previous>..<release> -- src`, tests excluded):

| Shell | What forced it | A rule about folders? |
| --- | --- | --- |
| 0.13.7 | `R` after a restart, the sign-in screens, the QR glyphs | no, terminal readout |
| 0.13.8 | custom frizz.sh names through a GitHub device flow | no, tunnel sign-in |
| 0.13.9 | refuse a world-writable folder as a project; 30-day sessions | **partly** |
| 0.13.10 | the first `frizz` on a machine opens the folder it was run in | **yes, entirely** |
| 0.13.11 | a folder that is not a project opens the dashboard; revert of 0.13.10 | **yes, entirely** |
| 0.13.12 | nothing; re-cut so `latest` followed the out-of-order 0.13.10 | no |
| 0.13.13 | never borrow a project to run on; deleted launch folder; update errors | **partly** |
| next | a world-writable folder can be a project again (`7ff10189`, already on `main`) | **yes** |

Four of seven, and the next one too. The reason is mechanical: the shell bundle (`dist/frizz.js`) contains its own copy of the registry and project-root code from `packages/server/src`, so a rule changed there reaches a running server through a server release and reaches the launch path only through a shell release. `7ff10189` is the clean example. It edits `packages/server/src/project-root.ts` and is still inert for `npx frizz` in a folder until a shell ships.

## 2. What the shell decides today

All of it in [`src/launcher.ts`](../src/launcher.ts) and [`src/production.ts`](../src/production.ts), as of `a2a498dd`:

| Decision | Where | Needed before a server exists? |
| --- | --- | --- |
| Which folder is the launch about (Git top level, marker walk-up, worktree identity) | `resolveWorkspace`, `discoverProjectRoot` | only to pick the host |
| Is it a project Frizz knows, an offer, or nothing (`open` / `offer` / `grid`) | `resolveLaunchIntent` | only to pick the host |
| Which folder the server runs on: the project for `open`, Frizz's own folder otherwise | `resolveLaunchIntent`, `hostWorkspace` | **yes** |
| Register the project and mint its URL name | `ownSlug` → `registerProject` | no |
| The landing URL: `/project/<name>`, `/`, or `/?add=<folder>` | `slugPath` | no |

The third row is why the first two cannot simply move. On a cold start there is no server to ask, and the shell must already have classified the folder to choose what to run the server on. That is also the row behind today's incident: the server was run on a user's folder, the folder was deleted, and every restart and update on the machine failed with it.

## 3. The design

**Mechanism in the shell, rules in the server.** The shell knows how to start, supervise, expose and update a server. It does not know what a project is.

- A cold start runs the server on Frizz's own folder (`<data>/host`, which `a2a498dd` already uses for every launch outside a project), waits for it to be healthy, then asks it where to land.
- A second launch, which finds a server already running, asks the same question and exits.
- The server answers from the registry, with the same code that serves the dashboard's "add a folder".

The alternative the maintainer raised, moving the whole launcher into `frizz-server`, is rejected in §9.

## 4. The request

`POST /_frizz/control/launch` on the **server child**, not on the supervisor. The supervisor's routes run in the launcher process and ship with the shell, which is the thing being avoided. It is answered before tenant routing, as `/_frizz/<name>/health` already is, so asking never opens a project.

```
POST /_frizz/control/launch
x-frizz-launch-token: <owner token>
{ "protocol": 1, "dir": "/Users/me/code/app/packages/web", "args": [] }

200 { "protocol": 1, "path": "/project/app", "project": { "name": "app", "dir": "/Users/me/code/app" } }
200 { "protocol": 1, "path": "/?add=%2FUsers%2Fme%2Fscratch", "notice": "…" }
200 { "protocol": 1, "path": "/" }
```

- **`dir`** is the folder the command was typed in, untouched. The server does the walk-up, the Git lookup and the worktree identity. **`args`** are the positional arguments the shell did not consume; nothing reads them yet, and forwarding them now is what lets a later `frizz <something>` ship without a shell release.
- **`path`** is opaque to the shell, which appends it to the origin it already holds. The shell accepts only a path that starts with a single `/`, so no answer can send the browser to another origin. **`project`** feeds the readout's "Project" row; **`notice`** is one line to print.
- **Who may ask.** The server refuses any request without an `Origin` header except a short list ([`app.ts`](../packages/server/src/app.ts)); this route joins that list and is gated the way `/control/stop` is, by a token only the same OS user can read. For `npx frizz` that is the machine-wide owner token in `<state>/frizz-server/address.json`, which the server child already receives (`FRIZZ_SERVER_OWNERSHIP`, [`dev-child.ts`](../packages/server/src/dev-child.ts)) and now keeps. `frizz-dev` holds no machine-wide lease and sends the hosting folder's launch token, which is what `/control/stop` checks today.
- **What it may do.** Exactly what the shell does today in the same folder as the same user: run `git rev-parse` there, write `.frizz/.id`, add a registry entry. Nothing new is reachable.
- **One registration rule.** Today there are two: the dashboard's add ([`addProjectAtPath`](../packages/server/src/router.ts): the chosen folder is the project) and the launcher's (walk up to the repository). The route uses the launcher's, moved into a server module that the shell's fallback imports.

**When the server cannot answer**, the shell uses the rules it carries today, frozen: a server that predates the route (403 or 404), a child that is restarting (503; the public address is published before the child is ready, so the shell retries for a few seconds first), or a timeout. That fallback is never edited again, only deleted one day.

## 5. Why the fixed host is not optional

The request alone moves the landing and the registration, but not the classification, because a cold start would still classify the folder to choose what to run the server on. Cold starts are most launches. A rule changed in the server would then disagree with the shell's frozen copy at exactly the moment it mattered: the server would be running on a folder its own rules no longer accept. (An earlier message on this thread said the request alone would have turned 0.13.10 and 0.13.11 into server releases. It would not have; both changed which folder the server runs on.)

With the host fixed, the cold start needs no rule at all, and it also removes a mode rather than adding one. After 0.13.13 there are two ways a server runs: on a user's project, and on Frizz's own folder. This deletes the first. The second is the one every launch outside a project already exercises.

What it fixes beyond release cadence:

- **A deleted, moved or unmounted launch folder can no longer break the machine's board.** Today (`755018d6`) Restart and Update are refused once the folder is gone, and the board must be stopped and started again.
- **Remote sign-ins stop depending on where the command was typed.** The session key, the signed-in device list and the session epoch live in the hosting folder's state folder (`loadSessionState(workspace.stateDir)`), so starting Frizz from a different project is a different key.
- **One remembered port, one place for launcher logs, one `--app` window profile**, instead of one per folder Frizz was ever started from.

## 6. What moves when the host is fixed

| Keyed on the hosting folder today | After |
| --- | --- |
| The launch owner record that `--stop` and `--status` read | Always the stand-in's. They read it directly, and keep today's port probe for a board an older shell started on a project. |
| Session key, device list, session epoch | The stand-in's. **Carried over once** from the most recently written copy among the project state folders, so no remote device is signed out by the move. |
| Preferred port, launcher logs, `--app` browser profile | The stand-in's. Not carried over: the default port is the usual answer, and the window profile resets once. |
| The server child's working directory (the supervisor requires it to equal the hosting folder) | A folder Frizz owns and nobody deletes. |
| "Another process is already serving this project" ([`servedByAnotherProcess`](../packages/server/src/project-launch.ts)) | See below. |
| Registry recovery after a lost `registry.json` (`backfillRegistry` reads the folder from three files a launch writes) | Reads the serving record below as a fourth source. |
| The unprefixed API (`/_frizz/rpc/…` with no project name) | Answers for the stand-in, an empty board, as it already does for every launch outside a project. |

**The one piece of new server work.** The double-serve check reads a project's launch owner record, and only the hosting folder has one. Today that still protects the folder `npx frizz` was typed in from a `frizz-dev` running beside it under the same home. With a fixed host nothing would. So a server that opens a project writes a small **serving record** in that project's state folder (pid, boot id, folder), removes it on close, and refuses to open a project whose record names another live process. This is a strict improvement: a project opened from the dashboard takes nothing today, so two servers can already both schedule it.

`frizz-dev` uses the same launcher module and gets the same change. It keeps its own stand-in folder (`<data>/host-dev`), so a source-built Frizz and an installed one can still run side by side under one home as they can today. The two have shared `<data>/host` since `a2a498dd`; what a `frizz-dev` typed outside a project does while an installed Frizz is running there is unverified.

## 7. A shell newer than the installed server

This is normal, not an edge case. `npx frizz` fetches the newest shell on every run, and the server only moves when someone clicks Update: `ServerReleaseStore.load()` boots the selected server and never looks at the shell's pin unless the data epoch changed. The maintainer's own board was shell 0.13.11 on server 0.15.18 this morning.

**It already bites.** Shell 0.13.13 runs every launch outside a project on `<data>/host`. The server learned to keep that folder off the dashboard in 0.15.21 (`49000c91`). A server at 0.15.20 or older has no such refusal and re-registers every state folder at boot, so it lists the stand-in as a project named "host"; the entry outlives an update, because the refusal is at registration and nothing filters the list. Read from the 0.15.20 source at `adada8ec`; the reproduction is the first check in §8.

**The rule: a shell declares the oldest server it works with, and installs its pinned one when the installed server is older.**

- `frizzServer.minimum` in the shell's manifest, beside `version`. Absent means no floor, which keeps every shell so far unchanged.
- At a cold start, a selected server below the floor is replaced by the pinned one through the path a new machine and a data-epoch change already take (`prepareInitial`): staged, validated, booted, and recorded as the selection only after it comes up. If it does not come up, the old selection stands.
- Never while a server is running. A second launch joins whatever is there and falls back per §4.
- If npm cannot be reached, the launch fails with that reason, as a new machine's does. A shell newer than its server came from npm seconds earlier, so this is a narrow case.

The cost is that starting Frizz can replace the server without a click on Update. It only ever moves it up, to the exact version the shell was released against, at a moment nothing is running. The floor is also what keeps §4 and §6 honest: the shell that fixes the host is never paired with a server that lacks the route, the serving record or the list filter.

## 8. Order of work

Server work first, because it ships in minutes and is inert until a shell asks for it. Then one shell release.

| # | Change | Ships in | State |
| --- | --- | --- | --- |
| 1 | The floor: `frizzServer.minimum`, raised at cold start | shell | not built |
| 2 | Keep the stand-in off the project list even when an older server registered it, and drop the entry | server | not built |
| 3 | The launch-routing module (classification, registration, landing) in the server package; `POST /_frizz/control/launch` | server | not built |
| 4 | The serving record: written on open, checked before opening, read by registry recovery | server | not built |
| 5 | Always host on the stand-in; carry the session state over; `--stop` and `--status` read the stand-in | shell | not built |
| 6 | Ask the server where to land; freeze today's rules as the fallback; stop registering from the shell | shell | not built |

Item 1 is useful alone and is the fix for §7, so it lands first and can ride in whichever shell release is next. Items 5 and 6 go out together, with `minimum` set to the server release that carries 2 to 4.

## 9. Not doing

- **Moving the whole launcher into `frizz-server`.** The launcher is what replaces a broken server and what stays up while one restarts. Inside the server package it would be replaced by the thing it supervises, with no older copy to fall back to; a first boot would still need a pinned launcher in the shell; and a launcher fix would reach `npx frizz` users later than it does now, since the shell is fetched on every run and the server only on Update. It is also the least tested code in the repository to rewrite for a problem that §1 shows is mostly about folder rules.
- **Answering on a supervisor route.** It runs in the launcher process, so it ships with the shell.
- **A capability list instead of a floor.** The fallback in §4 is already per-request negotiation. A floor is one number, and it removes old pairings from the test matrix rather than adding branches for them.

## 10. Verification

On real built artifacts, in [`scripts/verify-server-updates.mjs`](../scripts/verify-server-updates.mjs), which already drives a packed shell and server against a fixture registry:

1. An installed server below the floor is replaced before boot, and the stand-in is not on the project list. Control: without the floor, the "host" entry appears.
2. `frizz` in a known project lands on `/project/<name>`; the server is running on the stand-in; the registry entry was written by the server.
3. `frizz` in a marked folder Frizz has not seen lands on `/?add=`; in an unmarked one, on `/`.
4. A second `frizz` in another project joins and lands on that project, including while the child is restarting.
5. Against a server that predates the route, every case above lands where it does today.
6. Deleting the folder the command was typed in leaves Restart and Update working.
7. A remote device signed in before the move is still signed in after it.
8. Two servers under one home never both open one project.

Plus unit coverage where each rule lives: the route's token and origin handling and its classification table beside the server module, the floor in [`src/server-release.test.ts`](../src/server-release.test.ts), the frozen fallback in [`src/launcher.test.ts`](../src/launcher.test.ts).
