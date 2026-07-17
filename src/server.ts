/**
 * Webhook receiver: Nango calls this endpoint whenever the Salesforce sync
 * saves changed records (triggered in real time by the Apex webhook, or by the
 * hourly reconciliation poll — the app handles both identically).
 *
 * Flow: verify signature → ack fast → fetch changed records by cursor →
 * run the AI agent on each change.
 */
import express from 'express';
import { env } from './env.js';
import { nango, fetchChangedRecords } from './nango.js';
import { runAgentOnContactChange } from './agent.js';

const app = express();
app.use(express.json());

const MODEL = 'SalesforceContact'; // must match the model name in the Nango sync

app.post('/webhooks/nango', (req, res) => {
    // Verify authenticity with the webhook signing key (NOT the API secret key).
    if (!nango.verifyIncomingWebhookRequest(req.body, req.headers as Record<string, string>)) {
        console.warn('Rejected webhook with invalid signature');
        res.status(401).send('invalid signature');
        return;
    }

    // Ack immediately: Nango times out after 20s and only retries twice.
    res.status(200).json({ ok: true });

    handleWebhook(req.body).catch((err) => console.error('Webhook handling failed:', err));
});

async function handleWebhook(payload: any): Promise<void> {
    switch (payload.type) {
        case 'sync': {
            if (!payload.success) {
                console.error(`Sync ${payload.syncName} failed:`, payload.error);
                return;
            }
            if (payload.model !== MODEL) return;

            const { added = 0, updated = 0, deleted = 0 } = payload.responseResults ?? {};
            console.log(`\n📥 Sync webhook: ${payload.syncName}/${payload.model} (+${added} ~${updated} -${deleted})`);
            if (added + updated + deleted === 0) return;

            const records = await fetchChangedRecords(payload.connectionId, payload.model, payload.modifiedAfter);
            console.log(`   Fetched ${records.length} changed record(s) from Nango's records cache`);

            for (const record of records) {
                await runAgentOnContactChange(record);
            }
            return;
        }

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

app.listen(env.port, () => {
    console.log(`Webhook receiver listening on http://localhost:${env.port}/webhooks/nango`);
    console.log('Expose it publicly (e.g. `ngrok http ' + env.port + '`) and set the public URL');
    console.log('in Nango: Environment Settings → Webhooks → Webhook URLs.');
});
