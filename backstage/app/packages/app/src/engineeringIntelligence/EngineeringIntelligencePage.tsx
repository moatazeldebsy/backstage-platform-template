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
import { EngineeringIntelligenceApi, HealthResponse } from './api';
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

function Card({ children, ...rest }: { children: React.ReactNode; [k: string]: any }) {
  return (
    <Paper {...rest} style={{ padding: 16, height: '100%', ...(rest.style ?? {}) }}>
      {children}
    </Paper>
  );
}

function SectionTitle({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <Box display="flex" alignItems="baseline" style={{ gap: 8, marginBottom: 8 }}>
      <Typography variant="h6">{children}</Typography>
      {hint && (
        <Typography variant="caption" color="textSecondary">
          {hint}
        </Typography>
      )}
    </Box>
  );
}

function Headline({
  report,
  snapshots,
}: {
  report: HealthResponse;
  snapshots: SnapshotRow[];
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
          <Typography variant="body1">{maturityHeadline(report.maturity)}</Typography>
          <Typography variant="body2" color="textSecondary" style={{ marginTop: 4 }}>
            {/* trendLabel distinguishes three cases the reader cares about:
                no history at all, two collections that agree, and a real move. */}
            {trendLabel(movement)} · collected {relativeTime(report.generatedAt)}
          </Typography>
          {report.status !== 'ok' && (
            <Typography variant="body2" style={{ color: BAND_COLOUR.unknown, marginTop: 4 }}>
              Scored from {
                Object.values(report.dimensions).filter(d => d.score !== null).length
              } of {Object.keys(report.dimensions).length} dimensions. Unscored
              dimensions are excluded from the total rather than counted as zero.
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
        <Typography variant="caption" style={{ display: 'block', marginTop: 6 }}>
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
                <TableCell align="right">{Math.round(row.normalised)}</TableCell>
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
            {dimension.missing.map(m => `${m.metric} (${m.expectedFrom})`).join(' · ')}
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
              <Typography style={{ color: colour, fontWeight: row.current ? 700 : 400 }}>
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
      <SectionTitle hint="derived from measured evidence only">Top risks</SectionTitle>
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
            <Typography variant="caption" color="textSecondary" style={{ display: 'block' }}>
              {risk.action}
            </Typography>
            {risk.evidence[0] && (
              <Typography variant="caption" style={{ display: 'block', opacity: 0.75 }}>
                {risk.evidence[0].metric} ={' '}
                {formatMetricValue(risk.evidence[0].metric, risk.evidence[0].value)} ·{' '}
                {risk.evidence[0].source}
              </Typography>
            )}
          </Box>
        ))
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
              <Headline report={report} snapshots={snapshots} />
            </Grid>

            {dimensions.map(dimension => (
              <Grid item xs={12} sm={6} md={3} key={dimension.dimension}>
                <DimensionCard
                  dimension={dimension}
                  selected={selected === dimension.dimension}
                  onSelect={() =>
                    setSelected(
                      selected === dimension.dimension ? undefined : dimension.dimension,
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
