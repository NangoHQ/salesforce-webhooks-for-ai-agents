/**
 * Fires a webhook to Nango whenever a Contact is created or updated.
 *
 * - Bulk-safe: batches the records of each trigger invocation (at most 200)
 *   into ONE payload and ONE @future callout. Note: a single transaction that
 *   DMLs more than 200 Contacts fires the trigger once per 200-record chunk,
 *   so it can consume multiple future calls (the limit is 50 per transaction);
 *   the budget guard below skips the callout instead of blowing up the
 *   caller's transaction, and the hourly reconciliation sync catches up.
 * - Loop-safe: on updates, only fires when a tracked field actually changed,
 *   so writes from your own agent (e.g. creating a Task) or unrelated
 *   automation don't cause webhook storms or infinite loops.
 * - Async-safe: @future can't be called from batch or future contexts;
 *   skipping there keeps this trigger from breaking bulk jobs and other
 *   automation. Missed events are reconciled by the hourly sync.
 */
trigger NangoContactTrigger on Contact (after insert, after update) {
    if (System.isFuture() || System.isBatch()) {
        return;
    }
    if (Limits.getFutureCalls() >= Limits.getLimitFutureCalls()) {
        return;
    }

    List<Map<String, Object>> changes = new List<Map<String, Object>>();

    for (Contact c : Trigger.new) {
        if (Trigger.isUpdate) {
            Contact old = Trigger.oldMap.get(c.Id);
            // NangoWebhookNotifier.differs is case-sensitive; Apex's != on
            // Strings is case-insensitive and would miss case-only edits.
            Boolean changed =
                NangoWebhookNotifier.differs(c.FirstName, old.FirstName) ||
                NangoWebhookNotifier.differs(c.LastName,  old.LastName)  ||
                NangoWebhookNotifier.differs(c.Email,     old.Email)     ||
                NangoWebhookNotifier.differs(c.Title,     old.Title)     ||
                NangoWebhookNotifier.differs(c.Phone,     old.Phone);
            if (!changed) continue;
        }

        changes.add(new Map<String, Object>{
            'Id'               => c.Id,
            'FirstName'        => c.FirstName,
            'LastName'         => c.LastName,
            'Email'            => c.Email,
            'Title'            => c.Title,
            'Phone'            => c.Phone,
            'LastModifiedDate' => c.LastModifiedDate
        });
    }

    if (changes.isEmpty()) {
        return;
    }

    // The `nango` envelope is Nango's routing contract for Salesforce:
    // connectionId identifies the connection, eventType is matched against
    // sync scripts' webhookSubscriptions.
    Map<String, Object> payload = new Map<String, Object>{
        'nango' => new Map<String, Object>{
            'connectionId' => NangoWebhookNotifier.CONNECTION_ID,
            'eventType'    => Trigger.isInsert ? 'contact.created' : 'contact.updated'
        },
        'data' => changes
    };

    NangoWebhookNotifier.notify(JSON.serialize(payload));
}
