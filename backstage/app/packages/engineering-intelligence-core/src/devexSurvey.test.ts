// The failures this file prevents: a survey aggregate that identifies a person
// (a team of three's "average" is three people's answers), and a stored
// response carrying anything the question set did not ask for.

import {
  DRIVERS,
  MIN_RESPONSES,
  PERCEPTIONS,
  SurveyAnswers,
  aggregateSurvey,
  likertToScore,
  validateAnswers,
} from './devexSurvey';

function answers(score: number, newCapabilities = 40): SurveyAnswers {
  return {
    drivers: Object.fromEntries(DRIVERS.map(d => [d.id, score])) as SurveyAnswers['drivers'],
    perceptions: Object.fromEntries(PERCEPTIONS.map(p => [p.id, score])) as SurveyAnswers['perceptions'],
    time: { newCapabilities, maintenance: 30, toil: 100 - newCapabilities - 30 - 10, other: 10 },
  };
}

describe('question set', () => {
  it('has fourteen drivers with unique ids', () => {
    expect(DRIVERS).toHaveLength(14);
    expect(new Set(DRIVERS.map(d => d.id)).size).toBe(14);
  });
});

describe('validateAnswers', () => {
  it('accepts a complete answer set', () => {
    expect(validateAnswers(answers(4))).toEqual({ answers: answers(4) });
  });

  it('drops fields the question set does not define', () => {
    const raw = { ...answers(3), comment: 'free text', drivers: { ...answers(3).drivers, extra: 5 } };
    const result = validateAnswers(raw);
    expect('answers' in result && result.answers).toEqual(answers(3));
  });

  it.each([
    ['a missing driver', { ...answers(3), drivers: { ...answers(3).drivers, deepWork: undefined } }],
    ['an out-of-range answer', { ...answers(3), perceptions: { ...answers(3).perceptions, easeOfDelivery: 6 } }],
    ['a fractional answer', { ...answers(3), drivers: { ...answers(3).drivers, techDebt: 2.5 } }],
    ['time not summing to 100', { ...answers(3), time: { newCapabilities: 50, maintenance: 50, toil: 10, other: 0 } }],
    ['not an object', null],
  ])('rejects %s', (_label, raw) => {
    expect(validateAnswers(raw)).toHaveProperty('error');
  });
});

describe('aggregateSurvey', () => {
  it('maps 1–5 onto 0–100', () => {
    expect(likertToScore(1)).toBe(0);
    expect(likertToScore(3)).toBe(50);
    expect(likertToScore(5)).toBe(100);
  });

  it('withholds everything but the count below the floor', () => {
    const result = aggregateSurvey(Array(MIN_RESPONSES - 1).fill(answers(5)));
    expect(result).toEqual({ responses: MIN_RESPONSES - 1, withheld: true });
  });

  it('averages drivers, perceptions and time at the floor', () => {
    const result = aggregateSurvey([
      ...Array(3).fill(answers(5, 60)),
      ...Array(2).fill(answers(1, 10)),
    ]);
    expect(result.withheld).toBe(false);
    if (result.withheld) return;
    expect(result.responses).toBe(5);
    expect(result.dxi).toBe(60); // (3×100 + 2×0) / 5
    expect(result.perceptions.easeOfDelivery).toBe(60);
    expect(result.time.newCapabilities).toBe(0.4); // (3×0.6 + 2×0.1) / 5
  });
});
