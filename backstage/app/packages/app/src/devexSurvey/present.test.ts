import { DRIVERS, PERCEPTIONS } from '@internal/engineering-intelligence-core';
import { emptyForm, timeTotal, toAnswers, unanswered } from './present';

function complete() {
  const form = emptyForm();
  for (const q of [...DRIVERS, ...PERCEPTIONS]) form.likert[q.id] = 4;
  form.time = { newCapabilities: 50, maintenance: 30, toil: 10, other: 10 };
  return form;
}

describe('survey form', () => {
  it('starts empty, with no time pre-allocated', () => {
    const form = emptyForm();
    expect(unanswered(form)).toBe(DRIVERS.length + PERCEPTIONS.length);
    expect(timeTotal(form)).toBe(0);
  });

  it('names how many statements are left', () => {
    const form = complete();
    delete form.likert.deepWork;
    expect(toAnswers(form)).toEqual({ error: '1 statement still to answer' });
  });

  it('refuses a time split that does not add up to 100', () => {
    const form = complete();
    form.time.other = 0;
    expect(toAnswers(form)).toEqual({ error: 'Time allocation adds up to 90%, not 100%' });
  });

  it('produces the answer set the backend validates', () => {
    const result = toAnswers(complete());
    expect('answers' in result && result.answers.time.newCapabilities).toBe(50);
    expect('answers' in result && Object.keys(result.answers.drivers)).toHaveLength(14);
  });
});
