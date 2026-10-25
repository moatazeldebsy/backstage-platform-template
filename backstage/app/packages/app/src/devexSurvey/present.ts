import {
  DRIVERS,
  PERCEPTIONS,
  SurveyAnswers,
  TIME_BUCKETS,
  TimeBucket,
  validateAnswers,
} from '@internal/engineering-intelligence-core';

// Pure form logic for the survey page — testable without rendering it.
//
// Validation is the core package's own `validateAnswers`, the same function the
// backend runs, so the page cannot accept something the server will refuse.

export const LIKERT_LABELS = ['Strongly disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly agree'];

export interface SurveyForm {
  likert: Record<string, number | undefined>;
  time: Record<TimeBucket, number>;
}

/**
 * An empty form. Time starts at zero in every bucket, not an even split: a
 * pre-filled 25/25/25/25 would be submitted unchanged by anyone in a hurry and
 * read as a real allocation.
 */
export function emptyForm(): SurveyForm {
  return {
    likert: {},
    time: Object.fromEntries(TIME_BUCKETS.map(b => [b.id, 0])) as Record<TimeBucket, number>,
  };
}

export function timeTotal(form: SurveyForm): number {
  return TIME_BUCKETS.reduce((sum, b) => sum + (form.time[b.id] || 0), 0);
}

export function unanswered(form: SurveyForm): number {
  return [...DRIVERS, ...PERCEPTIONS].filter(q => form.likert[q.id] === undefined).length;
}

/** The answer set to submit, or the first reason it cannot be submitted yet. */
export function toAnswers(form: SurveyForm): { answers: SurveyAnswers } | { error: string } {
  const missing = unanswered(form);
  if (missing > 0) return { error: `${missing} statement${missing === 1 ? '' : 's'} still to answer` };
  const total = timeTotal(form);
  if (total !== 100) return { error: `Time allocation adds up to ${total}%, not 100%` };
  return validateAnswers({
    drivers: Object.fromEntries(DRIVERS.map(d => [d.id, form.likert[d.id]])),
    perceptions: Object.fromEntries(PERCEPTIONS.map(p => [p.id, form.likert[p.id]])),
    time: form.time,
  });
}
