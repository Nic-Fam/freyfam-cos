# freyfam-cos

Persistent, local-first **chief of staff** for the Frey household. Runs as an
always-on daemon on the MacBook, pulls inbound messages from an Azure queue,
triages them cheaply, and routes to specialist agents at the cheapest sufficient
model tier. A heartbeat keeps it proactive.

See **CLAUDE.md** for the full architecture, constraints, cost strategy, and build
plan (this is the file to open in Claude Code).

## Quickstart

```bash
npm install
cp .env.example .env      # fill in Anthropic, Twilio, Azure Storage, Graph creds
npm run once             # smoke test: one heartbeat tick
npm start                # full daemon
```

Keep it alive across reboots/sleep on the Mac:

```bash
cp deploy/com.freyfam.cos.plist ~/Library/LaunchAgents/   # edit paths first
launchctl load ~/Library/LaunchAgents/com.freyfam.cos.plist
sudo pmset -c sleep 0 disablesleep 1                      # run lid-closed on power
```

## Why this shape

- The MacBook **pulls** from the queue, so it never needs a public endpoint or a
  tunnel. The existing Azure Function stays as the public Twilio webhook and just
  enqueues. Messages survive Mac reboots.
- Triage (cheap Haiku) is the cost lever: route down by default, escalate only on
  real work. Expected all-in cost is roughly **$50-60/mo**.
- Hard constraints are enforced in code: work email domains are inbound-only, and
  high-stakes actions require SMS approval.
