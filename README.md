# Salesforce webhooks for AI agents

Trigger an AI agent the moment a record changes in Salesforce — no polling loops, no streaming-API subscriber to babysit.

Salesforce has no native webhooks. This repo builds them with an Apex trigger that POSTs record changes to [Nango](https://nango.dev), which routes them to the right connection, keeps a records cache fresh in real time, and sends your app a signed webhook. Your app then runs a Claude agent that reacts to the change and writes back to Salesforce (it creates a follow-up Task) through Nango's proxy.

```
Salesforce org                Nango                          Your app
┌────────────────┐   POST    ┌─────────────────────┐  signed  ┌──────────────────┐
│ Contact changes │ ────────▶ │ webhook URL          │ ───────▶ │ /webhooks/nango  │
│ Apex trigger    │           │ → routes to          │  webhook │ → fetch changed  │
│ + @future       │           │   connection         │          │   records        │
│   callout       │           │ → onWebhook sync     │          │ → run AI agent   │
└────────────────┘           │   saves records      │          │ → agent writes   │
        ▲                    └─────────────────────┘          │   back via Nango │
        └────────────────────── create Task ◀─────────────────└──────────────────┘
```

An hourly incremental sync reconciles anything the webhook path misses (Apex `@future` callouts are fire-and-forget), so the records cache is both real-time *and* reliable.

## Prerequisites

- A [Nango account](https://app.nango.dev) (free) with a Salesforce integration using the base `salesforce` provider — **not** `salesforce-sandbox` (inbound webhooks are only routed for the base provider) — and a working connection to a [Salesforce Developer Edition org](https://developer.salesforce.com/signup)
- Node.js 20+
- An [Anthropic API key](https://console.anthropic.com/) for the agent
- A way to expose a local port publicly, e.g. [ngrok](https://ngrok.com/)

## Setup

### 1. Install and configure

```bash
npm install
cp .env.example .env
```

Fill in `.env` (each variable documents where to find its value in the Nango dashboard).

### 2. Deploy the Nango sync

```bash
cd nango-integrations
npm install
cp .env.example .env   # set NANGO_SECRET_KEY_DEV
npx nango deploy dev
```

This deploys [`salesforce/syncs/contacts.ts`](nango-integrations/salesforce/syncs/contacts.ts): webhook events land in `onWebhook` within seconds; the hourly `exec` poll reconciles via checkpoints.

The sync starts automatically and its **first run fetches every existing contact** — that's why this step comes before pointing webhooks at your app (the server also guards against full-sync floods, but ordering makes it safe by construction).

### 3. Provision the Salesforce org

```bash
npm run provision
```

This installs everything Salesforce-side through Nango's proxy using your existing connection's OAuth token — no Salesforce CLI, no Setup UI:

1. A **Remote Site Setting** allowing callouts to `https://api.nango.dev`
2. The **`NangoWebhookNotifier`** Apex class ([source](salesforce/NangoWebhookNotifier.cls))
3. The **`NangoContactTrigger`** Apex trigger ([source](salesforce/NangoContactTrigger.trigger))

> In a multi-tenant product you'd run this same logic in a Nango [`post-connection-creation` event script](https://nango.dev/docs/guides/functions/event-functions) so every new customer connection gets provisioned automatically.

### 4. Point Nango webhooks at your app

```bash
npm run dev        # starts the receiver on :3000
ngrok http 3000    # in another terminal
```

In the Nango dashboard → **Environment Settings → Webhooks**, set the primary webhook URL to `https://<your-tunnel>/webhooks/nango`.

### 5. Trigger it

Open **http://localhost:3000** — a mini "Contact Copilot" app, the shape a real product built on this pipeline would take:

- **Contacts** — served from Nango's records cache (not the Salesforce API), rows flash and re-sort seconds after a record changes in the org
- **Assistant activity** — a card per change: which contact changed, what the AI decided and why, and the Task it created with an *Open ↗* link into Salesforce

Press **Simulate a change in Salesforce** (or edit a Contact in Salesforce yourself) and watch the whole loop run.

The pipeline internals appear in the terminal:

```
📥 Sync webhook: contacts/SalesforceContact (+0 ~1 -0)
   Fetched 1 changed record(s) from Nango's records cache

🤖 Agent run: contact 003gK00000ABCDE was UPDATED
   → Tool call: create_salesforce_task({"contact_id":"003gK...","subject":"Follow up on title change",...})
   Agent: Created a high-priority follow-up task for the rep about Jane's promotion to VP Engineering.
```

Check the Contact in Salesforce — the agent's Task is attached to its activity timeline.

## How it works

| Piece | File | Role |
|---|---|---|
| Apex trigger | [`salesforce/NangoContactTrigger.trigger`](salesforce/NangoContactTrigger.trigger) | Batches changes (bulk-safe), skips no-op updates (loop-safe), fires one async callout |
| Apex callout | [`salesforce/NangoWebhookNotifier.cls`](salesforce/NangoWebhookNotifier.cls) | `@future(callout=true)` POST to Nango's webhook URL |
| Nango sync | [`nango-integrations/salesforce/syncs/contacts.ts`](nango-integrations/salesforce/syncs/contacts.ts) | `onWebhook` saves events in real time; hourly `exec` reconciles |
| Provisioning | [`scripts/provision-salesforce.ts`](scripts/provision-salesforce.ts) | Installs 1–3 via the Tooling API through Nango's proxy |
| Webhook receiver | [`src/server.ts`](src/server.ts) | Verifies signatures, acks fast, fetches changed records by cursor |
| Agent | [`src/agent.ts`](src/agent.ts) | Claude tool-use loop; writes back to Salesforce via Nango |

The routing contract: the Apex payload's `nango.connectionId` tells Nango which connection the event belongs to, and `nango.eventType` is matched against the sync's `webhookSubscriptions`.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Nothing in Nango Logs after editing a contact | Remote Site Setting missing; Apex trigger not deployed; `@future` can lag a few seconds — check Salesforce Setup → Apex Jobs |
| Webhook logged in Nango but sync doesn't run | `eventType` in Apex doesn't exactly match `webhookSubscriptions` in the sync; or the integration uses a non-base provider (e.g. `salesforce-sandbox`) which silently drops inbound webhooks |
| App receives nothing | Webhook URL not set in Environment Settings, or tunnel died |
| `401 invalid signature` | Verify with the **webhook signing key** (Environment Settings → Webhooks), not the API secret key |
| Agent re-triggers itself | The trigger only fires on tracked-field changes; Task creation doesn't touch the Contact. Keep that guard if you extend the trigger |
| Bulk edit produced no agent runs | Intentional: more than `MAX_AGENT_RUNS_PER_WEBHOOK` (10) changes in one webhook skips per-record agent runs to avoid CRM noise and API spend. Raise the cap in `src/server.ts` if you want them |
| Agent ran on old/historical contacts | Shouldn't happen: the server primes the cursor past the sync's initial full run without invoking the agent. If you re-deploy the sync with a cache reset, the same guard applies |

## Learn more

- [Nango webhook functions](https://nango.dev/docs/guides/functions/webhook-functions)
- [Real-time syncs](https://nango.dev/docs/guides/functions/syncs/realtime-syncs)
- [Webhooks from Nango](https://nango.dev/docs/guides/platform/webhooks-from-nango)
- [Tool calling & MCP for AI agents](https://nango.dev/docs/guides/functions/tool-calling)
