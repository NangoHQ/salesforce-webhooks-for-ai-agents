/**
 * Holds the Salesforce connection ID captured from Nango's `auth` webhook —
 * the "store the connection ID on your side" step every real integration has.
 *
 * In-memory only, on purpose: this demo has no user accounts or database, so
 * every server start begins unconnected and the user connects through the UI.
 * In production this lives on the user/org row in your database — Nango
 * deliberately doesn't model which of your users owns a connection.
 */
let currentConnectionId: string | null = null;

export function getConnectionId(): string | null {
    return currentConnectionId;
}

export function setConnectionId(connectionId: string): void {
    currentConnectionId = connectionId;
}
