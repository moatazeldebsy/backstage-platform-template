import { useCallback, useEffect, useMemo, useState } from 'react';
import { Content, Header, Link, Page, Progress } from '@backstage/core-components';
import { configApiRef, fetchApiRef, useApi } from '@backstage/core-plugin-api';
import Box from '@material-ui/core/Box';
import Button from '@material-ui/core/Button';
import FormControlLabel from '@material-ui/core/FormControlLabel';
import MenuItem from '@material-ui/core/MenuItem';
import Paper from '@material-ui/core/Paper';
import Radio from '@material-ui/core/Radio';
import RadioGroup from '@material-ui/core/RadioGroup';
import TextField from '@material-ui/core/TextField';
import Typography from '@material-ui/core/Typography';
import {
  DRIVERS,
  PERCEPTIONS,
  Statement,
  TIME_BUCKETS,
} from '@internal/engineering-intelligence-core';
import { CurrentSurvey, DevexSurveyApi } from './api';
import { LIKERT_LABELS, SurveyForm, emptyForm, timeTotal, toAnswers } from './present';

// The DevEx survey — the self-reported half of DX Core 4.
//
// About five minutes: seventeen agree/disagree statements and one time split.
// Answers are stored without the respondent's identity and only ever shown as
// team or organisation averages above a minimum group size.

function Likert({
  statement,
  value,
  onChange,
}: {
  statement: Statement<string>;
  value: number | undefined;
  onChange: (v: number) => void;
}) {
  return (
    <Box marginBottom={2}>
      <Typography variant="body1">{statement.text}</Typography>
      <RadioGroup
        row
        value={value === undefined ? '' : String(value)}
        onChange={e => onChange(Number(e.target.value))}
      >
        {LIKERT_LABELS.map((label, i) => (
          <FormControlLabel
            key={label}
            value={String(i + 1)}
            control={<Radio size="small" />}
            label={<Typography variant="caption">{label}</Typography>}
          />
        ))}
      </RadioGroup>
    </Box>
  );
}

function OpenCycle({ api, onOpened }: { api: DevexSurveyApi; onOpened: () => void }) {
  const [title, setTitle] = useState('');
  const [days, setDays] = useState(14);
  const [error, setError] = useState<string | undefined>();
  return (
    <Paper style={{ padding: 16, marginTop: 16 }}>
      <Typography variant="h6">Open a survey cycle</Typography>
      <Typography variant="body2" color="textSecondary">
        Platform team only. Run one a quarter; the first one is the baseline.
      </Typography>
      <Box display="flex" style={{ gap: 12 }} marginTop={2} alignItems="center">
        <TextField label="Title" placeholder="Q4 2026" value={title} onChange={e => setTitle(e.target.value)} />
        <TextField
          label="Days open"
          type="number"
          value={days}
          onChange={e => setDays(Number(e.target.value))}
          style={{ width: 100 }}
        />
        <Button
          variant="contained"
          color="primary"
          disabled={!title.trim()}
          onClick={() => api.openCycle(title.trim(), days).then(onOpened, e => setError(String(e.message)))}
        >
          Open
        </Button>
      </Box>
      {error && <Typography color="error">{error}</Typography>}
    </Paper>
  );
}

export function DevexSurveyPage() {
  const fetchApi = useApi(fetchApiRef);
  const configApi = useApi(configApiRef);
  const baseUrl = configApi.getString('backend.baseUrl');
  const api = useMemo(() => new DevexSurveyApi(fetchApi, baseUrl), [fetchApi, baseUrl]);

  const [current, setCurrent] = useState<CurrentSurvey | undefined>();
  const [form, setForm] = useState<SurveyForm>(emptyForm);
  const [team, setTeam] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const c = await api.current();
      setCurrent(c);
      setTeam(c.teams[0] ?? '');
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  const result = toAnswers(form);
  const setLikert = (id: string, v: number) =>
    setForm(f => ({ ...f, likert: { ...f.likert, [id]: v } }));

  const submit = async () => {
    if (!current?.cycle || 'error' in result) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await api.submit(current.cycle.id, team, result.answers);
      await load();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Page themeId="tool">
      <Header
        title="DevEx Survey"
        subtitle="About five minutes. Anonymous, and only ever reported as team averages."
      />
      <Content>
        {loading && <Progress />}
        {!loading && error && !current && <Typography color="error">{error}</Typography>}

        {!loading && current && !current.cycle && (
          <Paper style={{ padding: 16 }}>
            <Typography>No survey is open right now.</Typography>
            <Typography variant="body2" color="textSecondary">
              Results from the last cycle are on the <Link to="/core4">DX Core 4</Link> page.
            </Typography>
          </Paper>
        )}

        {!loading && current?.cycle && current.answered && (
          <Paper style={{ padding: 16 }}>
            <Typography>Thanks — your answers for {current.cycle.title} are in.</Typography>
            <Typography variant="body2" color="textSecondary">
              Results appear on the <Link to="/core4">DX Core 4</Link> page when this cycle closes, for
              teams where at least {current.minResponses} people answered.
            </Typography>
          </Paper>
        )}

        {!loading && current?.cycle && !current.answered && (
          <Paper style={{ padding: 16 }}>
            <Typography variant="h6">{current.cycle.title}</Typography>
            <Typography variant="body2" color="textSecondary" paragraph>
              Your name is not stored with your answers, and nothing is shown for a group smaller than{' '}
              {current.minResponses}. Answer for the last three months.
            </Typography>

            {current.teams.length > 1 && (
              <TextField
                select
                label="Answer as a member of"
                value={team}
                onChange={e => setTeam(e.target.value)}
                style={{ minWidth: 240, marginBottom: 16 }}
              >
                {current.teams.map(t => (
                  <MenuItem key={t} value={t}>
                    {t}
                  </MenuItem>
                ))}
              </TextField>
            )}

            <Typography variant="subtitle1" gutterBottom>
              Your day-to-day work
            </Typography>
            {DRIVERS.map(d => (
              <Likert key={d.id} statement={d} value={form.likert[d.id]} onChange={v => setLikert(d.id, v)} />
            ))}

            <Typography variant="subtitle1" gutterBottom>
              Overall
            </Typography>
            {PERCEPTIONS.map(p => (
              <Likert key={p.id} statement={p} value={form.likert[p.id]} onChange={v => setLikert(p.id, v)} />
            ))}

            <Typography variant="subtitle1" gutterBottom>
              Roughly how did your time split over the last three months? (must add up to 100%)
            </Typography>
            {TIME_BUCKETS.map(b => (
              <Box key={b.id} display="flex" alignItems="center" style={{ gap: 12 }} marginBottom={1}>
                <TextField
                  type="number"
                  inputProps={{ min: 0, max: 100, step: 5 }}
                  value={form.time[b.id]}
                  onChange={e =>
                    setForm(f => ({ ...f, time: { ...f.time, [b.id]: Math.trunc(Number(e.target.value) || 0) } }))
                  }
                  style={{ width: 80 }}
                />
                <Typography variant="body2">% {b.label}</Typography>
              </Box>
            ))}
            <Typography variant="body2" color={timeTotal(form) === 100 ? 'textSecondary' : 'error'}>
              Total: {timeTotal(form)}%
            </Typography>

            <Box marginTop={2} display="flex" alignItems="center" style={{ gap: 12 }}>
              <Button variant="contained" color="primary" disabled={'error' in result || submitting} onClick={submit}>
                Submit
              </Button>
              <Typography variant="caption" color="textSecondary">
                {'error' in result ? result.error : 'Ready to submit'}
              </Typography>
            </Box>
            {error && <Typography color="error">{error}</Typography>}
          </Paper>
        )}

        {!loading && current?.isAdmin && !current.cycle && <OpenCycle api={api} onOpened={load} />}
        {!loading && current?.isAdmin && current.cycle && (
          <Box marginTop={2}>
            <Button
              size="small"
              variant="outlined"
              onClick={() => api.closeCycle(current.cycle!.id).then(load, e => setError(String(e.message)))}
            >
              Close this cycle now
            </Button>
          </Box>
        )}
      </Content>
    </Page>
  );
}
