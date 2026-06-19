# Specialist Functions — the Azure half of the `delegate` split

This is the deployable form of a freyfam-cos specialist. Each specialist runs as
its own Azure Function (Consumption, scale-to-zero) wrapping the SAME
transport-agnostic core Lloyd runs in-process — [`src/specialists/runner.js`](../../src/specialists/runner.js).
Lloyd reaches it through the `delegate` seam ([`src/delegate.js`](../../src/delegate.js));
flipping `COS_SPECIALIST_MODE=remote` is the whole cutover on his side.

**Status:** the end-to-end remote path is VERIFIED (2026-06-19) on **Flex
Consumption** in eastus: Lloyd's `delegate` → HTTPS + function key → live Flex
Function → `runner.js` → persona + Claude → text back (~4.4s incl. cold start).
Use **Flex Consumption**, not classic Linux Consumption (whose host would not
start in this subscription/region). Deploy with `--build remote` (see below).

## Files

- `app/specialist.mjs` — HTTP handler. Validates `{agent, task}`, enforces the
  `COS_AGENT` pin, calls `runSpecialist`, returns `{text}`.
- `host.json`, `package.json` — Functions v4 host + the runner's runtime deps.
- `../provision-specialists.sh` — creates the infra (one app + identity + table per agent).
- `../publish-specialists.sh` — bundles `src/` with the host, deploys, prints the `.env` block.

## How isolation is enforced (matches the CONFIRMED topology)

Four layers, none of which depend on keeping compute warm:

1. **Auth** — `authLevel: "function"`, so a caller must present the function key.
   Lloyd sends it as `x-functions-key` (per-agent key, see `delegate.js`).
2. **Identity** — each app runs under its own system-assigned managed identity,
   granted `Storage Table Data Contributor` on **only its own table**. Finance's
   identity cannot read Chef's data.
3. **Agent pin** — `COS_AGENT` names the one agent an app may serve; a misrouted
   task for another agent is refused with 403.
4. **No channel** — a specialist only returns text. Outbound + the confirmation
   gate live exclusively on Lloyd, so a remote specialist gains no new powers.

## Order of operations

```bash
# 0. Prereqs: az login, the right subscription selected, `func` installed.
export ANTHROPIC_API_KEY=sk-ant-...        # the inference key

# 1. Stand up infra (idempotent).
bash deploy/provision-specialists.sh

# 2. Deploy code + get the .env block.
bash deploy/publish-specialists.sh

# 3. Paste the printed COS_SPECIALIST_* lines into Lloyd's .env, restart daemon.
#    Cutover is per-agent: include only the specialists you want remote.
```

## ⚠️ Dependency: Tables-backed memory must land before remote recall persists

The runner's memory + decision log ([`src/memory.js`](../../src/memory.js),
[`src/decisions.js`](../../src/decisions.js)) currently write **local JSON files**.
On a Consumption Function the filesystem is **ephemeral and not per-specialist
scoped**, so as-is a remote specialist will *reason* correctly but its
`recall`/`remember`/decision-log writes won't persist across cold starts.

Provisioning already wires the target store: each app gets `COS_TABLE_ENDPOINT`
+ `COS_TABLE_NAME` and an identity scoped to that table. The remaining work
(tracker: "Move specialist stores from local JSON to Azure Tables") is to add a
Tables-backed implementation behind the existing `recall`/`remember` and
`logDecision`/`listDecisions` interfaces, selected when `COS_TABLE_ENDPOINT` is
set. Because those interfaces are stable, that's a store swap inside the runner —
no caller changes. **Do this before relying on remote specialist memory.**

Until then, treat remote mode as verified for *stateless* specialist reasoning
(e.g. finance analysis on data passed in the task). Stateful specialists (chef
inventory, resale saved-searches) should stay `local` until the Tables store is in.

## Troubleshooting (Linux Consumption gotchas, learned the hard way)

- **Never ship `node_modules` built on macOS.** Deploy source only and build on
  Linux with `func ... publish --build remote` (publish-specialists.sh does this).
  A macOS bundle crash-loops the host → `503` and then deploys can't even connect.
- **`EnableWorkerIndexing` is required** for the v4 Node model or the host never
  discovers the function (`Error calling sync triggers`, empty function list).
  provision-specialists.sh sets it as an app setting.
- **An undeployed Linux Consumption app returns `503` at its root** — that alone
  is not an error; only worry once a deploy has succeeded and it still 503s.
- **Do NOT set `WEBSITE_RUN_FROM_PACKAGE=0` / `SCM_DO_BUILD_DURING_DEPLOYMENT`**
  on Linux Consumption — it only supports run-from-package; `func --build remote`
  manages that setting for you.
- **If all apps 503 (including a never-deployed one) and deploys fail to connect
  with `503 Site Unavailable`,** the fault is platform-side (host not starting),
  not the code. Check: storage health (`allowSharedKeyAccess`, network
  `defaultAction`), the Consumption plan, region capacity, and subscription
  quotas/Policy. Verified-good code can still be blocked here — keep specialists
  `local` (the working default) until the hosting is sorted.
