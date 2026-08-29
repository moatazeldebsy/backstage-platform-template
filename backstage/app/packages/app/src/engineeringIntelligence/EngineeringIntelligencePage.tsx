import { useCallback, useEffect, useMemo, useState } from 'react';
import { Content, Header, Page, Progress } from '@backstage/core-components';
import { configApiRef, fetchApiRef, useApi } from '@backstage/core-plugin-api';
import Box from '@material-ui/core/Box';
import Button from '@material-ui/core/Button';
import Grid from '@material-ui/core/Grid';
import Paper from '@material-ui/core/Paper';
import Table from '@material-ui/core/Table';
import TableBody from '@material-ui/core/TableBody';
import TableCell from '@material-ui/core/TableCell';
import TableHead from '@material-ui/core/TableHead';
import TableRow from '@material-ui/core/TableRow';
import Tooltip from '@material-ui/core/Tooltip';
import Typography from '@material-ui/core/Typography';
import type {
  DimensionId,
  DimensionScore,
  Recommendation,
} from '@internal/engineering-intelligence-core';
import {
  AdvisorResponse,
  AiCostResponse,
  AiReadinessResponse,
  EngineeringIntelligenceApi,
  EvaluationResponse,
  ExecutiveReport,
  HealthResponse,
  PlatformResponse,
} from './api';
import {
  BAND_COLOUR,
  DIMENSION_DETAIL_PAGE,
  DIMENSION_LABELS,
  SnapshotRow,
  band,
  formatMetricValue,
  formatScore,
  ladder,
  maturityHeadline,
  relativeTime,
  statusLine,
  topRisks,
  orderedDimensions,
  trend,
  trendLabel,
} from './present';

// The Engineering Intelligence dashboard.
//
// Two rules govern what this page is allowed to draw.
//
// It never invents a number. A dimension with no evidence renders as a grey
// "Insufficient evidence" card naming the source it needs — not as a zero, and
// not as demo data behind a banner the way the older pages do. This is the one
// screen where a plausible-looking fabrication would travel furthest.
//
// It aggregates rather than duplicates. `/dora`, `/finops`, `/scorecard` and
// `/slo` already render the underlying series; every dimension card links to the
// page that owns its detail instead of redrawing it here.

// Unconfirmed is grey, not red — a level we cannot assess is not a level we
// failed, and the ladder must not imply otherwise.
const LADDER_COLOUR: Record<'met' | 'unmet' | 'unconfirmed', string> = {
  met: BAND_COLOUR.strong,
  unmet: BAND_COLOUR.weak,
  unconfirmed: BAND_COLOUR.unknown,
};

const SEVERITY_MARK: Record<Recommendation['severity'], string> = {
  critical: '🔴',
  warning: '🟠',
  info: '🔵',
};

function Card({
  children,
  ...rest
}: {
  children: React.ReactNode;
  [k: string]: any;
}) {
  return (
    <Paper
      {...rest}
      style={{ padding: 16, height: '100%', ...(rest.style ?? {}) }}
    >
      {children}
    </Paper>
  );
}

function SectionTitle({
  children,
  hint,
}: {
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <Box
      display="flex"
      alignItems="baseline"
      style={{ gap: 8, marginBottom: 8 }}
    >
      <Typography variant="h6">{children}</Typography>
      {hint && (
        <Typography variant="caption" color="textSecondary">
          {hint}
        </Typography>
      )}
    </Box>
  );
}

function Movement({ exec }: { exec: ExecutiveReport }) {
  if (exec.improved.length === 0 && exec.declined.length === 0) return null;
  const chip = (label: string, delta: number, colour: string) => (
    <Typography
      key={label}
      variant="caption"
      style={{ color: colour, marginRight: 12 }}
    >
      {delta >= 0 ? '▲' : '▼'} {label} {delta >= 0 ? '+' : ''}
      {delta}
    </Typography>
  );
  return (
    <Box marginTop={1}>
      {/* Split rather than one signed list: what improved and what declined are
          read by different people for different reasons. */}
      {exec.improved.map(c => chip(c.label, c.delta, BAND_COLOUR.strong))}
      {exec.declined.map(c => chip(c.label, c.delta, BAND_COLOUR.weak))}
    </Box>
  );
}

function Headline({
  report,
  snapshots,
  exec,
}: {
  report: HealthResponse;
  snapshots: SnapshotRow[];
  exec?: ExecutiveReport;
}) {
  const movement = trend(snapshots);
  const colour = BAND_COLOUR[band(report.overallScore)];

  return (
    <Card>
      <Grid container spacing={2} alignItems="center">
        <Grid item>
          <Typography variant="overline" color="textSecondary">
            Engineering Health
          </Typography>
          <Box display="flex" alignItems="baseline" style={{ gap: 8 }}>
            <Typography style={{ fontSize: 56, lineHeight: 1, color: colour }}>
              {formatScore(report.overallScore)}
            </Typography>
            <Typography variant="h6" color="textSecondary">
              / 100
            </Typography>
          </Box>
        </Grid>

        <Grid item xs>
          <Typography variant="body1">
            {maturityHeadline(report.maturity)}
          </Typography>
          <Typography
            variant="body2"
            color="textSecondary"
            style={{ marginTop: 4 }}
          >
            {/* trendLabel distinguishes three cases the reader cares about:
                no history at all, two collections that agree, and a real move. */}
            {trendLabel(movement)} · collected{' '}
            {relativeTime(report.generatedAt)}
          </Typography>
          {exec && <Movement exec={exec} />}
          {report.status !== 'ok' && (
            <Typography
              variant="body2"
              style={{ color: BAND_COLOUR.unknown, marginTop: 4 }}
            >
              Scored from{' '}
              {
                Object.values(report.dimensions).filter(d => d.score !== null)
                  .length
              }{' '}
              of {Object.keys(report.dimensions).length} dimensions. Unscored
              dimensions are excluded from the total rather than counted as
              zero.
            </Typography>
          )}
        </Grid>
      </Grid>
    </Card>
  );
}

function DimensionCard({
  dimension,
  onSelect,
  selected,
}: {
  dimension: DimensionScore;
  onSelect: () => void;
  selected: boolean;
}) {
  const id = dimension.dimension;
  const colour = BAND_COLOUR[band(dimension.score)];
  const detail = DIMENSION_DETAIL_PAGE[id];
  const unscored = dimension.score === null;

  return (
    <Card
      onClick={onSelect}
      style={{
        cursor: 'pointer',
        borderLeft: `4px solid ${colour}`,
        outline: selected ? `2px solid ${colour}` : 'none',
      }}
    >
      <Typography variant="body2" color="textSecondary">
        {DIMENSION_LABELS[id]}
      </Typography>
      <Typography style={{ fontSize: 34, lineHeight: 1.2, color: colour }}>
        {formatScore(dimension.score)}
      </Typography>
      <Typography
        variant="caption"
        style={{ display: 'block', color: unscored ? colour : undefined }}
      >
        {statusLine(dimension)}
      </Typography>
      {detail && (
        <Typography
          variant="caption"
          style={{ display: 'block', marginTop: 6 }}
        >
          <a href={detail.to} onClick={e => e.stopPropagation()}>
            {detail.label} →
          </a>
        </Typography>
      )}
    </Card>
  );
}

function EvidenceTable({ dimension }: { dimension: DimensionScore }) {
  return (
    <Card>
      <SectionTitle hint="every score decomposes into the rows below; the impacts sum to it">
        {DIMENSION_LABELS[dimension.dimension]} — evidence
      </SectionTitle>

      {dimension.evidence.length === 0 ? (
        <Typography variant="body2" color="textSecondary">
          Nothing was collected for this dimension.
        </Typography>
      ) : (
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Metric</TableCell>
              <TableCell align="right">Observed</TableCell>
              <TableCell align="right">Score</TableCell>
              <TableCell align="right">Impact</TableCell>
              <TableCell>Source</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {dimension.evidence.map(row => (
              <TableRow key={row.metric}>
                <TableCell>
                  {row.metric}
                  {row.caveat && (
                    <Tooltip title={row.caveat}>
                      <span style={{ marginLeft: 6, cursor: 'help' }}>ⓘ</span>
                    </Tooltip>
                  )}
                </TableCell>
                <TableCell align="right">
                  {formatMetricValue(row.metric, row.value)}
                </TableCell>
                <TableCell align="right">
                  {Math.round(row.normalised)}
                </TableCell>
                <TableCell align="right">{row.impact}</TableCell>
                <TableCell>
                  <Tooltip title={`observed ${relativeTime(row.observedAt)}`}>
                    <span>{row.source}</span>
                  </Tooltip>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {dimension.missing.length > 0 && (
        <Box marginTop={2}>
          <Typography variant="caption" color="textSecondary">
            Not collected:{' '}
            {dimension.missing
              .map(m => `${m.metric} (${m.expectedFrom})`)
              .join(' · ')}
          </Typography>
        </Box>
      )}
    </Card>
  );
}

function MaturityLadder({ report }: { report: HealthResponse }) {
  const rows = ladder(report.maturity);
  return (
    <Card>
      <SectionTitle hint="levels are floors — one weak dimension holds the level down">
        Maturity
      </SectionTitle>
      {rows.map(row => {
        const colour = LADDER_COLOUR[row.status];
        return (
          <Box
            key={row.level}
            paddingY={1}
            style={{ borderTop: '1px solid rgba(128,128,128,0.2)' }}
          >
            <Box display="flex" alignItems="baseline" style={{ gap: 8 }}>
              <Typography
                style={{ color: colour, fontWeight: row.current ? 700 : 400 }}
              >
                Level {row.level} — {row.name}
              </Typography>
              <Typography variant="caption" style={{ color: colour }}>
                {row.status}
              </Typography>
              {row.current && (
                <Typography variant="caption" color="textSecondary">
                  ← you are here
                </Typography>
              )}
            </Box>
            {row.blockers.length > 0 && (
              <Typography variant="caption" color="textSecondary">
                {row.blockers.join(' · ')}
              </Typography>
            )}
          </Box>
        );
      })}
    </Card>
  );
}

function Risks({ report }: { report: HealthResponse }) {
  const risks = topRisks(report);
  return (
    <Card>
      <SectionTitle hint="derived from measured evidence only">
        Top risks
      </SectionTitle>
      {risks.length === 0 ? (
        <Typography variant="body2" color="textSecondary">
          Nothing measured is below its target.
        </Typography>
      ) : (
        risks.map(risk => (
          <Box key={risk.id} paddingY={1}>
            <Typography variant="body2">
              {SEVERITY_MARK[risk.severity]} {risk.title}
            </Typography>
            <Typography
              variant="caption"
              color="textSecondary"
              style={{ display: 'block' }}
            >
              {risk.action}
            </Typography>
            {risk.evidence[0] && (
              <Typography
                variant="caption"
                style={{ display: 'block', opacity: 0.75 }}
              >
                {risk.evidence[0].metric} ={' '}
                {formatMetricValue(
                  risk.evidence[0].metric,
                  risk.evidence[0].value,
                )}{' '}
                · {risk.evidence[0].source}
              </Typography>
            )}
          </Box>
        ))
      )}
    </Card>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <Box>
      <Typography variant="body2" color="textSecondary">
        {label}
      </Typography>
      <Typography style={{ fontSize: 26, lineHeight: 1.2 }}>{value}</Typography>
      {hint && (
        <Typography variant="caption" color="textSecondary">
          {hint}
        </Typography>
      )}
    </Box>
  );
}

const pct = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`;

function PlatformHealth({ platform }: { platform: PlatformResponse }) {
  if (!platform.available) {
    return (
      <Card style={{ borderLeft: `4px solid ${BAND_COLOUR.unknown}` }}>
        <SectionTitle>Platform Health</SectionTitle>
        <Typography variant="body2" color="textSecondary">
          {platform.reason ?? 'Not collected yet.'}
        </Typography>
      </Card>
    );
  }

  const gap = platform.notOnGoldenPath;
  const self = platform.selfService;

  return (
    <Card>
      <SectionTitle hint="counts are context, not a score — a bigger catalog is not a better one">
        Platform Health
      </SectionTitle>

      <Grid container spacing={3}>
        <Grid item xs={6} sm={3}>
          <Stat label="Services" value={String(platform.services ?? 0)} />
        </Grid>
        <Grid item xs={6} sm={3}>
          <Stat
            label="Ownership"
            value={pct(platform.ownershipCoverage)}
            hint={`${platform.owned ?? 0} of ${platform.services ?? 0} owned`}
          />
        </Grid>
        <Grid item xs={6} sm={3}>
          <Stat
            label="Golden path"
            value={pct(platform.goldenPathAdoption)}
            hint={`${platform.scaffolded ?? 0} scaffolded`}
          />
        </Grid>
        <Grid item xs={6} sm={3}>
          <Stat
            label="Self-service"
            value={
              self && self.completed + self.failed > 0
                ? pct(self.completed / (self.completed + self.failed))
                : '—'
            }
            hint={
              self && self.completed + self.failed > 0
                ? `${self.completed} succeeded · ${self.failed} failed`
                : 'no scaffolder task has finished yet'
            }
          />
        </Grid>
      </Grid>

      {gap && gap.count > 0 && (
        <Box marginTop={2}>
          <Typography variant="body2">
            <strong>{gap.count}</strong>{' '}
            {gap.count === 1 ? 'service is' : 'services are'} not using an
            approved golden path.
          </Typography>
          <Typography variant="caption" color="textSecondary">
            {gap.named.join(', ')}
            {gap.truncated ? ` … and ${gap.count - gap.named.length} more` : ''}
          </Typography>
        </Box>
      )}

      {platform.templateUsage && platform.templateUsage.length > 0 && (
        <Box marginTop={2}>
          <Typography variant="caption" color="textSecondary">
            Templates in use:{' '}
            {platform.templateUsage
              .map(t => `${t.template} (${t.count})`)
              .join(' · ')}
          </Typography>
        </Box>
      )}
    </Card>
  );
}

const AI_AREA_LABELS: Record<string, string> = {
  governance: 'Governance',
  evaluation: 'Evaluation',
  observability: 'Observability',
  modelManagement: 'Model mgmt',
  promptManagement: 'Prompt mgmt',
  reliability: 'Reliability',
  security: 'Security',
  privacy: 'Privacy',
  architecture: 'Architecture',
  testing: 'Testing',
  cost: 'Cost',
  incidentManagement: 'Incidents',
};

function AiReadiness({ readiness }: { readiness: AiReadinessResponse }) {
  const areas = Object.values(readiness.areas);
  return (
    <Card>
      <SectionTitle
        hint={`${readiness.measurable} of ${readiness.total} areas measurable — the rest are reported, not averaged in`}
      >
        AI Engineering Readiness
      </SectionTitle>

      <Box
        display="flex"
        alignItems="baseline"
        style={{ gap: 8, marginBottom: 12 }}
      >
        <Typography
          style={{
            fontSize: 34,
            lineHeight: 1.2,
            color: BAND_COLOUR[band(readiness.overallScore)],
          }}
        >
          {formatScore(readiness.overallScore)}
        </Typography>
        {readiness.overallScore === null ? (
          // Saying why beats a bare dash. A reader seeing per-area scores below
          // and no headline needs to know the roll-up was withheld deliberately,
          // not that it failed to load.
          <Typography variant="caption" style={{ color: BAND_COLOUR.unknown }}>
            no overall score — too little of the model is measurable
          </Typography>
        ) : (
          <Typography variant="caption" color="textSecondary">
            / 100
          </Typography>
        )}
      </Box>

      <Grid container spacing={1}>
        {areas.map(area => (
          <Grid item xs={6} sm={4} md={2} key={area.dimension}>
            <Typography
              variant="caption"
              color="textSecondary"
              style={{ display: 'block' }}
            >
              {AI_AREA_LABELS[area.dimension] ?? area.dimension}
            </Typography>
            <Typography style={{ color: BAND_COLOUR[band(area.score)] }}>
              {formatScore(area.score)}
            </Typography>
            {area.score === null && (
              <Typography
                variant="caption"
                style={{
                  display: 'block',
                  color: BAND_COLOUR.unknown,
                  fontSize: 10,
                }}
              >
                {area.missing[0]?.expectedFrom.replace(
                  'not collected — ',
                  '',
                ) ?? 'no source'}
              </Typography>
            )}
          </Grid>
        ))}
      </Grid>
    </Card>
  );
}

/** Shown wherever a source has not produced data, with its own reason. */
function NotYetAvailable({
  title,
  reason,
}: {
  title: string;
  reason?: string;
}) {
  return (
    <Card style={{ borderLeft: `4px solid ${BAND_COLOUR.unknown}` }}>
      <SectionTitle>{title}</SectionTitle>
      <Typography variant="body2" color="textSecondary">
        {reason ?? 'Not collected yet.'}
      </Typography>
    </Card>
  );
}

function Evaluation({ evaluation }: { evaluation: EvaluationResponse }) {
  if (!evaluation.available) {
    return <NotYetAvailable title="AI Evaluation" reason={evaluation.reason} />;
  }
  return (
    <Card>
      <SectionTitle hint="results, not whether a suite exists">
        AI Evaluation
      </SectionTitle>

      <Grid container spacing={3}>
        <Grid item xs={4}>
          <Stat label="Assertions" value={String(evaluation.assertions ?? 0)} />
        </Grid>
        <Grid item xs={4}>
          <Stat label="Passed" value={String(evaluation.passed ?? 0)} />
        </Grid>
        <Grid item xs={4}>
          <Stat
            label="Failed"
            value={String(evaluation.failed ?? 0)}
            hint={(evaluation.failed ?? 0) > 0 ? 'needs attention' : undefined}
          />
        </Grid>
      </Grid>

      <Box marginTop={2}>
        {(evaluation.categories ?? []).map(c => (
          <Box
            key={c.category}
            display="flex"
            style={{ gap: 8 }}
            paddingY={0.25}
          >
            <Typography variant="body2" style={{ minWidth: 150 }}>
              {c.category}
            </Typography>
            <Typography
              variant="body2"
              style={{
                color:
                  BAND_COLOUR[
                    band(c.passRate === null ? null : c.passRate * 100)
                  ],
              }}
            >
              {c.passRate === null ? '—' : `${Math.round(c.passRate * 100)}%`}
            </Typography>
            <Typography variant="caption" color="textSecondary">
              {c.metrics.join(', ')}
            </Typography>
          </Box>
        ))}
      </Box>

      {(evaluation.uncategorised ?? []).length > 0 && (
        <Box marginTop={2}>
          <Typography variant="caption" color="textSecondary">
            {/* Surfaced rather than dropped: a suite counted nowhere is worse
                than one that fails, because nobody notices. */}
            Not categorised: {evaluation.uncategorised!.join(', ')} — add a
            pattern to METRIC_CATEGORIES so these count.
          </Typography>
        </Box>
      )}
    </Card>
  );
}

function AiSpend({ cost }: { cost: AiCostResponse }) {
  if (!cost.available) {
    return <NotYetAvailable title="AI Spend" reason={cost.reason} />;
  }
  const unattributed = cost.unattributedUsd ?? 0;
  return (
    <Card>
      <SectionTitle
        hint={`last ${cost.windowDays} days — spend is reported, never scored`}
      >
        AI Spend
      </SectionTitle>

      <Grid container spacing={3}>
        <Grid item xs={6}>
          <Stat label="Total" value={`$${cost.totalUsd ?? 0}`} />
        </Grid>
        <Grid item xs={6}>
          <Stat
            label="Attributed"
            value={
              cost.attributedRatio === null ||
              cost.attributedRatio === undefined
                ? '—'
                : `${Math.round(cost.attributedRatio * 100)}%`
            }
            hint={
              unattributed > 0
                ? `$${unattributed} has no owner`
                : 'every trace matched a catalog entity'
            }
          />
        </Grid>
      </Grid>

      {(cost.byTeam ?? []).length > 0 && (
        <Box marginTop={2}>
          <Typography variant="caption" color="textSecondary">
            By team
          </Typography>
          {cost.byTeam!.map(t => (
            <Typography key={t.key} variant="body2">
              {t.key} — ${t.costUsd}
            </Typography>
          ))}
        </Box>
      )}

      {(cost.byModel ?? []).length > 0 && (
        <Box marginTop={2}>
          <Typography variant="caption" color="textSecondary">
            By model:{' '}
            {cost.byModel!.map(m => `${m.model} $${m.costUsd}`).join(' · ')}
          </Typography>
        </Box>
      )}
    </Card>
  );
}

const ADVISOR_QUESTIONS: { id: string; label: string }[] = [
  { id: 'biggest-risks', label: 'Biggest risks?' },
  { id: 'why-changed', label: 'Why did the score move?' },
  { id: 'focus-next', label: 'What next?' },
  { id: 'teams-needing-attention', label: 'Which teams?' },
  { id: 'ai-readiness', label: 'AI ready?' },
  { id: 'reduce-cost', label: 'Reduce cost?' },
];

function Advisor({ api }: { api: EngineeringIntelligenceApi }) {
  const [asked, setAsked] = useState<string | undefined>();
  const [reply, setReply] = useState<AdvisorResponse | undefined>();
  const [busy, setBusy] = useState(false);

  const ask = async (question: string) => {
    setBusy(true);
    setAsked(question);
    setReply(await api.advisor(question).catch(() => undefined));
    setBusy(false);
  };

  return (
    <Card>
      <SectionTitle hint="answers computed from the report — a question the data cannot answer is refused, not guessed">
        Ask
      </SectionTitle>

      <Box display="flex" flexWrap="wrap" style={{ gap: 8 }}>
        {ADVISOR_QUESTIONS.map(q => (
          <Button
            key={q.id}
            size="small"
            variant={asked === q.id ? 'contained' : 'outlined'}
            onClick={() => ask(q.id)}
          >
            {q.label}
          </Button>
        ))}
      </Box>

      {busy && (
        <Typography
          variant="body2"
          color="textSecondary"
          style={{ marginTop: 12 }}
        >
          Working…
        </Typography>
      )}

      {!busy && reply && (
        <Box
          marginTop={2}
          paddingLeft={2}
          style={{
            // Grey, not red: "the data cannot answer this" is not a failure.
            borderLeft: `4px solid ${
              reply.insufficientEvidence
                ? BAND_COLOUR.unknown
                : BAND_COLOUR.strong
            }`,
          }}
        >
          <Typography variant="body1" style={{ whiteSpace: 'pre-line' }}>
            {reply.answer}
          </Typography>

          {reply.actions.length > 0 && (
            <Box marginTop={1}>
              {reply.actions.map(a => (
                <Typography key={a} variant="body2" color="textSecondary">
                  → {a}
                </Typography>
              ))}
            </Box>
          )}

          <Typography
            variant="caption"
            color="textSecondary"
            style={{ display: 'block', marginTop: 8 }}
          >
            {reply.citedMetrics.length > 0
              ? `Based on: ${reply.citedMetrics.join(', ')}`
              : 'No metric supports an answer to this — see the text above.'}
          </Typography>
        </Box>
      )}
    </Card>
  );
}

function EvidenceGaps({ report }: { report: HealthResponse }) {
  if (report.evidenceGaps.length === 0) return null;
  return (
    <Card style={{ borderLeft: `4px solid ${BAND_COLOUR.unknown}` }}>
      <SectionTitle hint="a gap in instrumentation, not a finding about the organisation">
        Cannot measure yet
      </SectionTitle>
      {report.evidenceGaps.map(gap => (
        <Box key={gap.dimension} paddingY={0.5}>
          <Typography variant="body2">
            {DIMENSION_LABELS[gap.dimension as DimensionId] ?? gap.dimension}
          </Typography>
          <Typography variant="caption" color="textSecondary">
            needs {gap.expectedFrom.join(', ')} — {gap.missing.join(', ')}
          </Typography>
        </Box>
      ))}
    </Card>
  );
}

export function EngineeringIntelligencePage() {
  const fetchApi = useApi(fetchApiRef);
  const configApi = useApi(configApiRef);
  const baseUrl = configApi.getString('backend.baseUrl');

  const api = useMemo(
    () => new EngineeringIntelligenceApi(fetchApi, baseUrl),
    [fetchApi, baseUrl],
  );

  const [report, setReport] = useState<HealthResponse | undefined>();
  const [snapshots, setSnapshots] = useState<SnapshotRow[]>([]);
  const [platform, setPlatform] = useState<PlatformResponse | undefined>();
  const [readiness, setReadiness] = useState<AiReadinessResponse | undefined>();
  const [evaluation, setEvaluation] = useState<
    EvaluationResponse | undefined
  >();
  const [cost, setCost] = useState<AiCostResponse | undefined>();
  const [exec, setExec] = useState<ExecutiveReport | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<DimensionId | undefined>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const health = await api.health();
      setReport(health);
      // A failing trend query must not blank a working report — the score is
      // the point of the page, the sparkline is not.
      const history = await api.snapshots(30).catch(() => ({ snapshots: [] }));
      setSnapshots(history.snapshots);
      // Same rule as the trend: a failing detail query must not blank a working
      // report. The score is the point of the page.
      setPlatform(await api.platform().catch(() => undefined));
      setReadiness(await api.aiReadiness().catch(() => undefined));
      // Each detail view fails independently: one unavailable source must not
      // blank the rest of the page.
      setEvaluation(await api.evaluation().catch(() => undefined));
      setCost(await api.aiCost().catch(() => undefined));
      setExec(await api.executiveReport().catch(() => undefined));
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  // Explicit order, not the report's key order — the report round-trips through
  // a Postgres jsonb column, which reorders object keys.
  const dimensions = report ? orderedDimensions(report.dimensions) : [];
  const selectedDimension = selected ? report?.dimensions[selected] : undefined;

  return (
    <Page themeId="tool">
      <Header
        title="Engineering Intelligence"
        subtitle="Platform, Developer Experience, Quality, Reliability, AI, Security and FinOps health — scored from the platform's own telemetry"
      />
      <Content>
        {loading && <Progress />}

        {!loading && error && (
          <Paper
            style={{
              padding: 16,
              borderLeft: `4px solid ${BAND_COLOUR.weak}`,
            }}
          >
            <Typography variant="body1">
              Could not load the Engineering Health report.
            </Typography>
            <Typography variant="body2" color="textSecondary">
              {error}
            </Typography>
            <Typography variant="caption" color="textSecondary">
              No score is shown rather than a placeholder one — see the
              Engineering Intelligence docs on why this page has no demo mode.
            </Typography>
            <Box marginTop={1}>
              <Button size="small" variant="outlined" onClick={load}>
                Retry
              </Button>
            </Box>
          </Paper>
        )}

        {!loading && report && (
          <Grid container spacing={3}>
            <Grid item xs={12}>
              <Headline report={report} snapshots={snapshots} exec={exec} />
            </Grid>

            {dimensions.map(dimension => (
              <Grid item xs={12} sm={6} md={3} key={dimension.dimension}>
                <DimensionCard
                  dimension={dimension}
                  selected={selected === dimension.dimension}
                  onSelect={() =>
                    setSelected(
                      selected === dimension.dimension
                        ? undefined
                        : dimension.dimension,
                    )
                  }
                />
              </Grid>
            ))}

            {selectedDimension && (
              <Grid item xs={12}>
                <EvidenceTable dimension={selectedDimension} />
              </Grid>
            )}

            {platform && (
              <Grid item xs={12}>
                <PlatformHealth platform={platform} />
              </Grid>
            )}

            {readiness && (
              <Grid item xs={12}>
                <AiReadiness readiness={readiness} />
              </Grid>
            )}

            {evaluation && (
              <Grid item xs={12} md={6}>
                <Evaluation evaluation={evaluation} />
              </Grid>
            )}
            {cost && (
              <Grid item xs={12} md={6}>
                <AiSpend cost={cost} />
              </Grid>
            )}

            <Grid item xs={12}>
              <Advisor api={api} />
            </Grid>

            <Grid item xs={12} md={6}>
              <Risks report={report} />
            </Grid>
            <Grid item xs={12} md={6}>
              <MaturityLadder report={report} />
            </Grid>

            <Grid item xs={12}>
              <EvidenceGaps report={report} />
            </Grid>

            <Grid item xs={12}>
              <Button
                size="small"
                variant="outlined"
                onClick={async () => {
                  await api.refresh().catch(() => undefined);
                  await load();
                }}
              >
                Recollect now
              </Button>
              <Typography
                variant="caption"
                color="textSecondary"
                style={{ marginLeft: 12 }}
              >
                Collection runs automatically every 30 minutes.
              </Typography>
            </Grid>
          </Grid>
        )}
      </Content>
    </Page>
  );
}
