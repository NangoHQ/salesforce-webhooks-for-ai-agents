import { createSync } from 'nango';
import * as z from 'zod';
import { SALESFORCE_OBJECTS, configForObject, type SalesforceObjectConfig } from '../objects.js';

/**
 * One shape for every watched object: the raw tracked fields live under
 * `fields`, plus a computed display name so consumers don't need per-object
 * knowledge to render a record.
 */
const RecordSchema = z.object({
    id: z.string(),
    object: z.string(),
    display_name: z.string(),
    fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
    last_modified_date: z.string()
});
type SalesforceRecord = z.infer<typeof RecordSchema>;

/**
 * Salesforce records for every object in ../objects.ts, two ways at once:
 *
 * 1. Real time: the per-object Apex triggers POST changes to Nango's webhook
 *    URL; `onWebhook` saves them to the records cache within seconds.
 * 2. Reconciliation: Apex `@future` callouts are at-most-once (no retries), so
 *    an hourly incremental poll (`exec`) catches anything the webhook missed.
 */
const sync = createSync({
    description: 'Salesforce records (contacts, leads, accounts, opportunities): real-time Apex webhook events + hourly polling reconciliation',
    version: '1.0.0',
    frequency: 'every hour',
    autoStart: true,

    // The Apex handler emits '<object>.created' / '<object>.updated' — the
    // wildcard routes them all here.
    webhookSubscriptions: ['*'],

    // One timestamp checkpoint per object, keyed by sObject API name.
    // ('' = no checkpoint yet; the SDK requires a flat object of primitives.)
    checkpoint: z.object(
        Object.fromEntries(SALESFORCE_OBJECTS.map((o) => [o.object, z.string()])) as Record<string, z.ZodString>
    ),

    metadata: z.void(),
    models: {
        SalesforceContact: RecordSchema,
        SalesforceLead: RecordSchema,
        SalesforceAccount: RecordSchema,
        SalesforceOpportunity: RecordSchema
    },

    // Hourly reconciliation: incremental SOQL poll per object from its checkpoint.
    exec: async (nango) => {
        // Defensive checkpoint read: if this sync replaced a previously
        // deployed version, the stored checkpoint has the OLD sync's shape —
        // treat anything unusable as absent (full fetch for that object).
        let stored: Record<string, string> | null = null;
        try {
            stored = await nango.getCheckpoint();
        } catch {
            stored = null;
        }
        const checkpoint: Record<string, string> = Object.fromEntries(
            SALESFORCE_OBJECTS.map((o) => [o.object, typeof stored?.[o.object] === 'string' ? stored[o.object]! : ''])
        );

        for (const cfg of SALESFORCE_OBJECTS) {
            // Webhooks may have already written fresher versions of these
            // records — don't overwrite them with stale polled data.
            await nango.setMergingStrategy({ strategy: 'ignore_if_modified_after' }, cfg.model);

            const since = checkpoint[cfg.object] || null;
            let query = `SELECT Id, ${cfg.fields.join(', ')}, LastModifiedDate FROM ${cfg.object}`;
            if (since) {
                // Inclusive (>=): LastModifiedDate has second granularity, so a
                // strict > would skip boundary records a crashed run missed.
                // Re-fetched unchanged records hash identically — no spurious events.
                query += ` WHERE LastModifiedDate >= ${since}`;
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
                const records = page.map((raw) => mapRecord(cfg, raw));
                if (records.length === 0) continue;

                await nango.batchSave(records, cfg.model);

                const last = records[records.length - 1];
                if (last) {
                    checkpoint[cfg.object] = last.last_modified_date;
                    await nango.saveCheckpoint(checkpoint);
                }
            }
        }
    },

    // Real-time path: the Apex trigger POSTs { nango: {...}, object, data: [...] }.
    // Nango's runner passes the raw parsed POST body as `payload` — it is not
    // wrapped under `payload.body`.
    onWebhook: async (nango, payload) => {
        const body = payload as {
            nango?: { eventType?: string };
            object?: string;
            data?: Record<string, any>[] | Record<string, any>;
        };

        const objectName = body.object ?? body.nango?.eventType?.split('.')[0] ?? '';
        const cfg = configForObject(objectName);
        if (!cfg) {
            await nango.log(`Webhook for unconfigured object "${objectName}" ignored`, { level: 'warn' });
            return;
        }

        const raw = body.data;
        const incoming: Record<string, any>[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
        if (incoming.length === 0) {
            await nango.log('Webhook received but no records in payload', { level: 'warn' });
            return;
        }

        const records = incoming.map((r) => mapRecord(cfg, r));

        // Salesforce doesn't guarantee @future execution order: two rapid edits
        // can deliver the older payload second. Drop anything strictly older
        // than what's already cached.
        const cached = await nango.getRecordsByIds<string, SalesforceRecord>(
            records.map((r) => r.id),
            cfg.model
        );
        const fresh = records.filter((r) => {
            const existing = cached.get(r.id);
            return !existing || new Date(r.last_modified_date) >= new Date(existing.last_modified_date);
        });

        if (fresh.length === 0) {
            await nango.log('Webhook payload was older than cached records; skipped');
            return;
        }

        await nango.batchSave(fresh, cfg.model);
        await nango.log(`Saved ${fresh.length} ${cfg.object} record(s) from webhook (${body.nango?.eventType ?? 'unknown event'})`);
    }
});

function mapRecord(cfg: SalesforceObjectConfig, raw: Record<string, any>): SalesforceRecord {
    const fields: Record<string, string | number | boolean | null> = {};
    for (const f of cfg.fields) {
        fields[f] = raw[f] ?? null;
    }
    return {
        id: raw['Id'],
        object: cfg.object,
        display_name: cfg.nameFields.map((f) => raw[f]).filter(Boolean).join(' ') || raw['Id'],
        fields,
        // Normalize Salesforce's "+0000" offsets to "Z": valid in SOQL literals,
        // and byte-identical between the Apex and SOQL paths so re-fetches of
        // webhook-delivered records hash as unchanged.
        last_modified_date: new Date(raw['LastModifiedDate']).toISOString()
    };
}

export type NangoSyncLocal = Parameters<(typeof sync)['exec']>[0];
export default sync;
