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
 * Every batchSave triggers a `type: "sync"` webhook from Nango to your app.
 */
const sync = createSync({
    description: 'Salesforce contacts in real time: Apex webhook events + hourly polling reconciliation',
    version: '1.0.0',
    endpoints: [{ method: 'GET', path: '/salesforce/contacts', group: 'Contacts' }],
    frequency: 'every hour',
    autoStart: true,
    syncType: 'incremental',

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

        const checkpoint = await nango.getCheckpoint();

        let query = 'SELECT Id, FirstName, LastName, Email, Title, Phone, LastModifiedDate FROM Contact';
        if (checkpoint) {
            // Normalized to ISO-8601 UTC ("Z"), which is a valid SOQL datetime literal.
            query += ` WHERE LastModifiedDate > ${checkpoint.lastModifiedISO}`;
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
        // Depending on SDK version the body may arrive wrapped under `payload.body`.
        const body: any = payload && typeof payload === 'object' && 'body' in (payload as any) ? (payload as any).body : payload;

        const raw = body?.['data'];
        const records: Record<string, any>[] = Array.isArray(raw) ? raw : raw ? [raw] : [];

        if (records.length === 0) {
            await nango.log('Webhook received but no records in payload', { level: 'warn' });
            return;
        }

        const contacts = records.map(mapContact);
        await nango.batchSave(contacts, 'SalesforceContact');
        await nango.log(`Saved ${contacts.length} contact(s) from webhook (${body?.['nango']?.['eventType']})`);
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
        last_modified_date: new Date(record['LastModifiedDate']).toISOString()
    };
}

export type NangoSyncLocal = Parameters<(typeof sync)['exec']>[0];
export default sync;
