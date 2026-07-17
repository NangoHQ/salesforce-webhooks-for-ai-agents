/**
 * Sends webhook payloads from Salesforce to Nango.
 *
 * Triggers cannot make synchronous HTTP callouts, so the callout runs in a
 * @future method. Placeholders are replaced by scripts/provision-salesforce.ts
 * before this class is deployed via the Tooling API.
 */
public class NangoWebhookNotifier {
    // Nango inbound webhook URL for the Salesforce integration:
    // https://api.nango.dev/webhook/<environment-uuid>/<integration-id>
    private static final String WEBHOOK_URL = '{{NANGO_INBOUND_WEBHOOK_URL}}';

    // The Nango connection ID this org maps to. Nango routes the event to the
    // right connection by reading this value from the payload.
    public static final String CONNECTION_ID = '{{NANGO_CONNECTION_ID}}';

    // Case-sensitive string comparison. Apex's == / != on Strings is
    // case-insensitive, which would treat case-only edits as "no change".
    public static Boolean differs(String a, String b) {
        return a == null ? b != null : !a.equals(b);
    }

    @future(callout=true)
    public static void notify(String payload) {
        HttpRequest req = new HttpRequest();
        req.setEndpoint(WEBHOOK_URL);
        req.setMethod('POST');
        req.setHeader('Content-Type', 'application/json');
        req.setTimeout(10000);
        req.setBody(payload);

        HttpResponse res = new Http().send(req);
        System.debug('Nango webhook response: ' + res.getStatusCode() + ' ' + res.getBody());
    }
}
