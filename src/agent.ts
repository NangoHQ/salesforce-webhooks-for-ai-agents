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
        name: 'query_salesforce',
        description: 'Run a read-only SOQL SELECT query against Salesforce (e.g. to find records, count opportunities, check pipeline).',
        input_schema: {
            type: 'object',
            properties: {
                soql: { type: 'string', description: 'A SOQL SELECT statement' }
            },
            required: ['soql']
        }
    },
    {
        name: 'create_salesforce_task',
        description: 'Create a follow-up Task in Salesforce related to a record.',
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
        case 'query_salesforce': {
            const soql = String(input.soql ?? '').trim();
            if (!/^select\s/i.test(soql)) {
                return { result: 'Rejected: only SELECT queries are allowed.' };
            }
            const res = await nango.get({
                ...proxyDefaults,
                endpoint: `/services/data/${API_VERSION}/query`,
                params: { q: soql }
            });
            return { result: JSON.stringify(res.data).slice(0, 6000) };
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

/** Rolling context of what happened, so the chat can answer "what just happened?" */
const recentActivity: string[] = [];
function remember(line: string): void {
    recentActivity.push(`[${new Date().toLocaleTimeString()}] ${line}`);
    if (recentActivity.length > 20) recentActivity.shift();
}

interface LoopOutcome {
    summary: string;
    task?: CreatedTask;
}

/** Shared Claude tool-use loop for event-driven runs and chat turns. */
async function runToolLoop(messages: MessageParam[], system: string, onTool?: (name: string) => void): Promise<LoopOutcome> {
    let createdTask: CreatedTask | undefined;

    for (let turn = 0; turn < 8; turn++) {
        const response = await anthropic.messages.create({
            model: MODEL,
            max_tokens: 1024,
            system,
            tools,
            messages
        });

        messages.push({ role: 'assistant', content: response.content });

        if (response.stop_reason !== 'tool_use') {
            const text = response.content.find((block) => block.type === 'text');
            return { summary: text?.type === 'text' ? text.text : '(done)', ...(createdTask ? { task: createdTask } : {}) };
        }

        const toolResults = [];
        for (const block of response.content) {
            if (block.type !== 'tool_use') continue;
            console.log(`   → Tool call: ${block.name}(${JSON.stringify(block.input)})`);
            onTool?.(block.name);
            // Surface tool failures to the model as error results instead of
            // crashing the run — Salesforce 4xx errors are routine and the
            // model can often recover.
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

    return { summary: 'Stopped after reaching the turn limit.', ...(createdTask ? { task: createdTask } : {}) };
}

/**
 * Event-driven run: reacts to a single changed record of any watched object,
 * arriving fresh from Nango's records cache moments after the change happened
 * in Salesforce. Reported to the UI as one 'agent-activity' chat entry.
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

    try {
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

        const outcome = await runToolLoop(
            messages,
            'You are a CRM assistant that reacts to Salesforce record changes (contacts, leads, accounts, opportunities). ' +
                'You create ONE concise, genuinely useful follow-up task per change, then summarize what you did in one sentence.'
        );

        console.log(`   Agent: ${outcome.summary}`);
        remember(`${objectType} "${displayName}" was ${action.toLowerCase()} → ${outcome.task ? `created task "${outcome.task.subject}"` : outcome.summary.slice(0, 120)}`);
        emit('agent-activity', {
            contact: displayName,
            contactId: record.id,
            object: objectType,
            action,
            summary: outcome.summary,
            ...(outcome.task ? { task: outcome.task } : {})
        });
    } catch (err) {
        // Always resolve the UI's pending card — a run that dies mid-flight
        // must not leave a spinner orbiting forever. (The record is not
        // retried automatically: the server advances the cursor past it.)
        emit('agent-activity', {
            contact: displayName,
            contactId: record.id,
            object: objectType,
            action,
            summary: 'Agent run failed — see server logs. This change will not be retried automatically.'
        });
        throw err;
    }
}

/** One shared chat conversation for the demo UI (in-memory, single session). */
const chatHistory: MessageParam[] = [];
let chatBusy = false;

export function isChatBusy(): boolean {
    return chatBusy;
}

export async function chatWithAgent(text: string): Promise<void> {
    chatBusy = true;
    try {
        emit('chat-user', { text });
        chatHistory.push({ role: 'user', content: text });
        // Keep the demo conversation bounded (drop oldest exchanges, keep pairs).
        while (chatHistory.length > 24) chatHistory.shift();

        const system =
            'You are CRM Copilot, an AI assistant connected to the user\'s Salesforce org through Nango. ' +
            'You watch record changes in real time and can query Salesforce (read-only SOQL), fetch records, and create follow-up Tasks. ' +
            'Be concise and concrete; use tools rather than guessing. Amounts are in USD.\n\n' +
            'Recent activity you initiated from Salesforce events (most recent last):\n' +
            (recentActivity.length ? recentActivity.join('\n') : '(none yet this session)');

        const outcome = await runToolLoop([...chatHistory], system, (tool) => emit('chat-tool', { tool }));

        chatHistory.push({ role: 'assistant', content: outcome.summary });
        emit('chat-assistant', { text: outcome.summary, ...(outcome.task ? { task: outcome.task } : {}) });
    } catch (err) {
        emit('chat-assistant', { text: 'Something went wrong handling that message — check the server logs.' });
        throw err;
    } finally {
        chatBusy = false;
    }
}
