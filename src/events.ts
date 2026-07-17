import type { Response } from 'express';

/**
 * Tiny in-memory event feed for the demo UI: keeps the last 200 pipeline
 * events and streams new ones to browsers over Server-Sent Events.
 */
export interface PipelineEvent {
    at: string;
    kind:
        | 'sync-webhook'
        | 'forward-webhook'
        | 'records-fetched'
        | 'agent-start'
        | 'tool-call'
        | 'tool-result'
        | 'agent-done'
        | 'task-created'
        | 'info';
    [key: string]: unknown;
}

const history: PipelineEvent[] = [];
const subscribers = new Set<Response>();

export function emit(kind: PipelineEvent['kind'], data: Record<string, unknown> = {}): void {
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
