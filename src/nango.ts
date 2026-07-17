import { Nango } from '@nangohq/node';
import { env } from './env.js';
import { getCursor, saveCursor } from './cursor-store.js';

export const nango = new Nango({
    secretKey: env.nangoSecretKey,
    // Used by verifyIncomingWebhookRequest; falls back to the secret key if unset.
    ...(env.nangoWebhookSigningKey ? { webhookSigningKey: env.nangoWebhookSigningKey } : {})
});

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
 * (connection, model) pair, paginating until next_cursor is null, and
 * persists the new cursor for the next webhook.
 *
 * On the very first webhook there is no stored cursor yet — without one,
 * listRecords would return the entire historical dataset. We bootstrap with
 * the webhook's `modifiedAfter` timestamp so the agent only sees the records
 * from this sync run onward.
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

    if (records.length > 0) {
        saveCursor(connectionId, model, records[records.length - 1]._nango_metadata.cursor);
    }
    return records;
}
