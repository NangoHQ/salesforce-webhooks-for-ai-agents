/**
 * The single config that drives the whole pipeline. Add an object here and:
 *  - scripts/provision-salesforce.ts deploys an Apex trigger for it
 *  - the `records` sync polls it and handles its webhook events
 *  - the app (src/server.ts, src/agent.ts, UI) picks it up automatically
 *
 * Deliberately NOT here: Task. The agent creates Tasks — subscribing to the
 * object your agent writes to makes it react to its own output.
 */

/** Keep in step with SALESFORCE_OBJECTS below — the sync's model names are typed from this. */
export type SalesforceModel = 'SalesforceContact' | 'SalesforceLead' | 'SalesforceAccount' | 'SalesforceOpportunity';

export interface SalesforceObjectConfig {
    /** Salesforce sObject API name (also works for custom objects, e.g. 'Invoice__c') */
    object: string;
    /** Nango model name the records are cached under */
    model: SalesforceModel;
    /** Fields to track: changes to these fire the webhook, and they're what gets synced */
    fields: string[];
    /** Fields combined into a human-readable record name */
    nameFields: string[];
}

export const SALESFORCE_OBJECTS: SalesforceObjectConfig[] = [
    {
        object: 'Contact',
        model: 'SalesforceContact',
        fields: ['FirstName', 'LastName', 'Email', 'Title', 'Phone'],
        nameFields: ['FirstName', 'LastName']
    },
    {
        object: 'Lead',
        model: 'SalesforceLead',
        fields: ['FirstName', 'LastName', 'Email', 'Company', 'Status', 'Title'],
        nameFields: ['FirstName', 'LastName']
    },
    {
        object: 'Account',
        model: 'SalesforceAccount',
        fields: ['Name', 'Industry', 'Phone', 'Website'],
        nameFields: ['Name']
    },
    {
        object: 'Opportunity',
        model: 'SalesforceOpportunity',
        fields: ['Name', 'StageName', 'Amount', 'CloseDate'],
        nameFields: ['Name']
    }
];

export function configForModel(model: string): SalesforceObjectConfig | undefined {
    return SALESFORCE_OBJECTS.find((o) => o.model === model);
}

export function configForObject(object: string): SalesforceObjectConfig | undefined {
    return SALESFORCE_OBJECTS.find((o) => o.object.toLowerCase() === object.toLowerCase());
}
