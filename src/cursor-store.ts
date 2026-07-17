import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Persists the last-processed Nango records cursor per (connectionId, model).
 * A JSON file keeps the demo dependency-free; use your database in production.
 */
const STORE_PATH = path.resolve(import.meta.dirname, '..', '.cursors.json');

type CursorMap = Record<string, string>;

function load(): CursorMap {
    if (!existsSync(STORE_PATH)) return {};
    try {
        return JSON.parse(readFileSync(STORE_PATH, 'utf8'));
    } catch {
        // A crash mid-write can leave truncated JSON; recover by resetting.
        // The next fetch bootstraps from the webhook's modifiedAfter timestamp.
        console.warn('Cursor store was corrupt; resetting it.');
        return {};
    }
}

export function getCursor(connectionId: string, model: string): string | undefined {
    return load()[`${connectionId}:${model}`];
}

export function saveCursor(connectionId: string, model: string, cursor: string): void {
    const store = load();
    store[`${connectionId}:${model}`] = cursor;
    // Write-then-rename so a crash can't leave a half-written file.
    writeFileSync(`${STORE_PATH}.tmp`, JSON.stringify(store, null, 2));
    renameSync(`${STORE_PATH}.tmp`, STORE_PATH);
}
