# Salesforce webhooks for AI agents

Trigger an AI agent the moment a record changes in Salesforce — no polling loops, no streaming-API subscriber to babysit.

Salesforce has no native webhooks. This repo builds them with Apex triggers that POST record changes to [Nango](https://nango.dev), which routes them to the right connection, keeps a records cache fresh in real time, and sends your app a signed webhook. Your app then runs your AI agent (Claude in this demo), which reacts to the change and writes back to Salesforce (it creates a follow-up Task) through Nango's proxy.

Out of the box it watches **Contacts, Leads, Accounts, and Opportunities** — one config file ([`nango-integrations/salesforce/objects.ts`](nango-integrations/salesforce/objects.ts)) drives the Apex provisioning, the Nango sync, and the app, so adding another object (including custom objects) is a single config entry. Tasks are deliberately excluded: the agent *writes* Tasks, and subscribing to the object your agent writes to makes it react to its own output.

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

Fill in `.env` (each variable documents where to find its value in the Nango dashboard). `NANGO_CONNECTION_ID` is optional — leave it empty to use the real auth flow: the app's **Connect Salesforce** button walks the user through Nango's hosted Connect UI, the `auth` webhook delivers the new connection ID, and the app provisions the org automatically.

### 2. Deploy the Nango sync

```bash
cd nango-integrations
npm install
cp .env.example .env   # set NANGO_SECRET_KEY_DEV
npx nango deploy dev
```

This deploys [`salesforce/syncs/records.ts`](nango-integrations/salesforce/syncs/records.ts): webhook events for every watched object land in `onWebhook` within seconds; the hourly `exec` poll reconciles each object via per-object checkpoints.

The sync starts automatically and its **first run fetches every existing record of every watched object** — that's why this step comes before pointing webhooks at your app (the server also guards against full-sync floods, but ordering makes it safe by construction).

### 3. Provision the Salesforce org

```bash
npm run provision
```

This installs everything Salesforce-side through Nango's proxy using your existing connection's OAuth token — no Salesforce CLI, no Setup UI:

1. A **Remote Site Setting** allowing callouts to `https://api.nango.dev`
2. The **`NangoWebhookNotifier`** Apex class ([source](salesforce/NangoWebhookNotifier.cls)) — the shared handler: change detection, batching, async callout
3. One thin **Apex trigger per watched object** (generated from [this template](salesforce/NangoRecordTrigger.trigger.tpl)): `NangoContactTrigger`, `NangoLeadTrigger`, `NangoAccountTrigger`, `NangoOpportunityTrigger`

> In a multi-tenant product you'd run this same logic in a Nango [`post-connection-creation` event script](https://nango.dev/docs/guides/functions/event-functions) so every new customer connection gets provisioned automatically.

### 4. Point Nango webhooks at your app

```bash
npm run dev        # starts the receiver on :3000
ngrok http 3000    # in another terminal
```

In the Nango dashboard → **Environment Settings → Webhooks**, set the primary webhook URL to `https://<your-tunnel>/webhooks/nango` and enable **Send New Connection Creation Webhooks** (that's how the app learns about newly connected accounts).

If you left `NANGO_CONNECTION_ID` empty, open **http://localhost:3000** now and click **Connect Salesforce**: authorize in the Nango window, and the app captures the connection from the `auth` webhook and provisions the org on the spot — step 3 happens automatically for every account connected this way.

### 5. Trigger it

Open **http://localhost:3000** — a chat interface with the agent, where Salesforce events and your conversation share one feed:

- Edit any watched record in Salesforce and, seconds later, a notice appears ("⚡ A Contact changed in Salesforce") followed by the agent's run: what changed, what it decided and why, and the Task it created with an *Open ↗* link into Salesforce
- Or just talk to it — "how many open opportunities do we have?" — it answers with live SOQL against your org, using the same tools the event-driven runs use

The pipeline internals appear in the terminal:

```
📥 Sync webhook: records/SalesforceContact (+0 ~1 -0)
   Fetched 1 changed record(s) from Nango's records cache

🤖 Agent run: Contact 003ak000005v53LAAQ (Jack Rogers) was UPDATED
   → Tool call: get_salesforce_record({"object_type":"Contact","record_id":"003ak000005v53LAAQ"})
   → Tool call: query_salesforce({"soql":"SELECT Id, Name, StageName, CloseDate FROM Opportunity WHERE AccountId = '...' AND IsClosed = false"})
   → Tool call: create_salesforce_task({"object_type":"Contact","related_record_id":"003ak...","subject":"Introductory outreach to Jack Rogers (Director of Facilities)",...})
   Agent: I created a Normal-priority Task for the sales rep to make introductory outreach...
```

Check the record in Salesforce — the agent's Task is attached to its activity timeline.

## How it works

| Piece | File | Role |
|---|---|---|
| Object config | [`nango-integrations/salesforce/objects.ts`](nango-integrations/salesforce/objects.ts) | Single source of truth: which objects and fields to watch |
| Apex handler | [`salesforce/NangoWebhookNotifier.cls`](salesforce/NangoWebhookNotifier.cls) | Shared logic: change detection (loop-safe), batching (bulk-safe), one `@future(callout=true)` POST per invocation (async-safe) |
| Trigger template | [`salesforce/NangoRecordTrigger.trigger.tpl`](salesforce/NangoRecordTrigger.trigger.tpl) | Single-statement trigger generated per watched object |
| Nango sync | [`nango-integrations/salesforce/syncs/records.ts`](nango-integrations/salesforce/syncs/records.ts) | `onWebhook` saves events in real time; hourly `exec` reconciles per object |
| Provisioning | [`scripts/provision-salesforce.ts`](scripts/provision-salesforce.ts) | Installs the Remote Site Setting, handler class, and all triggers via the Tooling API through Nango's proxy |
| Webhook receiver | [`src/server.ts`](src/server.ts) | Verifies signatures, acks fast, fetches changed records by cursor |
| Agent | [`src/agent.ts`](src/agent.ts) | Claude tool-use loop shared by event runs and chat; queries Salesforce (read-only SOQL) and writes Tasks back via Nango |
| Chat UI | [`src/ui.ts`](src/ui.ts) | Single-page agent chat; Salesforce events stream into the conversation over SSE |

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
