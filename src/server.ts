/**
 * Webhook receiver: Nango calls this endpoint whenever the Salesforce sync
 * saves changed records (triggered in real time by the Apex webhook, or by the
 * hourly reconciliation poll — the app handles both identically).
 *
 * Flow: verify signature → ack fast → fetch changed records by cursor →
 * run the AI agent on each change.
 */
import express from 'express';
import { env, requireEnv } from './env.js';
import { nango, fetchChangedRecords } from './nango.js';
import { getCursor, saveCursor } from './cursor-store.js';
import { runAgentOnContactChange } from './agent.js';
import { emit, subscribe } from './events.js';
import { DEMO_PAGE } from './ui.js';

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

const MODEL = 'SalesforceContact'; // must match the model name in the Nango sync

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

// Demo UI: a mini "CRM copilot" app at http://localhost:<port>/
app.get('/', (_req, res) => res.type('html').send(DEMO_PAGE));
app.get('/events', (_req, res) => subscribe(res));

// Contacts straight from Nango's records cache — the same store the sync
// keeps fresh in real time. This is what your product would read instead of
// hitting the Salesforce API on every page load.
app.get('/api/contacts', async (_req, res) => {
    try {
        const { records } = await nango.listRecords({
            providerConfigKey: env.integrationId,
            connectionId: env.connectionId,
            model: MODEL,
            limit: 100
        });
        const contacts = (records as any[])
            .filter((r) => r._nango_metadata.last_action !== 'DELETED')
            .map((r) => ({
                id: r.id,
                name: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.id,
                title: r.title,
                email: r.email,
                phone: r.phone,
                updatedAt: r._nango_metadata.last_modified_at
            }))
            .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
        res.json({ contacts });
    } catch (err: any) {
        res.status(500).json({ error: String(err?.response?.data ?? err) });
    }
});

// Demo helper: edit a random cached contact's title so the whole pipeline
// fires without opening Salesforce.
app.post('/demo/simulate', async (_req, res) => {
    try {
        const { records } = await nango.listRecords({
            providerConfigKey: env.integrationId,
            connectionId: env.connectionId,
            model: MODEL,
            limit: 50
        });
        const alive = (records as any[]).filter((r) => r._nango_metadata.last_action !== 'DELETED');
        const target = alive[Math.floor(Math.random() * alive.length)];
        if (!target) {
            res.status(404).json({ error: 'no cached contacts yet' });
            return;
        }
        const TITLES = [
            'VP of Operations', 'Head of Procurement', 'Director of IT',
            'Chief Revenue Officer', 'Senior Solutions Architect', 'Head of Partnerships'
        ];
        const title = TITLES[Math.floor(Math.random() * TITLES.length)];
        await nango.proxy({
            providerConfigKey: env.integrationId,
            connectionId: env.connectionId,
            method: 'PATCH',
            endpoint: `/services/data/v61.0/sobjects/Contact/${target.id}`,
            data: { Title: title }
        });
        const name = [target.first_name, target.last_name].filter(Boolean).join(' ');
        emit('info', { text: `${name}'s title was changed to "${title}" in Salesforce — waiting for the org to notify us…` });
        res.json({ ok: true, contact: target.id });
    } catch (err: any) {
        res.status(500).json({ error: String(err?.response?.data ?? err) });
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
    if (payload.model !== MODEL) return;

    const { added = 0, updated = 0, deleted = 0 } = payload.responseResults ?? {};
    console.log(`\n📥 Sync webhook: ${payload.syncName}/${payload.model} (+${added} ~${updated} -${deleted})`);
    if (added + updated + deleted > 0) {
        emit('change-detected', { count: added + updated + deleted });
    }

    const hasCursor = Boolean(getCursor(payload.connectionId, payload.model));

    // Empty syncs still matter once we have a cursor: Nango only retries
    // webhook delivery twice, so a webhook missed while this app was down
    // leaves records in the cache past our cursor. A cursor-based fetch is a
    // cheap no-op when nothing is pending and drains missed records otherwise.
    // Only skip in the no-cursor bootstrap case, where fetching without an
    // anchor could pull the entire historical dataset.
    if (added + updated + deleted === 0 && !hasCursor) return;

    // The sync's first-ever run (autoStart) fetches ALL historical contacts.
    // Prime the cursor past them, but don't wake the agent for records that
    // predate this pipeline. Webhook-triggered runs never count as full syncs,
    // even though they may run before the first poll saves a checkpoint.
    const isWebhookRun = payload.syncType === 'WEBHOOK';
    const isFullSync = !isWebhookRun && (payload.checkpoints?.from == null || payload.syncType === 'INITIAL');

    const records = await fetchChangedRecords(payload.connectionId, payload.model, payload.modifiedAfter);
    console.log(`   Fetched ${records.length} changed record(s) from Nango's records cache`);
    if (records.length > 0) {
        emit('contacts-updated', {});
    }

    if (isFullSync && !hasCursor) {
        advanceCursorPastAll(payload, records);
        console.log(`   Initial/full sync: primed cursor past ${records.length} historical contact(s), agent not invoked.`);
        return;
    }

    if (records.length > MAX_AGENT_RUNS_PER_WEBHOOK) {
        advanceCursorPastAll(payload, records);
        console.warn(
            `   ${records.length} changes in one webhook (bulk edit or backlog?) — ` +
                `skipping agent runs (cap: ${MAX_AGENT_RUNS_PER_WEBHOOK}). Raise MAX_AGENT_RUNS_PER_WEBHOOK if intended.`
        );
        return;
    }

    for (const record of records) {
        try {
            await runAgentOnContactChange(record);
        } catch (err) {
            // Advance past failed records anyway: a poison record must not
            // wedge the pipeline. The trade-off (this record's agent run is
            // lost) fits the demo; queue a retry in production instead.
            console.error(`   Agent run failed for contact ${record.id}:`, err);
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
    console.log('Expose it publicly (e.g. `ngrok http ' + env.port + '`) and set the public URL');
    console.log('in Nango: Environment Settings → Webhooks → Webhook URLs.');
});
