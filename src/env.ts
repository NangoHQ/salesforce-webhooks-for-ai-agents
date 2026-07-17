import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// Load .env from the project root (no dotenv dependency needed on Node 20.12+).
const envPath = path.resolve(import.meta.dirname, '..', '.env');
if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
}

export function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        console.error(`Missing required environment variable: ${name}. Copy .env.example to .env and fill it in.`);
        process.exit(1);
    }
    return value;
}

export const env = {
    nangoSecretKey: requireEnv('NANGO_SECRET_KEY'),
    connectionId: requireEnv('NANGO_CONNECTION_ID'),
    integrationId: process.env['NANGO_INTEGRATION_ID'] ?? 'salesforce',
    // Only needed by the provision script; validated there.
    inboundWebhookUrl: process.env['NANGO_INBOUND_WEBHOOK_URL'] ?? '',
    // Only needed by the webhook server; validated in server.ts. Required
    // there because without it the SDK falls back to hashing with the secret
    // key, which does not match how Nango signs webhooks on newer
    // environments — every webhook would be silently rejected with a 401.
    nangoWebhookSigningKey: process.env['NANGO_WEBHOOK_SIGNING_KEY'] ?? '',
    port: Number(process.env['PORT'] ?? 3000)
};
