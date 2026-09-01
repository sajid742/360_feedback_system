/**
 * Built-in teacher-evaluation questionnaire used when a link is created without an
 * explicit questionnaire template. Ratings are on a 1–5 scale; the final item is a
 * free-text comment (not scored).
 */
export interface EvalQuestion {
  id: string;
  text: string;
  type: 'rating' | 'text';
}

export const DEFAULT_TEACHER_QUESTIONS: EvalQuestion[] = [
  { id: 'q_clarity', text: 'The teacher explains the subject clearly and understandably.', type: 'rating' },
  { id: 'q_preparation', text: 'The teacher is well prepared for lessons.', type: 'rating' },
  { id: 'q_engagement', text: 'The teacher keeps my child engaged and interested in the subject.', type: 'rating' },
  { id: 'q_fairness', text: 'The teacher treats students fairly and with respect.', type: 'rating' },
  { id: 'q_feedback', text: 'The teacher gives helpful feedback on my child’s progress.', type: 'rating' },
  { id: 'q_communication', text: 'The teacher communicates well with parents when needed.', type: 'rating' },
  { id: 'q_comment', text: 'Any additional comments for the teacher (optional).', type: 'text' },
];

export const DEFAULT_RATING_SCALE = [
  { value: 1, label: 'Strongly disagree' },
  { value: 2, label: 'Disagree' },
  { value: 3, label: 'Neutral' },
  { value: 4, label: 'Agree' },
  { value: 5, label: 'Strongly agree' },
];
