import type { Channel } from './providers/types';

/**
 * Notification events. Every automated message the platform sends corresponds to
 * one of these events. Admins can customise the subject/body template per event
 * *and* per channel; if they don't, the built-in defaults below are used.
 */
export const COMM_EVENTS = {
  cycleStarted: 'cycle_started',
  feedbackReminder: 'feedback_reminder',
  finalReminder: 'final_reminder',
  feedbackSubmitted: 'feedback_submitted',
  cycleClosed: 'cycle_closed',
  adminMessage: 'admin_message',
} as const;

export type CommEvent = (typeof COMM_EVENTS)[keyof typeof COMM_EVENTS];

export const COMM_EVENT_LIST: { event: CommEvent; label: string; description: string }[] = [
  { event: COMM_EVENTS.cycleStarted, label: 'Feedback Cycle Started', description: 'Sent to every assigned evaluator when a feedback cycle is activated.' },
  { event: COMM_EVENTS.feedbackReminder, label: 'Feedback Reminder', description: 'Periodic nudge to evaluators who have not yet submitted.' },
  { event: COMM_EVENTS.finalReminder, label: 'Final Reminder', description: 'Last reminder as the submission deadline approaches.' },
  { event: COMM_EVENTS.feedbackSubmitted, label: 'Feedback Submitted', description: 'Confirmation to an evaluator once their feedback is recorded.' },
  { event: COMM_EVENTS.cycleClosed, label: 'Feedback Cycle Closed', description: 'Sent to participants when a cycle is closed.' },
  { event: COMM_EVENTS.adminMessage, label: 'Administrator Message', description: 'Free-form announcement broadcast by an administrator.' },
];

/**
 * Placeholder catalogue. Templates reference these with `{{token}}`. Not every
 * event supplies every placeholder — unresolved tokens are rendered as an empty
 * string so a template never leaks a raw `{{...}}` to a recipient.
 */
export const COMM_PLACEHOLDERS: { token: string; label: string }[] = [
  { token: 'evaluatorName', label: 'Evaluator Name' },
  { token: 'employeeName', label: 'Employee Name' },
  { token: 'studentName', label: 'Student Name' },
  { token: 'teacherName', label: 'Teacher Name' },
  { token: 'subject', label: 'Subject' },
  { token: 'feedbackCycle', label: 'Feedback Cycle' },
  { token: 'organizationName', label: 'Organization Name' },
  { token: 'secureLink', label: 'Secure Evaluation Link' },
  { token: 'expiryDate', label: 'Expiry Date' },
  { token: 'period', label: 'Evaluation Period' },
];

export interface TemplateBody {
  subject: string;
  body: string;
  isActive: boolean;
}

/**
 * Built-in default templates. Keyed by event; the same copy is used for all
 * channels unless an admin overrides a specific channel. SMS ignores `subject`.
 */
export const DEFAULT_TEMPLATES: Record<CommEvent, TemplateBody> = {
  [COMM_EVENTS.cycleStarted]: {
    isActive: true,
    subject: '{{organizationName}} — you have feedback to complete for "{{feedbackCycle}}"',
    body:
      'Hello {{evaluatorName}},\n\n' +
      'The feedback cycle "{{feedbackCycle}}" ({{period}}) has started and you have been asked to provide feedback for {{employeeName}}.\n\n' +
      'Please complete your evaluation here: {{secureLink}}\n' +
      'This link is valid until {{expiryDate}}.\n\n' +
      'Thank you,\n{{organizationName}}',
  },
  [COMM_EVENTS.feedbackReminder]: {
    isActive: true,
    subject: 'Reminder: your feedback for "{{feedbackCycle}}" is pending',
    body:
      'Hello {{evaluatorName}},\n\n' +
      'This is a reminder that your feedback for {{employeeName}} in the "{{feedbackCycle}}" cycle is still outstanding.\n\n' +
      'Please complete it here: {{secureLink}}\n' +
      'Deadline: {{expiryDate}}.\n\n' +
      'Thank you,\n{{organizationName}}',
  },
  [COMM_EVENTS.finalReminder]: {
    isActive: true,
    subject: 'Final reminder: "{{feedbackCycle}}" closes on {{expiryDate}}',
    body:
      'Hello {{evaluatorName}},\n\n' +
      'This is the final reminder to submit your feedback for {{employeeName}} in the "{{feedbackCycle}}" cycle. ' +
      'The cycle closes on {{expiryDate}}.\n\n' +
      'Complete it now: {{secureLink}}\n\n' +
      'Thank you,\n{{organizationName}}',
  },
  [COMM_EVENTS.feedbackSubmitted]: {
    isActive: true,
    subject: 'Thank you — your feedback for "{{feedbackCycle}}" has been recorded',
    body:
      'Hello {{evaluatorName}},\n\n' +
      'We have received your feedback for {{employeeName}} in the "{{feedbackCycle}}" cycle. No further action is needed.\n\n' +
      'Thank you,\n{{organizationName}}',
  },
  [COMM_EVENTS.cycleClosed]: {
    isActive: true,
    subject: 'The feedback cycle "{{feedbackCycle}}" is now closed',
    body:
      'Hello {{evaluatorName}},\n\n' +
      'The feedback cycle "{{feedbackCycle}}" has been closed. Thank you for taking part.\n\n' +
      '{{organizationName}}',
  },
  [COMM_EVENTS.adminMessage]: {
    isActive: true,
    subject: 'A message from {{organizationName}}',
    body: 'Hello {{evaluatorName}},\n\n{{period}}\n\n{{organizationName}}',
  },
};

export const ALL_CHANNELS: Channel[] = ['email', 'sms', 'whatsapp'];
