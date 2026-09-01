/**
 * The single authority on whether an in-app notification has somewhere useful to go.
 *
 * A notification is ACTIONABLE when the application has a page where the recipient can
 * actually do the thing the notification is about, and the recipient is allowed to open
 * it. Everything else is INFORMATIONAL: it is still shown and still counts as unread,
 * but it is not clickable, because a link that goes nowhere useful teaches people to
 * distrust the ones that do.
 *
 * Two deliberate properties:
 *
 * 1. **Resolved from `type`, never from the stored `link`.** `user_notifications.link`
 *    is written by whichever service emitted the record; treating it as a navigation
 *    target would make the stored payload a way to steer the browser. The column is
 *    still returned for backward compatibility, but nothing navigates by it.
 *
 * 2. **Resolved at READ time against the VIEWING user.** Permissions change, roles are
 *    reassigned, and a notification can outlive the access that made it actionable. A
 *    check performed when the row was written would be stale; this one never is.
 *
 * Adding an entry here is the only step needed to make a notification type clickable.
 */

export interface NotificationAction {
  /** Internal client route. Always an absolute in-app path — never an external URL. */
  route: string;
  /** Short verb shown on the affordance, e.g. "Give feedback". */
  label: string;
}

interface ActionDef extends NotificationAction {
  /** Permission the VIEWER must hold for the destination to be reachable. */
  permission?: string;
}

/**
 * Types NOT listed here are informational by definition, which is the safe default —
 * an unknown or historical type resolves to no action rather than to a guess.
 *
 * Currently informational, and why:
 *   feedback_submitted — a receipt for work already finished; nothing left to do.
 *   cycle_closed       — the cycle is over; submissions are no longer accepted.
 *   admin_message      — a free-form announcement with no associated task.
 */
const ACTIONS: Readonly<Record<string, ActionDef>> = Object.freeze({
  // "A feedback cycle has started" — the recipient has reviews waiting.
  cycle_started: { route: '/appraisal', label: 'Open appraisals', permission: 'appraisal.read' },
  // Both reminders exist precisely because feedback is still outstanding.
  feedback_reminder: { route: '/appraisal', label: 'Give feedback', permission: 'appraisal.read' },
  final_reminder: { route: '/appraisal', label: 'Give feedback', permission: 'appraisal.read' },
});

/** Notification types that can ever be actionable (for tests and documentation). */
export const ACTIONABLE_NOTIFICATION_TYPES: readonly string[] = Object.freeze(Object.keys(ACTIONS));

/**
 * The action for a notification type, or `null` when there is nowhere useful to go.
 * Returns null for unknown types, historical records and users who lack the
 * permission for the destination.
 */
export function resolveNotificationAction(
  type: string | null | undefined,
  permissions: readonly string[] | null | undefined,
): NotificationAction | null {
  if (!type) return null;
  const def = Object.prototype.hasOwnProperty.call(ACTIONS, type) ? ACTIONS[type] : undefined;
  if (!def) return null;
  if (def.permission && !(permissions ?? []).includes(def.permission)) return null;
  return { route: def.route, label: def.label };
}
