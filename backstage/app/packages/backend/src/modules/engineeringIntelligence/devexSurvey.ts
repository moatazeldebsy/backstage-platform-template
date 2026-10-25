import {
  Core4TeamInput,
  MetricSample,
  SurveyAggregate,
} from '@internal/engineering-intelligence-core';
import { CollectorResult, getJson } from './source';

// DevEx survey collector — the self-reported half of DX Core 4.
//
// Reads the devex-survey plugin's aggregate endpoint, which has already applied
// the response floor. A withheld organisation-wide aggregate produces no
// samples, so Effectiveness and Impact report insufficient evidence until
// enough people have answered — never a score from the first three responses.

export interface SurveyCycle {
  id: number;
  title: string;
  opensAt: string;
  closesAt: string;
  open: boolean;
}

export interface SurveyAggregateResponse {
  cycle: SurveyCycle | null;
  minResponses: number;
  org?: SurveyAggregate;
  teams?: ({ team: string } & SurveyAggregate)[];
}

export interface SurveyAccess {
  baseUrl(): Promise<string>;
  token(): Promise<string>;
}

export type SurveyCollectorResult = CollectorResult & {
  survey?: SurveyAggregateResponse;
};

/** Org-level samples from an aggregate. Pure, so it is testable. */
export function surveySamples(body: SurveyAggregateResponse, now: string): MetricSample[] {
  const org = body.org;
  if (!body.cycle || !org || org.withheld) return [];
  // An open cycle is still collecting, so it is observed now; a closed one was
  // last observed when it closed, which is what lets a reader see its age.
  const observedAt = body.cycle.open ? now : body.cycle.closesAt;
  const sample = (metric: string, value: number): MetricSample => ({
    metric,
    value,
    source: 'devex-survey',
    observedAt,
  });
  return [
    sample('survey.dxi', org.dxi),
    sample('survey.perceivedDeliveryRate', org.perceptions.perceivedDeliveryRate),
    sample('survey.easeOfDelivery', org.perceptions.easeOfDelivery),
    sample('survey.perceivedQuality', org.perceptions.perceivedQuality),
    sample('survey.newCapabilitiesRatio', org.time.newCapabilities),
  ];
}

export async function collectSurvey(access: SurveyAccess): Promise<SurveyCollectorResult> {
  let base: string;
  let token: string;
  try {
    base = await access.baseUrl();
    token = await access.token();
  } catch (error) {
    return {
      samples: [],
      unavailable: { source: 'devex-survey', reason: `Could not obtain credentials: ${error}` },
    };
  }

  const body = await getJson<SurveyAggregateResponse>(`${base}/aggregate`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!body) {
    return {
      samples: [],
      unavailable: { source: 'devex-survey', reason: `The survey plugin at ${base} did not answer.` },
    };
  }
  if (!body.cycle) {
    return {
      samples: [],
      survey: body,
      unavailable: { source: 'devex-survey', reason: 'No survey cycle has been run yet.' },
    };
  }
  return { samples: surveySamples(body, new Date().toISOString()), survey: body };
}

/** Merge throughput and survey rows into one input per team. */
export function teamInputs(
  throughputTeams: Core4TeamInput[],
  survey: SurveyAggregateResponse | undefined,
): Core4TeamInput[] {
  const byTeam = new Map<string, Core4TeamInput>();
  for (const t of throughputTeams) byTeam.set(t.team, { ...t });
  for (const { team, ...aggregate } of survey?.teams ?? []) {
    byTeam.set(team, { ...(byTeam.get(team) ?? { team }), survey: aggregate as SurveyAggregate });
  }
  return [...byTeam.values()];
}
