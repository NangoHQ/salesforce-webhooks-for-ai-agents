import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/**
 * Persists the Salesforce connection ID captured from Nango's `auth` webhook —
 * the "store the connection ID on your side" step every real integration has.
 * A JSON file keeps the demo dependency-free; in production this lives on the
 * user/org row in your database.
 *
 * Precedence: a connection created through the in-app auth flow wins over the
 * optional NANGO_CONNECTION_ID shortcut in .env.
 */
const STORE_PATH = path.resolve(import.meta.dirname, '..', '.connection.json');

export function getConnectionId(): string | null {
    if (existsSync(STORE_PATH)) {
        try {
            const stored = JSON.parse(readFileSync(STORE_PATH, 'utf8'));
            if (typeof stored?.connectionId === 'string' && stored.connectionId) {
                return stored.connectionId;
            }
        } catch {
            console.warn('Connection store was corrupt; ignoring it.');
        }
    }
    return process.env['NANGO_CONNECTION_ID'] || null;
}

export function saveConnectionId(connectionId: string): void {
    writeFileSync(`${STORE_PATH}.tmp`, JSON.stringify({ connectionId, savedAt: new Date().toISOString() }, null, 2));
    renameSync(`${STORE_PATH}.tmp`, STORE_PATH);
}
