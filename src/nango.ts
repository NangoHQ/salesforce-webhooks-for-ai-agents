import { Nango } from '@nangohq/node';
import { env } from './env.js';
import { getCursor } from './cursor-store.js';

export const nango = new Nango({
    apiKey: env.nangoSecretKey,
    // Signs webhooks Nango sends to this app. Distinct from the API key —
    // verification silently fails if you mix them up.
    ...(env.nangoWebhookSigningKey ? { webhookSigningKey: env.nangoWebhookSigningKey } : {})
});

let cachedInstanceUrl: string | null | undefined;

/** Salesforce instance URL of the connected org, for building record links. */
export async function getInstanceUrl(): Promise<string | null> {
    if (cachedInstanceUrl !== undefined) return cachedInstanceUrl;
    try {
        const conn = await nango.getConnection(env.integrationId, env.connectionId);
        cachedInstanceUrl = (conn as any)?.connection_config?.instance_url ?? null;
    } catch {
        cachedInstanceUrl = null;
    }
    return cachedInstanceUrl ?? null;
}

export interface NangoRecord {
    id: string;
    [key: string]: unknown;
    _nango_metadata: {
        first_seen_at: string;
        last_modified_at: string;
        last_action: 'ADDED' | 'UPDATED' | 'DELETED';
        deleted_at: string | null;
        cursor: string;
    };
}

/**
 * Fetches all records changed since the last processed cursor for this
 * (connection, model) pair, paginating until next_cursor is null.
 *
 * The caller is responsible for persisting each record's cursor
 * (`_nango_metadata.cursor`) as it finishes processing it — saving the cursor
 * here, before processing, would silently skip records if processing fails.
 *
 * On the very first webhook there is no stored cursor yet — without one,
 * listRecords would return the entire historical dataset. We bootstrap with
 * the webhook's `modifiedAfter` timestamp so only records from this sync run
 * onward are returned.
 */
export async function fetchChangedRecords(
    connectionId: string,
    model: string,
    modifiedAfter?: string
): Promise<NangoRecord[]> {
    const records: NangoRecord[] = [];
    let cursor = getCursor(connectionId, model);

    while (true) {
        const res = await nango.listRecords({
            providerConfigKey: env.integrationId,
            connectionId,
            model,
            ...(cursor ? { cursor } : modifiedAfter ? { modifiedAfter } : {})
        });

        records.push(...(res.records as unknown as NangoRecord[]));

        if (!res.next_cursor) {
            break;
        }
        cursor = res.next_cursor;
    }

    return records;
}
