import type { Response } from 'express';

/**
 * Tiny in-memory event feed for the demo UI: keeps recent events and streams
 * new ones to browsers over Server-Sent Events.
 *
 * Event kinds the UI understands:
 *  - 'change-detected'  { count }                      a Salesforce change reached the app
 *  - 'agent-start'      { contact, contactId, action } the assistant picked up a change
 *  - 'agent-activity'   { contact, contactId, action, summary, task? }  finished run
 *  - 'contacts-updated' { }                            the contacts list should refresh
 *  - 'info'             { text }                       anything else worth a line
 */
export interface PipelineEvent {
    at: string;
    kind: string;
    [key: string]: unknown;
}

const history: PipelineEvent[] = [];
const subscribers = new Set<Response>();

export function emit(kind: string, data: Record<string, unknown> = {}): void {
    const event: PipelineEvent = { at: new Date().toISOString(), kind, ...data };
    history.push(event);
    if (history.length > 200) history.shift();
    for (const res of subscribers) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
}

export function subscribe(res: Response): void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    for (const event of history) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    subscribers.add(res);
    res.on('close', () => subscribers.delete(res));
}
