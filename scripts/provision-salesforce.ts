/**
 * Provisions the Salesforce side of the webhook pipeline — no Salesforce CLI
 * or Setup UI clicking required. Everything goes through Nango's proxy using
 * the OAuth access token of your existing connection:
 *
 *   1. Remote Site Setting for https://api.nango.dev (allows Apex callouts)
 *   2. NangoWebhookNotifier Apex class (shared handler + async HTTP callout)
 *   3. One thin Apex trigger per watched object in SALESFORCE_OBJECTS
 *      (Nango<Object>Trigger, rendered from NangoRecordTrigger.trigger.tpl)
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
import { SALESFORCE_OBJECTS } from '../nango-integrations/salesforce/objects.js';

const API_VERSION = 'v61.0';
const NANGO_HOST = 'https://api.nango.dev';

const nango = new Nango({ apiKey: env.nangoSecretKey });

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

// Apex identifiers can't contain consecutive underscores, so custom-object
// API names like Invoice__c are sanitized when composing the trigger name.
function triggerName(object: string): string {
    return 'Nango' + object.replace(/__(c|e|mdt)$/i, '').replace(/_/g, '') + 'Trigger';
}

function renderTrigger(object: string, fields: string[]): string {
    return loadApexSource('NangoRecordTrigger.trigger.tpl')
        .replaceAll('{{TRIGGER_NAME}}', triggerName(object))
        .replaceAll('{{OBJECT}}', object)
        .replaceAll('{{FIELDS}}', fields.map((f) => `'${f}'`).join(', '));
}

// Fail fast on typos or stale field names — a bad field would otherwise only
// surface as a runtime SObjectException in the customer's org.
async function validateFields(object: string, fields: string[]): Promise<void> {
    const res = await nango.get({
        ...proxyDefaults,
        endpoint: `/services/data/${API_VERSION}/sobjects/${object}/describe`
    });
    const available = new Set((res.data.fields ?? []).map((f: any) => f.name));
    const missing = fields.filter((f) => !available.has(f));
    if (missing.length > 0) {
        console.error(`✗ ${object} has no field(s): ${missing.join(', ')}. Fix nango-integrations/salesforce/objects.ts.`);
        process.exit(1);
    }
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
        // The Tooling API sobject for Remote Site Settings is RemoteProxy.
        // Creation requires the FullName + Metadata shape ("You must provide a
        // valid Metadata field for RemoteProxy"); flat fields are query-only.
        await toolingCreate('RemoteProxy', {
            FullName: 'Nango',
            Metadata: {
                url: NANGO_HOST,
                isActive: true,
                disableProtocolSecurity: false,
                description: 'Allow Apex callouts to Nango webhooks'
            }
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

async function deleteIfExists(sobject: 'ApexClass' | 'ApexTrigger', name: string): Promise<void> {
    const existing = await toolingQuery<{ Id: string }>(`SELECT Id FROM ${sobject} WHERE Name = '${name}'`);
    for (const record of existing) {
        await toolingDelete(sobject, record.Id);
        console.log(`  (removed existing ${sobject} ${name})`);
    }
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

    for (const cfg of SALESFORCE_OBJECTS) {
        await validateFields(cfg.object, cfg.fields);
    }
    console.log('✓ All tracked fields exist on their objects');

    // Salesforce refuses to delete an Apex class while deployed code still
    // references it, so remove in reverse dependency order (triggers → class),
    // then create in forward order (class → triggers). Cleanup is
    // discovery-driven (not config-driven) so triggers for objects that were
    // REMOVED from the config don't strand the class and wedge re-runs.
    // The brief trigger-less window is fine for a demo: the hourly
    // reconciliation sync catches any events that occur during it.
    const pipelineTriggers = await toolingQuery<{ Id: string; Name: string }>(
        "SELECT Id, Name FROM ApexTrigger WHERE Name LIKE 'Nango%Trigger'"
    );
    for (const trigger of pipelineTriggers.filter((t) => /^Nango\w+Trigger$/.test(t.Name))) {
        await toolingDelete('ApexTrigger', trigger.Id);
        console.log(`  (removed existing ApexTrigger ${trigger.Name})`);
    }
    await deleteIfExists('ApexClass', 'NangoWebhookNotifier');

    await toolingCreate('ApexClass', { Name: 'NangoWebhookNotifier', Body: loadApexSource('NangoWebhookNotifier.cls') });
    console.log('✓ Deployed Apex class NangoWebhookNotifier');

    for (const cfg of SALESFORCE_OBJECTS) {
        await toolingCreate('ApexTrigger', {
            Name: triggerName(cfg.object),
            TableEnumOrId: cfg.object,
            Body: renderTrigger(cfg.object, cfg.fields)
        });
        console.log(`✓ Deployed Apex trigger ${triggerName(cfg.object)} on ${cfg.object}`);
    }

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
