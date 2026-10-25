import { useCallback, useEffect, useMemo, useState } from 'react';
import { Content, Header, Link, Page, Progress } from '@backstage/core-components';
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
import Typography from '@material-ui/core/Typography';
import {
  CORE4_AREAS,
  CORE4_AREA_IDS,
  Core4Area,
} from '@internal/engineering-intelligence-core';
import { Core4Response, EngineeringIntelligenceApi } from './api';
import { BAND_COLOUR, band, formatScore, relativeTime } from './present';
import {
  changeLabel,
  cycleStatus,
  formatCore4Value,
  formatKeyMetric,
  teamCell,
} from './core4Present';

// DX Core 4 — the leadership view of the same collection the Engineering
// Intelligence page scores. See docs/engineering-intelligence/core4.md.
//
// Three rules shape what is drawn:
//
// - Four areas side by side, and no overall number. Core 4's whole point is that
//   speed is read next to developer experience, never alone.
// - The key metric is the headline, in its own units. The area score is there
//   for colour and trend, not as the thing to quote.
// - Team rows are withheld below the response floor, and the page says
//   "withheld" rather than leaving a blank someone could read as zero.

const SIGNAL_LABELS = new Map(
  CORE4_AREAS.flatMap(a => a.signals).map(s => [s.metric, s.label]),
);

function AreaCard({
  area,
  change,
  sinceDays,
  counterbalance,
}: {
  area: Core4Area;
  change: Core4Response['change'];
  sinceDays: number | undefined;
  counterbalance?: Core4Area;
}) {
  const colour = BAND_COLOUR[band(area.score)];
  const secondary = area.evidence.filter(e => e.metric !== area.keyMetric);
  const missing = area.missing.filter(m => m.metric !== area.keyMetric);
  return (
    <Paper style={{ padding: 16, height: '100%', borderTop: `4px solid ${colour}` }}>
      <Typography variant="h6">{area.label}</Typography>
      <Typography variant="caption" color="textSecondary" style={{ display: 'block' }}>
        {area.question}
      </Typography>

      <Box marginTop={2}>
        <Typography variant="body2" color="textSecondary">
          {area.keyLabel}
        </Typography>
        <Typography style={{ fontSize: 26, lineHeight: 1.2 }}>
          {formatKeyMetric(area.keyMetric, area.key?.value)}
        </Typography>
        {!area.key && (
          <Typography variant="caption" style={{ color: BAND_COLOUR.unknown }}>
            Not collected — needs{' '}
            {area.missing.find(m => m.metric === area.keyMetric)?.expectedFrom ?? 'a source'}
          </Typography>
        )}
      </Box>

      <Box marginTop={1} display="flex" alignItems="baseline" style={{ gap: 8 }}>
        <Typography style={{ color: colour }}>
          Area score {formatScore(area.score)}
        </Typography>
        <Typography variant="caption" color="textSecondary">
          {changeLabel(change?.areas.find(c => c.area === area.dimension), sinceDays)}
        </Typography>
      </Box>

      {counterbalance && (
        // Throughput is never shown without the experience index beside it.
        <Typography variant="caption" style={{ display: 'block', marginTop: 8 }}>
          Read with: {counterbalance.keyLabel}{' '}
          <strong>{formatKeyMetric(counterbalance.keyMetric, counterbalance.key?.value)}</strong>
        </Typography>
      )}

      {secondary.length > 0 && (
        <Box marginTop={2}>
          {secondary.map(e => (
            <Typography key={e.metric} variant="body2">
              {SIGNAL_LABELS.get(e.metric) ?? e.metric}:{' '}
              <strong>{formatCore4Value(e.metric, e.value)}</strong>
            </Typography>
          ))}
        </Box>
      )}

      {(missing.length > 0 || area.notMeasured.length > 0) && (
        <Box marginTop={2}>
          {missing.map(m => (
            <Typography key={m.metric} variant="caption" color="textSecondary" style={{ display: 'block' }}>
              Not collected: {SIGNAL_LABELS.get(m.metric) ?? m.metric} ({m.expectedFrom})
            </Typography>
          ))}
          {area.notMeasured.map(n => (
            <Typography key={n.label} variant="caption" color="textSecondary" style={{ display: 'block' }}>
              Not measured by the platform: {n.label} — {n.reason}
            </Typography>
          ))}
        </Box>
      )}
    </Paper>
  );
}

function SurveyBanner({ survey }: { survey: Core4Response['survey'] }) {
  return (
    <Paper style={{ padding: 16, borderLeft: `4px solid ${BAND_COLOUR.unknown}` }}>
      {survey ? (
        <Typography variant="body2">
          DevEx survey <strong>{survey.cycle.title}</strong> {cycleStatus(survey.cycle)} ·{' '}
          {survey.responses} response{survey.responses === 1 ? '' : 's'}
          {survey.cycle.open
            ? ' — results appear when it closes'
            : survey.responses < survey.minResponses && ` — too few to report (needs ${survey.minResponses})`}
          {survey.cycle.open && (
            <>
              {' · '}
              <Link to="/devex-survey">Answer the survey</Link>
            </>
          )}
        </Typography>
      ) : (
        <Typography variant="body2">
          No DevEx survey has run yet, so Effectiveness and Impact cannot be scored. The
          platform team opens a cycle at <Link to="/devex-survey">/devex-survey</Link>.
        </Typography>
      )}
    </Paper>
  );
}

function TeamTable({ report }: { report: Core4Response }) {
  if (report.teams.length === 0) {
    return (
      <Typography variant="body2" color="textSecondary">
        No team data yet — needs catalog Groups with members owning services that merge PRs,
        or survey responses.
      </Typography>
    );
  }
  const num = (v: number) => v.toFixed(1);
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  return (
    <Table size="small">
      <TableHead>
        <TableRow>
          <TableCell>Team</TableCell>
          <TableCell align="right">Engineers</TableCell>
          <TableCell align="right">PRs / engineer / week</TableCell>
          <TableCell align="right">Survey responses</TableCell>
          <TableCell align="right">Experience index</TableCell>
          <TableCell align="right">Time on new capabilities</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {report.teams.map(t => (
          <TableRow key={t.team}>
            <TableCell>{t.team}</TableCell>
            <TableCell align="right">{t.engineers ?? '—'}</TableCell>
            <TableCell align="right">
              {teamCell(t.diffsPerEngineerWeekly, num, t.withheld && t.engineers !== null)}
            </TableCell>
            <TableCell align="right">{t.responses}</TableCell>
            <TableCell align="right">
              {teamCell(t.dxi, v => String(Math.round(v)), t.withheld && t.responses > 0)}
            </TableCell>
            <TableCell align="right">
              {teamCell(t.newCapabilitiesRatio, pct, t.withheld && t.responses > 0)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function Core4Page() {
  const fetchApi = useApi(fetchApiRef);
  const configApi = useApi(configApiRef);
  const baseUrl = configApi.getString('backend.baseUrl');
  const api = useMemo(() => new EngineeringIntelligenceApi(fetchApi, baseUrl), [fetchApi, baseUrl]);

  const [report, setReport] = useState<Core4Response | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setReport(await api.core4());
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <Page themeId="tool">
      <Header
        title="DX Core 4"
        subtitle="Speed, Effectiveness, Quality and Impact — system metrics and the DevEx survey, read together"
      />
      <Content>
        {loading && <Progress />}

        {!loading && error && (
          // No demo mode, for the reason the Engineering Intelligence page has none.
          <Paper style={{ padding: 16, borderLeft: `4px solid ${BAND_COLOUR.weak}` }}>
            <Typography>Could not load the Core 4 report.</Typography>
            <Typography variant="body2" color="textSecondary">
              {error}
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
              <Paper style={{ padding: 12, borderLeft: `4px solid ${BAND_COLOUR.fair}` }}>
                <Typography variant="body2">
                  <strong>{report.guardrail}</strong>
                </Typography>
              </Paper>
            </Grid>
            <Grid item xs={12}>
              <SurveyBanner survey={report.survey} />
            </Grid>

            {CORE4_AREA_IDS.map(id => (
              <Grid item xs={12} sm={6} md={3} key={id}>
                <AreaCard
                  area={report.areas[id]}
                  change={report.change}
                  sinceDays={report.change?.sinceDays}
                  counterbalance={id === 'speed' ? report.areas.effectiveness : undefined}
                />
              </Grid>
            ))}

            <Grid item xs={12}>
              <Paper style={{ padding: 16 }}>
                <Typography variant="h6">By team</Typography>
                <Typography variant="caption" color="textSecondary" style={{ display: 'block', marginBottom: 8 }}>
                  Figures for groups under {report.minCohort} engineers or survey responses are withheld.
                </Typography>
                <TeamTable report={report} />
              </Paper>
            </Grid>

            <Grid item xs={12}>
              <Typography variant="caption" color="textSecondary">
                Collected {relativeTime(report.generatedAt)}. Detail behind each system metric is on the{' '}
                <Link to="/engineering-intelligence">Engineering Intelligence</Link> page.
              </Typography>
            </Grid>
          </Grid>
        )}
      </Content>
    </Page>
  );
}
