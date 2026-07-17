/**
 * Sends webhook payloads from Salesforce to Nango, for ANY sObject.
 *
 * Each watched object gets a thin trigger (see NangoRecordTrigger.trigger.tpl)
 * that hands its records to notifyChanges(). Placeholders are replaced by
 * scripts/provision-salesforce.ts before deployment via the Tooling API.
 */
public class NangoWebhookNotifier {
    // Nango inbound webhook URL for the Salesforce integration:
    // https://api.nango.dev/webhook/<environment-uuid>/<integration-id>
    private static final String WEBHOOK_URL = '{{NANGO_INBOUND_WEBHOOK_URL}}';

    // The Nango connection ID this org maps to. Nango routes the event to the
    // right connection by reading this value from the payload.
    public static final String CONNECTION_ID = '{{NANGO_CONNECTION_ID}}';

    // Case-sensitive comparison. Apex's == on Strings is case-insensitive,
    // which would treat case-only edits as "no change".
    public static Boolean differs(Object a, Object b) {
        if (a == null) return b != null;
        if (b == null) return true;
        return !String.valueOf(a).equals(String.valueOf(b));
    }

    /**
     * Shared trigger handler: diffs tracked fields, batches all changed
     * records of the invocation into ONE payload, and fires ONE async callout.
     * Pass oldList = null for inserts.
     */
    public static void notifyChanges(String objectName, List<SObject> newList, List<SObject> oldList, List<String> trackedFields) {
        // @future can't be called from batch/future contexts, and the @future
        // budget (50 calls/transaction) is capped — skip rather than break
        // someone else's transaction. The polling sync reconciles missed events.
        if (System.isFuture() || System.isBatch()) return;
        if (Limits.getFutureCalls() >= Limits.getLimitFutureCalls()) return;

        Map<Id, SObject> oldById = new Map<Id, SObject>();
        if (oldList != null) {
            for (SObject o : oldList) { oldById.put(o.Id, o); }
        }

        List<Map<String, Object>> changes = new List<Map<String, Object>>();
        for (SObject rec : newList) {
            SObject old = oldById.get(rec.Id);
            if (old != null) {
                // Loop guard: only fire when a tracked field actually changed,
                // so your own agent's writes don't cause webhook storms.
                Boolean changed = false;
                for (String f : trackedFields) {
                    if (differs(rec.get(f), old.get(f))) { changed = true; break; }
                }
                if (!changed) continue;
            }
            Map<String, Object> fields = new Map<String, Object>{ 'Id' => rec.Id };
            for (String f : trackedFields) { fields.put(f, rec.get(f)); }
            fields.put('LastModifiedDate', rec.get('LastModifiedDate'));
            changes.add(fields);
        }
        if (changes.isEmpty()) return;

        // The `nango` envelope is Nango's routing contract for Salesforce:
        // connectionId identifies the connection, eventType is matched against
        // sync scripts' webhookSubscriptions.
        Map<String, Object> payload = new Map<String, Object>{
            'nango' => new Map<String, Object>{
                'connectionId' => CONNECTION_ID,
                'eventType' => objectName.toLowerCase() + (oldList == null ? '.created' : '.updated')
            },
            'object' => objectName,
            'data' => changes
        };
        notify(JSON.serialize(payload));
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
