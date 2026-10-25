import type { SurveyAnswers } from '@internal/engineering-intelligence-core';

// Typed client for the devex-survey backend plugin.

export interface SurveyCycle {
  id: number;
  title: string;
  opensAt: string;
  closesAt: string;
  open: boolean;
}

export interface CurrentSurvey {
  cycle: SurveyCycle | null;
  answered: boolean;
  /** The caller's teams; a response is filed under one of these. */
  teams: string[];
  isAdmin: boolean;
  minResponses: number;
}

export interface FetchLike {
  fetch: typeof fetch;
}

export class DevexSurveyApi {
  constructor(
    private readonly fetchApi: FetchLike,
    private readonly baseUrl: string,
  ) {}

  private url(path: string) {
    return `${this.baseUrl}/api/devex-survey${path}`;
  }

  private async send<T>(path: string, body?: unknown): Promise<T> {
    const resp = await this.fetchApi.fetch(this.url(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const json = await resp.json().catch(() => ({}));
    // The backend's own message is the useful one ("already answered", "not
    // your team"), so it is surfaced rather than a bare status code.
    if (!resp.ok) throw new Error(json.error ?? `${path} → HTTP ${resp.status}`);
    return json as T;
  }

  async current(): Promise<CurrentSurvey> {
    const resp = await this.fetchApi.fetch(this.url('/current'));
    if (!resp.ok) throw new Error(`/current → HTTP ${resp.status}`);
    return (await resp.json()) as CurrentSurvey;
  }

  submit(cycleId: number, team: string, answers: SurveyAnswers): Promise<{ ok: true }> {
    return this.send('/responses', { cycleId, team, answers });
  }

  openCycle(title: string, days: number): Promise<SurveyCycle> {
    return this.send('/cycles', { title, days });
  }

  closeCycle(id: number): Promise<{ ok: boolean }> {
    return this.send(`/cycles/${id}/close`);
  }
}
