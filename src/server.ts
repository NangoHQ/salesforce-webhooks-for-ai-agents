/**
 * Webhook receiver: Nango calls this endpoint whenever the Salesforce sync
 * saves changed records (triggered in real time by the Apex webhooks, or by
 * the hourly reconciliation poll — the app handles both identically).
 *
 * Flow: verify signature → ack fast → fetch changed records by cursor →
 * run the AI agent on each change.
 */
import express from 'express';
import { env, requireEnv } from './env.js';
import { nango, fetchChangedRecords } from './nango.js';
import { getCursor, saveCursor } from './cursor-store.js';
import { runAgentOnRecordChange, chatWithAgent, isChatBusy } from './agent.js';
import { emit, subscribe } from './events.js';
import { DEMO_PAGE } from './ui.js';
import { configForModel } from '../nango-integrations/salesforce/objects.js';

// Fail fast at startup instead of failing on the first webhook/agent run.
requireEnv('NANGO_WEBHOOK_SIGNING_KEY');
requireEnv('ANTHROPIC_API_KEY');

const app = express();

// Keep the raw body: signature verification hashes the exact bytes Nango
// sent — verifying the re-serialized parsed object would not match.
app.use(
    express.json({
        verify: (req, _res, buf) => {
            (req as RequestWithRawBody).rawBody = buf.toString('utf8');
        }
    })
);

type RequestWithRawBody = express.Request & { rawBody?: string };

// A bulk edit (Data Loader, mass update) can land hundreds of changes in one
// webhook; don't turn each one into an agent conversation.
const MAX_AGENT_RUNS_PER_WEBHOOK = 10;

// Serialize webhook processing per (connection, model): two overlapping
// handlers would otherwise read the same cursor and process the same records
// twice (duplicate agent runs → duplicate Salesforce Tasks).
const queues = new Map<string, Promise<void>>();
function enqueue(key: string, run: () => Promise<void>): void {
    const prev = queues.get(key) ?? Promise.resolve();
    const next = prev
        .catch(() => {}) // a failed run must not block later runs
        .then(run);
    queues.set(key, next);
    next.finally(() => {
        if (queues.get(key) === next) queues.delete(key);
    }).catch(() => {});
    next.catch((err) => console.error('Webhook handling failed:', err));
}

// Demo UI: the agent chat interface at http://localhost:<port>/
app.get('/', (_req, res) => res.type('html').send(DEMO_PAGE));
app.get('/events', (_req, res) => subscribe(res));

// Chat with the same agent that reacts to Salesforce events. One shared
// in-memory conversation — this is a demo, not a session manager.
app.post('/api/chat', async (req, res) => {
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!message) {
        res.status(400).json({ error: 'message required' });
        return;
    }
    if (isChatBusy()) {
        res.status(409).json({ error: 'the assistant is still working on the previous message' });
        return;
    }
    try {
        await chatWithAgent(message);
        res.json({ ok: true });
    } catch (err: any) {
        res.status(500).json({ error: String(err?.message ?? err) });
    }
});

app.post('/webhooks/nango', (req, res) => {
    const rawBody = (req as RequestWithRawBody).rawBody ?? '';
    // Verify authenticity with the webhook signing key (NOT the API secret key).
    if (!nango.verifyIncomingWebhookRequest(rawBody, req.headers as Record<string, unknown>)) {
        console.warn('Rejected webhook with invalid signature');
        res.status(401).send('invalid signature');
        return;
    }

    // Ack immediately: Nango times out after 20s and only retries twice.
    res.status(200).json({ ok: true });

    const payload = req.body;
    const key = payload?.type === 'sync' ? `${payload.connectionId}:${payload.model}` : 'other';
    enqueue(key, () => handleWebhook(payload));
});

async function handleWebhook(payload: any): Promise<void> {
    switch (payload.type) {
        case 'sync':
            await handleSyncWebhook(payload);
            return;

        case 'forward':
            // Raw provider webhook forwarded by Nango — useful if you want the
            // original Salesforce payload instead of (or in addition to) the
            // records cache. We just log it here.
            console.log(`\n📨 Forwarded ${payload.from} webhook:`, JSON.stringify(payload.payload).slice(0, 300));
            return;

        case 'auth':
            if (payload.operation === 'creation' && payload.success) {
                console.log(`\n🔗 New connection created: ${payload.connectionId} (${payload.providerConfigKey})`);
            }
            return;

        default:
            // Nango adds new webhook types over time — ignore unknown ones.
            return;
    }
}

async function handleSyncWebhook(payload: any): Promise<void> {
    if (!payload.success) {
        console.error(`Sync ${payload.syncName} failed:`, payload.error);
        return;
    }
    const objectConfig = configForModel(payload.model);
    if (!objectConfig) return;

    const { added = 0, updated = 0, deleted = 0 } = payload.responseResults ?? {};
    console.log(`\n📥 Sync webhook: ${payload.syncName}/${payload.model} (+${added} ~${updated} -${deleted})`);
    if (added + updated + deleted > 0) {
        emit('change-detected', { count: added + updated + deleted, object: objectConfig.object });
    }

    const hasCursor = Boolean(getCursor(payload.connectionId, payload.model));

    // Empty syncs still matter once we have a cursor: Nango only retries
    // webhook delivery twice, so a webhook missed while this app was down
    // leaves records in the cache past our cursor. A cursor-based fetch is a
    // cheap no-op when nothing is pending and drains missed records otherwise.
    // Only skip in the no-cursor bootstrap case, where fetching without an
    // anchor could pull the entire historical dataset.
    if (added + updated + deleted === 0 && !hasCursor) return;

    const records = await fetchChangedRecords(payload.connectionId, payload.model, payload.modifiedAfter);
    console.log(`   Fetched ${records.length} changed record(s) from Nango's records cache`);

    // Bootstrap rule: don't wake the agent for the sync's INITIAL run — that's
    // the historical snapshot, not a change. Prime the cursor past it instead.
    // A later no-cursor INCREMENTAL run (e.g. the first Lead ever, arriving
    // via the hourly poll) is a real change: fetchChangedRecords already
    // bootstrapped from the run's modifiedAfter, so let the agent process it.
    // Webhook-triggered runs are always real-time changes.
    const isWebhookRun = payload.syncType === 'WEBHOOK';
    const isInitialRun = payload.syncType === 'INITIAL' || payload.checkpoints?.from == null;
    if (!hasCursor && !isWebhookRun && isInitialRun) {
        advanceCursorPastAll(payload, records);
        console.log(`   Initial sync for ${payload.model}: primed cursor past ${records.length} historical record(s), agent not invoked.`);
        emit('info', { text: `Initial sync: loaded ${records.length} existing ${objectConfig.object} record(s) from Salesforce — the assistant only reacts to changes from now on.` });
        return;
    }

    if (records.length > MAX_AGENT_RUNS_PER_WEBHOOK) {
        advanceCursorPastAll(payload, records);
        console.warn(
            `   ${records.length} changes in one webhook (bulk edit or backlog?) — ` +
                `skipping agent runs (cap: ${MAX_AGENT_RUNS_PER_WEBHOOK}). Raise MAX_AGENT_RUNS_PER_WEBHOOK if intended.`
        );
        emit('info', { text: `${records.length} ${objectConfig.object} records changed at once (bulk edit?) — skipping individual assistant runs.` });
        return;
    }

    for (const record of records) {
        try {
            await runAgentOnRecordChange(record);
        } catch (err) {
            // Advance past failed records anyway: a poison record must not
            // wedge the pipeline. The trade-off (this record's agent run is
            // lost) fits the demo; queue a retry in production instead.
            console.error(`   Agent run failed for record ${record.id}:`, err);
        }
        saveCursor(payload.connectionId, payload.model, record._nango_metadata.cursor);
    }
}

function advanceCursorPastAll(payload: any, records: { _nango_metadata: { cursor: string } }[]): void {
    const last = records[records.length - 1];
    if (last) {
        saveCursor(payload.connectionId, payload.model, last._nango_metadata.cursor);
    }
}

app.listen(env.port, () => {
    console.log(`Webhook receiver listening on http://localhost:${env.port}/webhooks/nango`);
    console.log(`Demo app: http://localhost:${env.port}/`);
    console.log('Expose the port publicly (e.g. `ngrok http ' + env.port + '`) and set the public URL');
    console.log('in Nango: Environment Settings → Webhooks → Webhook URLs.');
});
