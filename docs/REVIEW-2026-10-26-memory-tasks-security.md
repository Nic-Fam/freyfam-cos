# Tasks, memory, and security closure: re-analysis (2026-10-26)

Scope: why the morning digest mishandles tasks, why Lloyd forgets things within
hours, why long-term memories rarely form, and why Frank will not let issues close.
Read against the review branch with `main` merged in (calendar fixes included).
This is a code-level analysis. The live `data/` directory (brain, tasks, findings,
logs) is not in the repo, so nothing here is measured from production; the two
simulations below run the real modules against scratch stores.

The short version: none of these are model-quality problems. Each one traces to
plumbing that loses information between components.

---

## 1. Tasks and the morning digest

### T1. "done 2" closes the wrong task (verified by simulation)

The numbered list the family sees is written by the model inside the digest. The
number in a "done 2" reply is resolved by code (`tasks.js` `find()`) against the
**live** open-task list, re-sorted at the moment the reply arrives. Three ways
those disagree:

- **Multi-item replies shift.** "done 1 and 3" makes the chief call
  `complete_task("1")`, which removes item 1, then `complete_task("3")`, which now
  points at what used to be item 4. Simulated against the real store with the
  list showing `3. Renew car registration`, "done 1 and 3" closed the Deborah
  follow-up and the **school form** (old item 4). Car registration stayed open.
- **The digest filters, the resolver does not.** The digest is told to show
  "every open follow-up plus anything overdue or due today". A future-dated
  non-follow-up task (car registration, due in four days) is legitimately left out
  of the digest, so the model renumbers what it shows. Code still counts it, so
  every number after it is off by one.
- **The list changes between 6am and the reply.** A task added or closed during
  the day, or a "due today" item becoming "overdue" the next morning, re-sorts the
  live list. The digest's numbers are frozen; the resolver's are not.

### T2. Closed follow-ups come back under new wording (verified by simulation)

Each morning the digest re-derives follow-ups from yesterday's calendar and calls
`add_task`. Dedup is an exact match on the normalized title (`tasks.js:39-45`).
The model words the same follow-up differently day to day. Simulated: closing
"Follow up: email Deborah re: Fairview tour" and then adding "Follow up with
Deborah about the Fairview tour" creates a **new open task**. That is the "I
already cleared that" loop.

### T3. Nothing ever ages out

An uncleared follow-up stays on the digest as OVERDUE forever. There is no "not
needed" outcome distinct from "done", no snooze, and no point at which Lloyd asks
"still need this?" and then drops it. The list only grows.

### T4. Slack replies to the digest have no context

The digest is posted to Slack and emailed, but it is never written into anyone's
conversation thread (`appendTurn` has exactly one caller, the end of
`handleInbound`). A Slack "done 2" reaches a chief who has never seen the digest.
Email replies limp along on the quoted text; Slack replies have nothing.

---

## 2. Short-term memory (hours to days)

### M1. The thread is wiped after 45 minutes

`conversation.js`: `IDLE_TTL_MS = 45 min`, `MAX_MESSAGES = 12`. After 45 quiet
minutes the whole thread is treated as gone, and the next `appendTurn` **deletes**
every stale thread from disk. There is no layer between "the last 45 minutes" and
"facts someone explicitly saved". Hours-to-days memory does not exist by design.

### M2. Lloyd's own outbound messages are not in the thread

The digest, proactive heads-ups, approval prompts and their outcomes, background
results (a grocery cart built, a reservation booked), reminders: none of these are
recorded as assistant turns. So "yes, do that", "the second one", "it's fine",
"done 2" all arrive with no referent unless the family's mail client happened to
quote it.

### M3. One person, three amnesiac threads

Threads are keyed by `channel:from`. Nic on email, Nic on Slack, and Nic on
iMessage are three unrelated conversations. Starting something on Slack and
following up by email loses it.

### M4. Recall is noise on short replies (verified by simulation)

Every turn injects the top four memories ranked against the raw message text,
with no minimum score. For "done 2" or "yes do that" every memory scores 0.00 and
four arbitrary facts are injected anyway. (Simulation used lexical recall; with
the local embeddings live in production the scores are nonzero but there is still
no threshold.)

---

## 3. Long-term memory

### L1. Memories only form when the model remembers to call `remember`

There is no automatic capture. The chief is one of ~70 tools deep, often on Haiku
at low effort, and is told to remember "durable facts and preferences". Events and
outcomes ("we toured Fairview and liked it", "the plumber quoted $1,800") are not
facts or preferences, so they are never saved, and the 45-minute thread that held
them is deleted (M1). Nothing summarizes a conversation before it is thrown away.

### L2. Superseded facts tie with current ones (verified by simulation)

`remember` never deduplicates or supersedes. Saving "the tour moved to Thursday"
after "the tour is Tuesday" leaves both; recall scored them identically (0.52 and
0.52) and returns them side by side. There is no recency weighting and **no tool
to forget or correct a memory** (`forget()` exists in `memory.js` but only the
resale code calls it).

### L3. Specialist memories and rules go to a drawer nobody opens (split brain)

This is the most consequential finding in this review.

- The chief's `remember(text, agent=...)` and `add_rule(text, agent=...)` write to
  **Lloyd's** disk (`data/brain.json`, `data/house-rules.json`).
- Since the June split, finance, resale and chef run in Azure and read their own
  Table stores; Frank and Steve run on their own Macs and read their own
  `data/` directories (`specialists/runner.js` calls `recall()` and
  `getAgentRules()` on the machine where it runs).
- Nothing syncs the two. Every "remember this for Carmine", every "Frank, always
  treat X as fine", every standing rule set for a specialist since June has been
  written where that specialist never reads it. The chief confirms "saved", so it
  looks like it worked.

`deploy/setup/lloyd-mac-mini.md:161` even cites "the security rule that says the
family's own email volume isn't a threat" as living in Lloyd's
`house-rules.json`. Frank does not read that file.

---

## 4. Security will not accept "closed"

### S1. Closure lands on Lloyd; the finding lives on Frank

Frank's findings are on Frank's Mac mini (`data/security-findings.json` there).
When the family says "that's fine", the chief's persona tells it to call
`dismiss_alert`, which writes to **Lloyd's** `heartbeat-alerts.json`. Frank's
finding stays `open`. The chief has no tool to resolve a Frank finding; the only
route is a free-text `delegate` asking Frank to look up the id and resolve it, and
nothing in the persona tells the chief to do that.

### S2. Frank is told to look for a resolution he can never find

Frank's persona says: do not re-litigate a closed incident, "check the decision
log / your memory for the resolution". The resolution is never written there: the
chief's `remember(agent="security")` goes to Lloyd's disk (L3), and Frank's
decision log is only written by Frank himself. The persona also has no rule that
the family's word closes a finding. A breach finding whose recommendation is
"change the password" can stay open indefinitely because Frank cannot verify it.

### S3. Every morning, every open finding is re-reported

The digest asks Frank for "any security flags". Frank answers with
`security_posture`, which lists every open finding. With no way to close them
(S1, S2), the same items reappear daily.

### S4. The heartbeat re-alerts on mail it already judged

`gatherSignals` sends the 15 newest inbox headers, read or unread, to Haiku
whenever any of them changes. One new email re-triages all 15, including a
security-looking email from days ago. The dedup key is the **model's paraphrase**
(`item.what`), so a reworded flag is a new alert, and even an identical one
re-fires after 24 hours. The escalation runs the chief on Sonnet, which often
delegates to Frank, who logs a new finding under a new title (Frank's dedup keys
on the first eight words of the title). A single password-reset email the family
triggered themselves can produce an alert a day and a pile of findings for as long
as it sits in the top 15.

---

## 5. Fix plan

Ordered by leverage. Each item is independent and testable without a live API.

1. **Fix the split brain (L3, S1, S2).** Add zero-model `remember`, `forget`,
   `add_rule`, `remove_rule`, `list_rules`, and `resolve_finding` ops to
   `specialists/ops.js`, and have the chief's `remember`/`add_rule` with an
   `agent` go through `delegate` (op form) whenever that specialist is remote. A
   one-time migration script pushes the agent-scoped memories and `agentRules`
   already sitting on Lloyd's disk to each specialist.
2. **Deterministic "done N" (T1, T4).** Render the task section of the digest in
   code and persist a snapshot `{number -> task id}` per digest. Handle
   `done 2`, `done 1, 3`, `done all` in `handleInbound` before triage (the same way
   approvals are handled), resolving against the snapshot the family was looking
   at, with no model run. Reply with the names of what was closed.
3. **Follow-up identity (T2, T3).** `add_task` takes an optional source reference
   (the calendar event id) and dedups on it forever, with fuzzy title overlap as a
   fallback. Overdue follow-ups get one "still need this?" at 7 days and move to
   `dropped` at 14. Add a "not needed" outcome distinct from done.
4. **Security closure (S1-S4).** A chief tool `close_security_issue` that resolves
   the matching Frank finding (via the op from step 1) **and** dismisses the alert,
   recording who closed it and why. Frank's persona: the family's word closes a
   finding, no proof required. The digest asks Frank only for findings that are new
   or changed since the last digest. The heartbeat triages each mail message id
   exactly once and never re-triages it.
5. **Short-term memory (M1-M3).** Record every outbound Lloyd message as an
   assistant turn in the recipient's thread. Key threads by person, not channel.
   Replace the 45-minute wipe with a 72-hour window: the last ~12 turns verbatim
   plus a short rolling summary of older turns, and inject a deterministic
   "last 48 hours" block (actions taken, tasks opened/closed, approvals) built from
   the audit log.
6. **Long-term memory (L1, L2, M4).** When a thread goes quiet for ~2 hours, one
   Haiku 5.5 pass extracts facts, preferences, decisions and outcomes and saves
   them with supersede-on-conflict. Add a `forget`/`correct_memory` tool. Recall
   gets a minimum score, a recency boost, skips superseded items, and is skipped
   for short acknowledgments.

Cost of steps 5-6 at household volume: one extra Haiku 5.5 call per idle thread and
one per day for the summary, roughly cents per month. Steps 1-4 add no model calls
and remove some.
