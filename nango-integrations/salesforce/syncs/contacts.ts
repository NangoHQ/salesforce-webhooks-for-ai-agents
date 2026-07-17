import { createSync } from 'nango';
import * as z from 'zod';

const ContactSchema = z.object({
    id: z.string(),
    first_name: z.string().nullable(),
    last_name: z.string().nullable(),
    email: z.string().nullable(),
    title: z.string().nullable(),
    phone: z.string().nullable(),
    last_modified_date: z.string()
});
type SalesforceContact = z.infer<typeof ContactSchema>;

/**
 * Salesforce contacts, two ways at once:
 *
 * 1. Real time: the Apex trigger in the connected org POSTs changes to Nango's
 *    webhook URL; `onWebhook` saves them to the records cache within seconds.
 * 2. Reconciliation: Apex `@future` callouts are at-most-once (no retries), so
 *    an hourly incremental poll (`exec`) catches anything the webhook missed.
 *
 * Every batchSave that changes records triggers a `type: "sync"` webhook from
 * Nango to your app.
 */
const sync = createSync({
    description: 'Salesforce contacts in real time: Apex webhook events + hourly polling reconciliation',
    version: '1.0.0',
    frequency: 'every hour',
    autoStart: true,

    // Must match the eventType values sent by the Apex trigger.
    webhookSubscriptions: ['contact.created', 'contact.updated'],

    checkpoint: z.object({
        lastModifiedISO: z.string()
    }),

    metadata: z.void(),
    models: {
        SalesforceContact: ContactSchema
    },

    // Hourly reconciliation: incremental SOQL poll from the last checkpoint.
    exec: async (nango) => {
        // Webhooks may have already written fresher versions of these records —
        // don't overwrite them with stale polled data.
        await nango.setMergingStrategy({ strategy: 'ignore_if_modified_after' }, 'SalesforceContact');

        // Runtime-check the checkpoint shape: if this sync replaced a
        // previously deployed version (e.g. a template sync), getCheckpoint()
        // returns the OLD sync's checkpoint object, whose keys won't match our
        // schema — treating it as absent falls back to a full (re)sync.
        const rawCheckpoint = await nango.getCheckpoint();
        const checkpoint = typeof rawCheckpoint?.lastModifiedISO === 'string' ? rawCheckpoint : null;

        let query = 'SELECT Id, FirstName, LastName, Email, Title, Phone, LastModifiedDate FROM Contact';
        if (checkpoint) {
            // Inclusive (>=) on purpose: LastModifiedDate has second
            // granularity, so several records can share the checkpoint's
            // timestamp; a strict > would skip the ones a crashed run didn't
            // reach. Re-fetched unchanged records hash identically in the
            // records cache, so they produce no spurious change events.
            query += ` WHERE LastModifiedDate >= ${checkpoint.lastModifiedISO}`;
        }
        query += ' ORDER BY LastModifiedDate ASC';

        for await (const page of nango.paginate<Record<string, any>>({
            endpoint: '/services/data/v61.0/query',
            params: { q: query },
            paginate: {
                type: 'link',
                response_path: 'records',
                link_path_in_response_body: 'nextRecordsUrl'
            }
        })) {
            const contacts = page.map(mapContact);
            if (contacts.length === 0) {
                continue;
            }

            await nango.batchSave(contacts, 'SalesforceContact');

            const last = contacts[contacts.length - 1];
            if (last) {
                await nango.saveCheckpoint({ lastModifiedISO: last.last_modified_date });
            }
        }
    },

    // Real-time path: called when the Apex trigger POSTs to Nango's webhook URL
    // with an eventType matching webhookSubscriptions above.
    onWebhook: async (nango, payload) => {
        // The Apex trigger sends: { nango: { connectionId, eventType }, data: [...records] }
        // Nango's runner passes the raw parsed POST body as `payload` — it is
        // not wrapped under `payload.body` (one docs page suggests otherwise;
        // the runner source and live behavior agree on the raw shape).
        const body = payload as { nango?: { eventType?: string }; data?: Record<string, any>[] | Record<string, any> };

        const raw = body.data;
        const incoming: Record<string, any>[] = Array.isArray(raw) ? raw : raw ? [raw] : [];

        if (incoming.length === 0) {
            await nango.log('Webhook received but no records in payload', { level: 'warn' });
            return;
        }

        const contacts = incoming.map(mapContact);

        // Salesforce doesn't guarantee @future execution order: two rapid edits
        // can deliver the older payload second. Drop anything strictly older
        // than what's already cached (strictly: rapid edits can share a
        // same-second timestamp, and <= would drop the genuinely newer one).
        const cached = await nango.getRecordsByIds<string, SalesforceContact>(
            contacts.map((c) => c.id),
            'SalesforceContact'
        );
        const fresh = contacts.filter((c) => {
            const existing = cached.get(c.id);
            return !existing || new Date(c.last_modified_date) >= new Date(existing.last_modified_date);
        });

        if (fresh.length === 0) {
            await nango.log('Webhook payload was older than cached records; skipped');
            return;
        }

        await nango.batchSave(fresh, 'SalesforceContact');
        await nango.log(`Saved ${fresh.length} contact(s) from webhook (${body.nango?.eventType ?? 'unknown event'})`);
    }
});

function mapContact(record: Record<string, any>): SalesforceContact {
    return {
        id: record['Id'],
        first_name: record['FirstName'] ?? null,
        last_name: record['LastName'] ?? null,
        email: record['Email'] ?? null,
        title: record['Title'] ?? null,
        phone: record['Phone'] ?? null,
        // Salesforce returns "+0000" offsets, which are not valid SOQL datetime
        // literals — normalize to "Z" so checkpoints can be used in queries.
        // (The Apex path already serializes as "Z"; both paths must produce
        // byte-identical records so the cache's hash comparison sees polled
        // re-fetches of webhook-delivered records as unchanged.)
        last_modified_date: new Date(record['LastModifiedDate']).toISOString()
    };
}

export type NangoSyncLocal = Parameters<(typeof sync)['exec']>[0];
export default sync;
