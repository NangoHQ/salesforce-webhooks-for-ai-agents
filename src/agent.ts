import Anthropic from '@anthropic-ai/sdk';
import type { Tool, MessageParam } from '@anthropic-ai/sdk/resources/messages';
import { env } from './env.js';
import { nango, type NangoRecord } from './nango.js';

const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY
const MODEL = process.env['AGENT_MODEL'] ?? 'claude-sonnet-5';
const API_VERSION = 'v61.0';

/**
 * The agent's tools write back to Salesforce through Nango's proxy, which
 * handles OAuth token refresh and logs every request. In a bigger setup you'd
 * expose Nango actions via its MCP server instead — see
 * https://nango.dev/docs/guides/functions/tool-calling
 */
const tools: Tool[] = [
    {
        name: 'get_salesforce_contact',
        description: 'Fetch the full Salesforce Contact record by ID for more context.',
        input_schema: {
            type: 'object',
            properties: {
                contact_id: { type: 'string', description: 'The Salesforce Contact ID' }
            },
            required: ['contact_id']
        }
    },
    {
        name: 'create_salesforce_task',
        description: 'Create a follow-up Task in Salesforce linked to a Contact.',
        input_schema: {
            type: 'object',
            properties: {
                contact_id: { type: 'string', description: 'The Salesforce Contact ID this task relates to' },
                subject: { type: 'string', description: 'Short task subject line' },
                description: { type: 'string', description: 'Task details for the sales rep' },
                priority: { type: 'string', enum: ['High', 'Normal', 'Low'] }
            },
            required: ['contact_id', 'subject', 'description', 'priority']
        }
    }
];

async function executeTool(name: string, input: any): Promise<string> {
    const proxyDefaults = {
        providerConfigKey: env.integrationId,
        connectionId: env.connectionId
    };

    switch (name) {
        case 'get_salesforce_contact': {
            const res = await nango.get({
                ...proxyDefaults,
                endpoint: `/services/data/${API_VERSION}/sobjects/Contact/${input.contact_id}`
            });
            return JSON.stringify(res.data);
        }
        case 'create_salesforce_task': {
            const res = await nango.post({
                ...proxyDefaults,
                endpoint: `/services/data/${API_VERSION}/sobjects/Task`,
                data: {
                    WhoId: input.contact_id,
                    Subject: input.subject,
                    Description: input.description,
                    Priority: input.priority,
                    Status: 'Not Started'
                }
            });
            return JSON.stringify(res.data);
        }
        default:
            return `Unknown tool: ${name}`;
    }
}

/**
 * Runs the agent on a single changed contact record. The record arrives fresh
 * from Nango's records cache moments after the change happened in Salesforce.
 */
export async function runAgentOnContactChange(record: NangoRecord): Promise<void> {
    const action = record._nango_metadata.last_action; // ADDED | UPDATED | DELETED
    console.log(`\n🤖 Agent run: contact ${record.id} was ${action}`);

    if (action === 'DELETED') {
        console.log('   Skipping deleted record.');
        return;
    }

    const { _nango_metadata, ...contact } = record;

    const messages: MessageParam[] = [
        {
            role: 'user',
            content:
                `A Salesforce contact was just ${action === 'ADDED' ? 'created' : 'updated'}:\n\n` +
                `${JSON.stringify(contact, null, 2)}\n\n` +
                `Decide on an appropriate follow-up and create exactly one Task for the sales rep. ` +
                `If the contact data is too sparse to act on, fetch the full record first.`
        }
    ];

    for (let turn = 0; turn < 5; turn++) {
        const response = await anthropic.messages.create({
            model: MODEL,
            max_tokens: 1024,
            system:
                'You are a CRM assistant that reacts to Salesforce contact changes. ' +
                'You create ONE concise, genuinely useful follow-up task per change, then summarize what you did in one sentence.',
            tools,
            messages
        });

        messages.push({ role: 'assistant', content: response.content });

        if (response.stop_reason !== 'tool_use') {
            const text = response.content.find((block) => block.type === 'text');
            console.log(`   Agent: ${text?.type === 'text' ? text.text : '(done)'}`);
            return;
        }

        const toolResults = [];
        for (const block of response.content) {
            if (block.type !== 'tool_use') continue;
            console.log(`   → Tool call: ${block.name}(${JSON.stringify(block.input)})`);
            // Surface tool failures to the model as error results instead of
            // crashing the run — Salesforce 4xx errors (deleted record, bad
            // input) are routine and the model can often recover.
            let result: string;
            let isError = false;
            try {
                result = await executeTool(block.name, block.input);
            } catch (err: any) {
                result = err?.response
                    ? `Request failed with status ${err.response.status}: ${JSON.stringify(err.response.data)}`
                    : String(err);
                isError = true;
            }
            console.log(`   ← ${result.slice(0, 200)}`);
            toolResults.push({ type: 'tool_result' as const, tool_use_id: block.id, content: result, is_error: isError });
        }
        messages.push({ role: 'user', content: toolResults });
    }

    console.warn('   Agent stopped: max turns reached.');
}
