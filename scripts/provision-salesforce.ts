/**
 * CLI wrapper around src/provision.ts — provisions the Salesforce org behind
 * the current connection (from the in-app auth flow, or NANGO_CONNECTION_ID
 * in .env as a fallback).
 *
 * The same provisioning runs automatically when a user connects their org
 * through the app's Connect flow — see the `auth` webhook handler in
 * src/server.ts.
 */
import { getConnectionId } from '../src/connection-store.js';
import { provisionSalesforce } from '../src/provision.js';

const connectionId = getConnectionId();
if (!connectionId) {
    console.error(
        'No Salesforce connection yet. Either connect through the app (npm run dev → http://localhost:3000)\n' +
            'or set NANGO_CONNECTION_ID in .env to an existing connection.'
    );
    process.exit(1);
}

console.log(`Provisioning Salesforce org behind connection "${connectionId}"...\n`);

provisionSalesforce(connectionId)
    .then(() => {
        console.log(
            '\nDone! Create or edit a record in Salesforce, then check the Logs tab\n' +
                'in the Nango dashboard — you should see the incoming webhook within a\n' +
                'few seconds (async Apex adds a small delay).'
        );
    })
    .catch((err) => {
        console.error('Provisioning failed:', err?.response?.data ?? err?.message ?? err);
        process.exit(1);
    });
