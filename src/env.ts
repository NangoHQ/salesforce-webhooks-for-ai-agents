import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// Load .env from the project root (no dotenv dependency needed on Node 20.12+).
const envPath = path.resolve(import.meta.dirname, '..', '.env');
if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
}

function required(name: string): string {
    const value = process.env[name];
    if (!value) {
        console.error(`Missing required environment variable: ${name}. Copy .env.example to .env and fill it in.`);
        process.exit(1);
    }
    return value;
}

export const env = {
    nangoSecretKey: required('NANGO_SECRET_KEY'),
    nangoWebhookSigningKey: process.env['NANGO_WEBHOOK_SIGNING_KEY'] ?? '',
    integrationId: process.env['NANGO_INTEGRATION_ID'] ?? 'salesforce',
    connectionId: required('NANGO_CONNECTION_ID'),
    inboundWebhookUrl: process.env['NANGO_INBOUND_WEBHOOK_URL'] ?? '',
    port: Number(process.env['PORT'] ?? 3000)
};
