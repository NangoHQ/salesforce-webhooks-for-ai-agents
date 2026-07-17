/**
 * Fires a webhook to Nango whenever a {{OBJECT}} is created or updated.
 * Generated from NangoRecordTrigger.trigger.tpl by scripts/provision-salesforce.ts —
 * all the logic lives in NangoWebhookNotifier.notifyChanges().
 */
trigger {{TRIGGER_NAME}} on {{OBJECT}} (after insert, after update) {
    NangoWebhookNotifier.notifyChanges(
        '{{OBJECT}}',
        Trigger.new,
        Trigger.isUpdate ? Trigger.old : null,
        new List<String>{ {{FIELDS}} }
    );
}
