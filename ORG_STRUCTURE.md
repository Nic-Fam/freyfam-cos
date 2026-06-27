# Agent and Company Org Structure

A planning reference for how the family specialists tie in with company-level COO agents. Lives in the freyfam-cos folder alongside PROJECT_CONTEXT.md and CLAUDE.md.

## Companies in scope

| Company | Spelling | Business |
|---|---|---|
| Sasshey | S-A-S-S-H-E-Y | SaaS wardrobe inventory tool plus consignment marketplace. Revenue from membership and brokering consignment/resale sales. (See dedicated MD file for full goal.) |
| Dariviant | D-A-R-I-V-I-A-N-T | Aftermarket parts supply for Rivian and other electric pickups. Rivian-first. Parts business funds the long-term goal: a range-extended overland camper on the R1T platform. |
| Pontable | P-O-N-T-A-B-L-E | Recreational water sports. Primary product is a floating picnic table for lounging in lakes and streams. B2C plus B2B hospitality (hotels and resorts). |

## Holding structure

**freyfam** (freyfam.com) is the holding structure. Not a real company yet. The family chief of staff and all family-level agents live and manage from here. The three companies sit beneath it.

## The hierarchy

```
Chief of Staff  (freyfam, sole external comms gateway)
│
├── Family specialists  (shared, service all companies, keepers of shared templates)
│     ├── Finance
│     ├── Dev (Steve)
│     ├── Resale scout
│     └── Manufacturing engineering standards (shared baseline; AWS / GD&T)
│
├── Sasshey COO
│     ├── Inventory
│     ├── Marketing
│     ├── Buyer behavior analyst
│     └── Sales
│
├── Dariviant COO
│     ├── Supply chain  (owns compliance/certification for now)
│     ├── Inventory
│     ├── Orders
│     ├── Community intelligence  (Rivian / Slate owner forums, Reddit)
│     ├── Manufacturing engineering
│     ├── Sales
│     └── Marketing
│
└── Pontable COO
      ├── Supply chain
      ├── Inventory
      ├── Orders
      ├── Sales
      ├── Marketing
      └── Manufacturing engineering
```

## How it works

**Chief of Staff is the single point of external communication.** For now, nobody but chief of staff sends email or communicates outside. Company COOs make operational decisions, but all outbound (email, SMS, anything external) routes through chief of staff for approval and execution.

**COOs start in the weeds.** Like any early startup, the COO personas have hands-on visibility from the get-go and delegate more as things mature. Rather than each COO connecting directly to raw data, each company has its own specialists that own the operational data and feed it up: specialist to COO, COO to chief of staff.

**Family specialists service all three companies.** Finance, dev (Steve), and the resale scout stay at the freyfam level and get pulled in when a company needs them.

## Shared but splittable

Company specialists inherit from family-level templates and utilities. If Steve makes a tweak to a shared pattern (for example, the inventory schema or manufacturing engineering standards), the change propagates to the company specialists that inherit from it (Dariviant and Pontable inventory, both manufacturing engineering roles).

Architected so it can be peeled out later. If a company takes off and needs its own independent tooling and team, a copy of the relevant family-level resources can be split out without breaking the rest.

## Runtime architecture

- **One orchestrator** runs all four personas: chief of staff plus the three company COOs. Simpler to manage, shared context, lower cost while early.
- **Designed to split.** Architected so spinning out separate daemons per company later is straightforward, avoiding technical debt now.

## Azure subscription and resource groups

**Current state:** Everything (Sasshey dev, the family assistant, all Azure functions) runs under one subscription currently named "sachet dev", because that is what existed when the Azure setup started. Sasshey's prototype app is hosted there via DevOps. The family chief of staff and agents live in GitHub and are hosted through that same Azure context.

**Decision:** Keep a single subscription. The goal is clean logical separation, not billing isolation, so separate subscriptions are not worth the admin overhead. Rename the subscription and use separate resource groups per entity. No cost impact from this change; nothing about what is actually running changes.

### Target state

Rename subscription "sachet dev" to **Freyfam**, then create resource groups:

- **rg-freyfam** - chief of staff and family agents
  - Function App (freyfam-assistant): Node.js 22 LTS, Flex Consumption (orchestrator daemon, Twilio SMS handler, Microsoft Graph email handler)
  - Storage Account: vector memory and persistent JSON
  - Table Storage: three-layer memory
  - Key Vault: Twilio, Microsoft Graph, Anthropic credentials
- **rg-sasshey** - Sasshey prototype app, DevOps pipeline, inventory and marketplace data
- **rg-dariviant** - created when ready
- **rg-pontable** - created when ready

### Migration steps

1. Rename subscription "sachet dev" to "Freyfam" (Azure portal: Subscription > Settings > Rename).
2. Create resource groups: rg-freyfam, rg-sasshey (rg-dariviant and rg-pontable when ready).
3. Move existing resources into the correct groups (freyfam assistant and storage to rg-freyfam, Sasshey app and DevOps to rg-sasshey).
4. Update GitHub Actions / DevOps pipelines to point at the new resource group names.
5. Verify Key Vault references and credentials still resolve after the move.

## Family finance agent: cost and token watchdog

The family finance agent is the shared cost watcher across all entities. Responsibilities:

- **Cost monitoring** across each resource group via Azure Cost Management (rg-freyfam, rg-sasshey, rg-dariviant, rg-pontable).
- **Token usage tracking** for Claude API spend per company COO, including heavy or unusually intensive requests.
- **Escalation to Nic.** When a request or activity crosses a threshold (below), finance flags it and routes up through chief of staff to Nic for a decision.
- **Two paths for high-usage work:**
  1. Approve agent execution - finance green-lights it, the orchestrator runs it.
  2. Hand to Nic - Nic jumps into the subscription account and does the heavy lifting (for example, intensive development work) himself.

**Access rule:** Only Nic uses the subscription account directly. Steve and all other personas operate through the orchestrator, never the subscription account.

## Cost governance thresholds

Finance auto-approves anything below these and escalates to Nic above them, so Nic is not looped in on small routine work.

| Scope | Threshold | Action |
|---|---|---|
| Per-request cost estimate | $10 | Above this, escalate to Nic |
| Per-request token usage | 100,000 tokens (adjustable) | Above this, escalate to Nic |
| Monthly budget per resource group | $80 | Budget + alert on each of rg-freyfam, rg-sasshey, rg-dariviant, rg-pontable |
| Monthly total subscription budget | $400 | Hard limit for the Freyfam subscription |

Note: Azure budgets are notification-only by default. To make the $400 total a true hard stop, wire the budget alert to an action group that throttles or stops resources at the limit.

## Open follow-ups

- Rename the subscription to Freyfam and stand up the resource groups (rg-freyfam first).
- Set Azure budgets and alerts: $80 per resource group, $400 total.
- Camper conversion (Dariviant) is long-term. At that point it becomes a specialty vehicle manufacturer. Parts business funds it. Compliance/certification stays bundled under supply chain until then.
