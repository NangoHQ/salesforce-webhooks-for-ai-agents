/**
 * Provisions the Salesforce side of the webhook pipeline for a connection —
 * no Salesforce CLI or Setup UI clicking required. Everything goes through
 * Nango's proxy using the connection's OAuth access token:
 *
 *   1. Remote Site Setting for https://api.nango.dev (allows Apex callouts)
 *   2. NangoWebhookNotifier Apex class (shared handler + async HTTP callout)
 *   3. One thin Apex trigger per watched object in SALESFORCE_OBJECTS
 *      (rendered from salesforce/NangoRecordTrigger.trigger.tpl)
 *
 * Runs from the CLI (scripts/provision-salesforce.ts) or automatically when a
 * user connects their org (the `auth` webhook handler in src/server.ts) —
 * the same flow a multi-tenant product runs for every new customer.
 *
 * Note: creating Apex via the Tooling API works in Developer Edition, sandbox,
 * and scratch orgs. Production orgs require a Metadata API deploy or package.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { nango } from './nango.js';
import { env } from './env.js';

const API_VERSION = 'v61.0';
const NANGO_HOST = 'https://api.nango.dev';

export class ProvisionError extends Error {}

type Log = (line: string) => void;

export async function provisionSalesforce(connectionId: string, log: Log = console.log): Promise<void> {
    if (!env.inboundWebhookUrl) {
        throw new ProvisionError(
            'Missing NANGO_INBOUND_WEBHOOK_URL in .env. Copy it from the Nango dashboard: ' +
                'Integrations → your Salesforce integration → Webhook URL.'
        );
    }

    const { SALESFORCE_OBJECTS } = await import('../nango-integrations/salesforce/objects.js');

    const proxyDefaults = { providerConfigKey: env.integrationId, connectionId };

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

    function loadApexSource(file: string): string {
        const source = readFileSync(path.resolve(import.meta.dirname, '..', 'salesforce', file), 'utf8');
        return source
            .replaceAll('{{NANGO_INBOUND_WEBHOOK_URL}}', env.inboundWebhookUrl)
            .replaceAll('{{NANGO_CONNECTION_ID}}', connectionId);
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

    // --- 0. The base `salesforce` provider is the only one whose inbound
    // webhooks are routed; variants like salesforce-sandbox silently no-op.
    const integrationRes = await fetch(`${NANGO_HOST}/integrations/${env.integrationId}`, {
        headers: { Authorization: `Bearer ${env.nangoSecretKey}` }
    });
    if (integrationRes.ok) {
        const body = (await integrationRes.json()) as { data?: { provider?: string } };
        const provider = body.data?.provider;
        if (provider && provider !== 'salesforce') {
            throw new ProvisionError(
                `Integration "${env.integrationId}" uses provider "${provider}". Inbound webhook routing only ` +
                    `works with the base "salesforce" provider; variants silently drop webhooks.`
            );
        }
    }

    // --- 1. Fail fast on typos or stale field names — a bad field would
    // otherwise only surface as a runtime exception in the customer's org.
    for (const cfg of SALESFORCE_OBJECTS) {
        const res = await nango.get({
            ...proxyDefaults,
            endpoint: `/services/data/${API_VERSION}/sobjects/${cfg.object}/describe`
        });
        const available = new Set((res.data.fields ?? []).map((f: any) => f.name));
        const missing = cfg.fields.filter((f) => !available.has(f));
        if (missing.length > 0) {
            throw new ProvisionError(`${cfg.object} has no field(s): ${missing.join(', ')}. Fix nango-integrations/salesforce/objects.ts.`);
        }
    }
    log('✓ All tracked fields exist on their objects');

    // --- 2. Remote Site Setting (Tooling API sobject: RemoteProxy).
    const existingSites = await toolingQuery(`SELECT Id, SiteName FROM RemoteProxy WHERE EndpointUrl = '${NANGO_HOST}'`);
    if (existingSites.length > 0) {
        log(`✓ Remote Site Setting already exists (${existingSites[0].SiteName})`);
    } else {
        // Creation requires the FullName + Metadata shape; flat fields are query-only.
        await toolingCreate('RemoteProxy', {
            FullName: 'Nango',
            Metadata: {
                url: NANGO_HOST,
                isActive: true,
                disableProtocolSecurity: false,
                description: 'Allow Apex callouts to Nango webhooks'
            }
        });
        log('✓ Created Remote Site Setting "Nango" → https://api.nango.dev');
    }

    // --- 3. Apex, in dependency order. Cleanup is discovery-driven (not
    // config-driven) so triggers for objects removed from the config can't
    // strand the class and wedge re-provisioning.
    const pipelineTriggers = await toolingQuery<{ Id: string; Name: string }>(
        "SELECT Id, Name FROM ApexTrigger WHERE Name LIKE 'Nango%Trigger'"
    );
    for (const trigger of pipelineTriggers.filter((t) => /^Nango\w+Trigger$/.test(t.Name))) {
        await toolingDelete('ApexTrigger', trigger.Id);
        log(`  (removed existing ApexTrigger ${trigger.Name})`);
    }
    const existingClasses = await toolingQuery<{ Id: string }>("SELECT Id FROM ApexClass WHERE Name = 'NangoWebhookNotifier'");
    for (const record of existingClasses) {
        await toolingDelete('ApexClass', record.Id);
        log('  (removed existing ApexClass NangoWebhookNotifier)');
    }

    await toolingCreate('ApexClass', { Name: 'NangoWebhookNotifier', Body: loadApexSource('NangoWebhookNotifier.cls') });
    log('✓ Deployed Apex class NangoWebhookNotifier');

    for (const cfg of SALESFORCE_OBJECTS) {
        await toolingCreate('ApexTrigger', {
            Name: triggerName(cfg.object),
            TableEnumOrId: cfg.object,
            Body: renderTrigger(cfg.object, cfg.fields)
        });
        log(`✓ Deployed Apex trigger ${triggerName(cfg.object)} on ${cfg.object}`);
    }
}
