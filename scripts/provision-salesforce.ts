/**
 * CLI wrapper around src/provision.ts, for manually (re-)provisioning the
 * Salesforce org behind a specific connection:
 *
 *   npm run provision -- <connection-id>
 *
 * You normally don't need this: provisioning runs automatically when a user
 * connects their org through the app — see the `auth` webhook handler in
 * src/server.ts. Find connection IDs in the Nango dashboard's Connections tab.
 */
import { provisionSalesforce } from '../src/provision.js';

const connectionId = process.argv[2];
if (!connectionId) {
    console.error('Usage: npm run provision -- <connection-id>');
    console.error('(Connection IDs are in the Nango dashboard, Connections tab.)');
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
