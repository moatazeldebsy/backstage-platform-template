import type {
  DimensionScore,
  HealthReport,
  MaturityAssessment,
} from '@internal/engineering-intelligence-core';
import type { SnapshotRow } from './present';

// Typed client for the engineering-intelligence backend plugin.
//
// Note what is absent: a demo-data fallback. Every other page in extensions.tsx
// substitutes plausible numbers when its source is unreachable, and this one
// deliberately does not — an organisation-wide health score is the kind of
// figure that gets screenshotted into a board pack, so a failed request has to
// look like a failed request. See docs/design/adr-0006-engineering-intelligence.md.

export interface EvidenceGap {
  dimension: string;
  missing: string[];
  expectedFrom: string[];
}

export type HealthResponse = HealthReport & { evidenceGaps: EvidenceGap[] };

/** The Platform Health breakdown behind the Platform dimension. */
export interface PlatformResponse {
  generatedAt: string;
  available: boolean;
  reason?: string;
  services?: number;
  owned?: number;
  scaffolded?: number;
  ownershipCoverage?: number | null;
  goldenPathAdoption?: number | null;
  templateUsage?: { template: string; count: number }[];
  notOnGoldenPath?: { count: number; named: string[]; truncated: boolean };
  selfService?: { completed: number; failed: number; inFlight: number } | null;
  platformScore?: number | null;
}

export interface AiReadinessResponse {
  generatedAt: string;
  overallScore: number | null;
  status: string;
  measurable: number;
  total: number;
  areas: Record<string, DimensionScore & { dimension: string }>;
}

export interface EvaluationResponse {
  available: boolean;
  reason?: string;
  generatedAt?: string;
  assertions?: number;
  passed?: number;
  failed?: number;
  passRate?: number | null;
  categories?: {
    category: string;
    metrics: string[];
    assertions: number;
    passed: number;
    passRate: number | null;
    meanScore: number | null;
  }[];
  uncategorised?: string[];
  suites?: {
    suite: string;
    assertions: number;
    passed: number;
    passRate: number;
  }[];
}

export interface AiCostResponse {
  available: boolean;
  reason?: string;
  windowDays?: number;
  totalUsd?: number;
  attributedUsd?: number;
  unattributedUsd?: number;
  attributedRatio?: number | null;
  byTeam?: { key: string; costUsd: number; traces: number }[];
  byModel?: {
    model: string;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
  }[];
  recommendations?: {
    id: string;
    severity: string;
    title: string;
    action: string;
    evidence: string;
  }[];
}

export interface AdvisorResponse {
  question: string;
  answer: string;
  citedMetrics: string[];
  insufficientEvidence: boolean;
  actions: string[];
}

export interface ExecutiveReport {
  generatedAt: string;
  overallScore: number | null;
  maturity: string;
  improved: { dimension: string; label: string; delta: number }[];
  declined: { dimension: string; label: string; delta: number }[];
  trend: { delta: number; sinceDays: number } | null;
  trendUnavailableReason?: string;
  snapshotsAvailable: number;
}

export interface FetchLike {
  fetch: typeof fetch;
}

export class EngineeringIntelligenceApi {
  constructor(
    private readonly fetchApi: FetchLike,
    private readonly baseUrl: string,
  ) {}

  private async get<T>(path: string): Promise<T> {
    const resp = await this.fetchApi.fetch(
      `${this.baseUrl}/api/engineering-intelligence${path}`,
    );
    if (!resp.ok) {
      // Surfaced verbatim in the page's error state. 401 here means the session
      // expired rather than that the platform is unhealthy, and the two should
      // not read the same.
      throw new Error(`${path} → HTTP ${resp.status}`);
    }
    return (await resp.json()) as T;
  }

  health(): Promise<HealthResponse> {
    return this.get<HealthResponse>('/health');
  }

  maturity(): Promise<MaturityAssessment & { generatedAt: string }> {
    return this.get<MaturityAssessment & { generatedAt: string }>('/maturity');
  }

  dimension(id: string): Promise<DimensionScore> {
    return this.get<DimensionScore>(`/dimensions/${encodeURIComponent(id)}`);
  }

  aiReadiness(): Promise<AiReadinessResponse> {
    return this.get<AiReadinessResponse>('/ai-readiness');
  }

  platform(): Promise<PlatformResponse> {
    return this.get<PlatformResponse>('/platform');
  }

  evaluation(): Promise<EvaluationResponse> {
    return this.get<EvaluationResponse>('/evaluation');
  }

  aiCost(): Promise<AiCostResponse> {
    return this.get<AiCostResponse>('/ai-cost');
  }

  executiveReport(): Promise<ExecutiveReport> {
    return this.get<ExecutiveReport>('/report/executive');
  }

  async advisor(question: string): Promise<AdvisorResponse> {
    const resp = await this.fetchApi.fetch(
      `${this.baseUrl}/api/engineering-intelligence/advisor`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question }),
      },
    );
    if (!resp.ok) throw new Error(`advisor → HTTP ${resp.status}`);
    return (await resp.json()) as AdvisorResponse;
  }

  snapshots(limit = 30): Promise<{ snapshots: SnapshotRow[] }> {
    return this.get<{ snapshots: SnapshotRow[] }>(`/snapshots?limit=${limit}`);
  }

  async refresh(): Promise<void> {
    const resp = await this.fetchApi.fetch(
      `${this.baseUrl}/api/engineering-intelligence/refresh`,
      { method: 'POST' },
    );
    if (!resp.ok) throw new Error(`refresh → HTTP ${resp.status}`);
  }
}
