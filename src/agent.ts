import Anthropic from '@anthropic-ai/sdk';
import type { Tool, MessageParam } from '@anthropic-ai/sdk/resources/messages';
import { env } from './env.js';
import { nango, getInstanceUrl, type NangoRecord } from './nango.js';
import { emit } from './events.js';
import { SALESFORCE_OBJECTS } from '../nango-integrations/salesforce/objects.js';

const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY
const MODEL = process.env['AGENT_MODEL'] ?? 'claude-sonnet-5';
const API_VERSION = 'v61.0';

const OBJECT_TYPES = SALESFORCE_OBJECTS.map((o) => o.object);

/**
 * The agent's tools write back to Salesforce through Nango's proxy, which
 * handles OAuth token refresh and logs every request. In a bigger setup you'd
 * expose Nango actions via its MCP server instead — see
 * https://nango.dev/docs/guides/functions/tool-calling
 */
const tools: Tool[] = [
    {
        name: 'get_salesforce_record',
        description: 'Fetch a full Salesforce record by object type and ID for more context.',
        input_schema: {
            type: 'object',
            properties: {
                object_type: { type: 'string', enum: OBJECT_TYPES },
                record_id: { type: 'string', description: 'The Salesforce record ID' }
            },
            required: ['object_type', 'record_id']
        }
    },
    {
        name: 'create_salesforce_task',
        description: 'Create a follow-up Task in Salesforce related to the changed record.',
        input_schema: {
            type: 'object',
            properties: {
                object_type: { type: 'string', enum: OBJECT_TYPES, description: 'Object type of the related record' },
                related_record_id: { type: 'string', description: 'ID of the record this task relates to' },
                subject: { type: 'string', description: 'Short task subject line' },
                description: { type: 'string', description: 'Task details for the sales rep' },
                priority: { type: 'string', enum: ['High', 'Normal', 'Low'] }
            },
            required: ['object_type', 'related_record_id', 'subject', 'description', 'priority']
        }
    }
];

interface CreatedTask {
    id: string;
    subject: string;
    priority: string;
    url?: string;
}

async function executeTool(name: string, input: any): Promise<{ result: string; task?: CreatedTask }> {
    const proxyDefaults = {
        providerConfigKey: env.integrationId,
        connectionId: env.connectionId
    };

    switch (name) {
        case 'get_salesforce_record': {
            const res = await nango.get({
                ...proxyDefaults,
                endpoint: `/services/data/${API_VERSION}/sobjects/${input.object_type}/${input.record_id}`
            });
            return { result: JSON.stringify(res.data) };
        }
        case 'create_salesforce_task': {
            // Tasks link to people (Contact/Lead) via WhoId and to everything
            // else (Account/Opportunity/...) via WhatId.
            const isPerson = input.object_type === 'Contact' || input.object_type === 'Lead';
            const res = await nango.post({
                ...proxyDefaults,
                endpoint: `/services/data/${API_VERSION}/sobjects/Task`,
                data: {
                    [isPerson ? 'WhoId' : 'WhatId']: input.related_record_id,
                    Subject: input.subject,
                    Description: input.description,
                    Priority: input.priority,
                    Status: 'Not Started'
                }
            });
            const instance = await getInstanceUrl();
            return {
                result: JSON.stringify(res.data),
                task: {
                    id: res.data.id,
                    subject: input.subject,
                    priority: input.priority,
                    ...(instance ? { url: `${instance}/lightning/r/Task/${res.data.id}/view` } : {})
                }
            };
        }
        default:
            return { result: `Unknown tool: ${name}` };
    }
}

/**
 * Runs the agent on a single changed record of any watched object. The record
 * arrives fresh from Nango's records cache moments after the change happened
 * in Salesforce. Each run is reported to the demo UI as one 'agent-activity'
 * event: which record changed, what the assistant decided, the task created.
 */
export async function runAgentOnRecordChange(record: NangoRecord): Promise<void> {
    const action = record._nango_metadata.last_action; // ADDED | UPDATED | DELETED
    const objectType = String(record['object'] ?? 'record');
    const displayName = String(record['display_name'] ?? record.id);
    console.log(`\n🤖 Agent run: ${objectType} ${record.id} (${displayName}) was ${action}`);

    if (action === 'DELETED') {
        console.log('   Skipping deleted record.');
        return;
    }

    emit('agent-start', { contact: displayName, contactId: record.id, object: objectType, action });

    let createdTask: CreatedTask | undefined;

    const messages: MessageParam[] = [
        {
            role: 'user',
            content:
                `A Salesforce ${objectType} was just ${action === 'ADDED' ? 'created' : 'updated'}:\n\n` +
                `${JSON.stringify({ id: record.id, name: displayName, ...(record['fields'] as object) }, null, 2)}\n\n` +
                `Decide on an appropriate follow-up and create exactly one Task for the sales rep. ` +
                `If the record data is too sparse to act on, fetch the full record first.`
        }
    ];

    for (let turn = 0; turn < 5; turn++) {
        const response = await anthropic.messages.create({
            model: MODEL,
            max_tokens: 1024,
            system:
                'You are a CRM assistant that reacts to Salesforce record changes (contacts, leads, accounts, opportunities). ' +
                'You create ONE concise, genuinely useful follow-up task per change, then summarize what you did in one sentence.',
            tools,
            messages
        });

        messages.push({ role: 'assistant', content: response.content });

        if (response.stop_reason !== 'tool_use') {
            const text = response.content.find((block) => block.type === 'text');
            const summary = text?.type === 'text' ? text.text : '(done)';
            console.log(`   Agent: ${summary}`);
            emit('agent-activity', {
                contact: displayName,
                contactId: record.id,
                object: objectType,
                action,
                summary,
                ...(createdTask ? { task: createdTask } : {})
            });
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
                const outcome = await executeTool(block.name, block.input);
                result = outcome.result;
                if (outcome.task) createdTask = outcome.task;
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
    emit('agent-activity', {
        contact: displayName,
        contactId: record.id,
        object: objectType,
        action,
        summary: 'Stopped after reaching the turn limit.',
        ...(createdTask ? { task: createdTask } : {})
    });
}
