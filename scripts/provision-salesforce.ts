/**
 * Provisions the Salesforce side of the webhook pipeline — no Salesforce CLI
 * or Setup UI clicking required. Everything goes through Nango's proxy using
 * the OAuth access token of your existing connection:
 *
 *   1. Remote Site Setting for https://api.nango.dev (allows Apex callouts)
 *   2. NangoWebhookNotifier Apex class (makes the async HTTP callout)
 *   3. NangoContactTrigger Apex trigger (fires on Contact create/update)
 *
 * This mirrors what a multi-tenant product would run in a Nango
 * `post-connection-creation` event script for every new customer connection.
 *
 * Note: creating Apex via the Tooling API works in Developer Edition, sandbox,
 * and scratch orgs. Production orgs require a Metadata API deploy or package.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Nango } from '@nangohq/node';
import { env } from '../src/env.js';

const API_VERSION = 'v61.0';
const NANGO_HOST = 'https://api.nango.dev';

const nango = new Nango({ secretKey: env.nangoSecretKey });

const proxyDefaults = {
    providerConfigKey: env.integrationId,
    connectionId: env.connectionId
};

async function toolingQuery<T = any>(soql: string): Promise<T[]> {
    const res = await nango.get({
        ...proxyDefaults,
        endpoint: `/services/data/${API_VERSION}/tooling/query`,
        params: { q: soql }
    });
    return res.data.records ?? [];
}

async function toolingCreate(sobject: string, data: Record<string, unknown>): Promise<string> {
    const res = await nango.post({
        ...proxyDefaults,
        endpoint: `/services/data/${API_VERSION}/tooling/sobjects/${sobject}`,
        data
    });
    return res.data.id;
}

async function toolingDelete(sobject: string, id: string): Promise<void> {
    await nango.proxy({
        ...proxyDefaults,
        method: 'DELETE',
        endpoint: `/services/data/${API_VERSION}/tooling/sobjects/${sobject}/${id}`
    });
}

async function checkIntegrationProvider(): Promise<void> {
    const res = await fetch(`${NANGO_HOST}/integrations/${env.integrationId}`, {
        headers: { Authorization: `Bearer ${env.nangoSecretKey}` }
    });
    if (!res.ok) {
        console.warn(`⚠ Could not fetch integration "${env.integrationId}" (${res.status}); skipping provider check.`);
        return;
    }
    const body = (await res.json()) as { data?: { provider?: string } };
    const provider = body.data?.provider;
    if (provider && provider !== 'salesforce') {
        console.error(
            `✗ Integration "${env.integrationId}" uses provider "${provider}".\n` +
                `  Inbound webhook routing is only wired up for the base "salesforce" provider.\n` +
                `  Variants like "salesforce-sandbox" silently drop inbound webhooks (HTTP 204 no-op).\n` +
                `  Recreate the integration with the base "salesforce" provider before continuing.`
        );
        process.exit(1);
    }
    console.log(`✓ Integration "${env.integrationId}" uses the base "salesforce" provider`);
}

function loadApexSource(file: string): string {
    const source = readFileSync(path.resolve(import.meta.dirname, '..', 'salesforce', file), 'utf8');
    return source
        .replaceAll('{{NANGO_INBOUND_WEBHOOK_URL}}', env.inboundWebhookUrl)
        .replaceAll('{{NANGO_CONNECTION_ID}}', env.connectionId);
}

async function ensureRemoteSiteSetting(): Promise<void> {
    const existing = await toolingQuery(
        `SELECT Id, SiteName, EndpointUrl FROM RemoteProxy WHERE EndpointUrl = '${NANGO_HOST}'`
    );
    if (existing.length > 0) {
        console.log(`✓ Remote Site Setting already exists (${existing[0].SiteName})`);
        return;
    }
    try {
        await toolingCreate('RemoteProxy', {
            SiteName: 'Nango',
            EndpointUrl: NANGO_HOST,
            IsActive: true,
            DisableProtocolSecurity: false
        });
        console.log('✓ Created Remote Site Setting "Nango" → https://api.nango.dev');
    } catch (err: any) {
        console.error(
            '✗ Could not create the Remote Site Setting via the Tooling API.\n' +
                '  Create it manually: Setup → Security → Remote Site Settings → New:\n' +
                `  Name "Nango", URL "${NANGO_HOST}", Active.\n` +
                `  Error: ${JSON.stringify(err?.response?.data ?? err?.message)}`
        );
        process.exit(1);
    }
}

async function upsertApexClass(name: string, body: string): Promise<void> {
    const existing = await toolingQuery(`SELECT Id FROM ApexClass WHERE Name = '${name}'`);
    // The Tooling API can't update an ApexClass body directly (that requires a
    // MetadataContainer dance), so delete + recreate for idempotency.
    for (const record of existing) {
        await toolingDelete('ApexClass', record.Id);
        console.log(`  (replaced existing Apex class ${name})`);
    }
    await toolingCreate('ApexClass', { Name: name, Body: body });
    console.log(`✓ Deployed Apex class ${name}`);
}

async function upsertApexTrigger(name: string, sobject: string, body: string): Promise<void> {
    const existing = await toolingQuery(`SELECT Id FROM ApexTrigger WHERE Name = '${name}'`);
    for (const record of existing) {
        await toolingDelete('ApexTrigger', record.Id);
        console.log(`  (replaced existing Apex trigger ${name})`);
    }
    await toolingCreate('ApexTrigger', { Name: name, TableEnumOrId: sobject, Body: body });
    console.log(`✓ Deployed Apex trigger ${name} on ${sobject}`);
}

async function main() {
    if (!env.inboundWebhookUrl) {
        console.error(
            'Missing NANGO_INBOUND_WEBHOOK_URL in .env.\n' +
                'Copy it from the Nango dashboard: Integrations → your Salesforce integration → Webhook URL.\n' +
                'It looks like: https://api.nango.dev/webhook/<environment-uuid>/salesforce'
        );
        process.exit(1);
    }

    console.log(`Provisioning Salesforce org behind connection "${env.connectionId}"...\n`);

    await checkIntegrationProvider();
    await ensureRemoteSiteSetting();
    await upsertApexClass('NangoWebhookNotifier', loadApexSource('NangoWebhookNotifier.cls'));
    await upsertApexTrigger('NangoContactTrigger', 'Contact', loadApexSource('NangoContactTrigger.trigger'));

    console.log(
        '\nDone! Create or edit a Contact in Salesforce, then check the Logs tab\n' +
            'in the Nango dashboard — you should see the incoming webhook within a\n' +
            'few seconds (async Apex adds a small delay).'
    );
}

main().catch((err) => {
    console.error('Provisioning failed:', err?.response?.data ?? err);
    process.exit(1);
});
