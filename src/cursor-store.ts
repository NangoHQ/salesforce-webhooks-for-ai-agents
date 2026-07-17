import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Persists the last-processed Nango records cursor per (connectionId, model).
 * A JSON file keeps the demo dependency-free; use your database in production.
 */
const STORE_PATH = path.resolve(import.meta.dirname, '..', '.cursors.json');

type CursorMap = Record<string, string>;

function load(): CursorMap {
    if (!existsSync(STORE_PATH)) return {};
    return JSON.parse(readFileSync(STORE_PATH, 'utf8'));
}

export function getCursor(connectionId: string, model: string): string | undefined {
    return load()[`${connectionId}:${model}`];
}

export function saveCursor(connectionId: string, model: string, cursor: string): void {
    const store = load();
    store[`${connectionId}:${model}`] = cursor;
    writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}
