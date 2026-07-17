/**
 * Fires a webhook to Nango whenever a Contact is created or updated.
 *
 * - Bulk-safe: batches up to 200 records per transaction into ONE payload and
 *   ONE @future callout (avoids burning async Apex allocations per record).
 * - Loop-safe: on updates, only fires when a tracked field actually changed,
 *   so writes from your own agent (e.g. creating a Task) or unrelated
 *   automation don't cause webhook storms or infinite loops.
 */
trigger NangoContactTrigger on Contact (after insert, after update) {
    List<Map<String, Object>> changes = new List<Map<String, Object>>();

    for (Contact c : Trigger.new) {
        if (Trigger.isUpdate) {
            Contact old = Trigger.oldMap.get(c.Id);
            Boolean changed =
                c.FirstName != old.FirstName ||
                c.LastName  != old.LastName  ||
                c.Email     != old.Email     ||
                c.Title     != old.Title     ||
                c.Phone     != old.Phone;
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
