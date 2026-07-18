# Salesforce webhooks for AI agents

Companion repo for the tutorial: [How to trigger your AI agents on Salesforce webhooks](https://nango.dev/blog/how-to-trigger-ai-agents-on-salesforce-webhooks).

A user connects their Salesforce account, the app installs Apex webhook triggers in their org through [Nango](https://nango.dev), and an AI agent (Claude) runs on every record change and writes a follow-up Task back to Salesforce.

![Demo: a Salesforce record change triggers an AI agent that writes back to the CRM](docs/salesforce-webhooks-ai-agent-demo.gif)

It watches Contacts, Leads, Accounts, and Opportunities. One config file, [`nango-integrations/salesforce/objects.ts`](nango-integrations/salesforce/objects.ts), drives the Apex provisioning, the Nango sync, and the app. Add an entry to watch another object, including custom objects.

The tutorial explains how everything works. This README covers getting the repo running.

## Prerequisites

- A [Nango account](https://app.nango.dev) (free) with a Salesforce integration on the base `salesforce` provider (`salesforce-sandbox` doesn't route inbound webhooks)
- A [Salesforce Developer Edition org](https://developer.salesforce.com/signup) (free)
- Node.js 20+
- An [Anthropic API key](https://console.anthropic.com/)
- A way to expose a local port publicly, e.g. [ngrok](https://ngrok.com/)

## Setup

### 1. Install and configure

```bash
npm install
cp .env.example .env
```

Fill in `.env`. Each variable documents where to find its value in the Nango dashboard.

### 2. Deploy the Nango sync

```bash
cd nango-integrations
npm install
cp .env.example .env   # set NANGO_SECRET_KEY_DEV
npx nango deploy dev
```

Do this before pointing webhooks at your app: the sync's first run snapshots existing records, and the server primes its cursor past that snapshot instead of sending history to the agent.

### 3. Point Nango webhooks at your app

```bash
npm run dev        # starts the receiver on :3000
ngrok http 3000    # in another terminal
```

In the Nango dashboard, go to *Environment Settings → Webhooks*, set the primary webhook URL to `https://<your-tunnel>/webhooks/nango`, and enable **Send New Connection Creation Webhooks**. Without it, the `auth` webhook never reaches the app.

### 4. Connect a Salesforce account

Open http://localhost:3000 and click **Connect Salesforce**, then authorize in Nango's hosted Connect UI. When the `auth` webhook arrives, the app provisions the org automatically through Nango's proxy: a Remote Site Setting, the `NangoWebhookNotifier` Apex class, and one trigger per watched object.

The connection is held in memory (no persistence in this demo), so reconnect after a restart. To re-provision a connection manually, e.g. after changing the watched objects, run `npm run provision -- <connection-id>`.

## Try it

Edit any watched record in Salesforce. Within seconds, the chat UI at http://localhost:3000 shows the change and the agent's run: what changed, what it decided, and the Task it created with a link into Salesforce. You can also chat with the agent directly ("how many open opportunities do we have?").

The pipeline internals appear in the terminal:

```
📥 Sync webhook: records/SalesforceContact (+0 ~1 -0)
   Fetched 1 changed record(s) from Nango's records cache

🤖 Agent run: Contact 003ak000005v53LAAQ (Jack Rogers) was UPDATED
   → Tool call: get_salesforce_record({"object_type":"Contact","record_id":"003ak000005v53LAAQ"})
   → Tool call: query_salesforce({"soql":"SELECT Id, Name, StageName, CloseDate FROM Opportunity ..."})
   → Tool call: create_salesforce_task({"object_type":"Contact","subject":"Introductory outreach to Jack Rogers",...})
   Agent: I created a Normal-priority Task for the sales rep to make introductory outreach...
```

Check the record in Salesforce: the agent's Task is attached to its activity timeline.

## Project structure

| File | Role |
|---|---|
| [`nango-integrations/salesforce/objects.ts`](nango-integrations/salesforce/objects.ts) | Which objects and fields to watch |
| [`salesforce/NangoWebhookNotifier.cls`](salesforce/NangoWebhookNotifier.cls) | Shared Apex handler: change detection, batching, async callout |
| [`salesforce/NangoRecordTrigger.trigger.tpl`](salesforce/NangoRecordTrigger.trigger.tpl) | Template for the per-object triggers |
| [`nango-integrations/salesforce/syncs/records.ts`](nango-integrations/salesforce/syncs/records.ts) | Nango sync: real-time `onWebhook` plus hourly reconciliation |
| [`src/provision.ts`](src/provision.ts) | Installs the Apex into an org via the Tooling API through Nango's proxy |
| [`src/server.ts`](src/server.ts) | Webhook receiver: verify, ack, fetch changed records by cursor |
| [`src/agent.ts`](src/agent.ts) | Claude tool-use loop; reads Salesforce and writes Tasks via Nango |
| [`src/ui.ts`](src/ui.ts) | Demo chat UI with live Salesforce events |

## Learn more

- [How to trigger your AI agents on Salesforce webhooks](https://nango.dev/blog/how-to-trigger-ai-agents-on-salesforce-webhooks): the full tutorial behind this repo
- [Webhook functions](https://nango.dev/docs/guides/functions/webhook-functions)
- [Real-time syncs](https://nango.dev/docs/guides/functions/syncs/realtime-syncs)
- [Tool calling and MCP](https://nango.dev/docs/guides/functions/tool-calling)
