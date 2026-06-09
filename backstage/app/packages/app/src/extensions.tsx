import { useEffect, useMemo, useRef, useState } from 'react';
import { createFrontendPlugin, PageBlueprint, NavItemBlueprint, createRouteRef } from '@backstage/frontend-plugin-api';
import { EntityContentBlueprint } from '@backstage/plugin-catalog-react/alpha';
import { useEntity } from '@backstage/plugin-catalog-react';
import type { Entity } from '@backstage/catalog-model';
import { useApi, fetchApiRef, configApiRef, identityApiRef } from '@backstage/core-plugin-api';
import {
  Content,
  Header,
  Page,
  Progress,
} from '@backstage/core-components';
import CheckCircleIcon from '@material-ui/icons/CheckCircle';
import CancelIcon from '@material-ui/icons/Cancel';
import EmojiEventsIcon from '@material-ui/icons/EmojiEvents';
import MuiTable from '@material-ui/core/Table';
import TableBody from '@material-ui/core/TableBody';
import TableCell from '@material-ui/core/TableCell';
import TableContainer from '@material-ui/core/TableContainer';
import TableHead from '@material-ui/core/TableHead';
import TableRow from '@material-ui/core/TableRow';
import Box from '@material-ui/core/Box';
import Button from '@material-ui/core/Button';
import CircularProgress from '@material-ui/core/CircularProgress';
import IconButton from '@material-ui/core/IconButton';
import InputAdornment from '@material-ui/core/InputAdornment';
import Paper from '@material-ui/core/Paper';
import TextField from '@material-ui/core/TextField';
import Tooltip from '@material-ui/core/Tooltip';
import Typography from '@material-ui/core/Typography';
import AttachMoneyIcon from '@material-ui/icons/AttachMoney';
import ChatIcon from '@material-ui/icons/Chat';
import AddCommentIcon from '@material-ui/icons/AddComment';
import SendIcon from '@material-ui/icons/Send';
import SearchIcon from '@material-ui/icons/Search';
import Chip from '@material-ui/core/Chip';
import LinearProgress from '@material-ui/core/LinearProgress';
import Link from '@material-ui/core/Link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// ── FinOps / Cost Overview page ───────────────────────────────────────────────
// Queries OpenCost via the Backstage proxy (/api/proxy/opencost).
// Shows stacked bar chart + detailed cost table with date-range / breakdown controls.

const COST_COLORS = ['#1976d2','#388e3c','#f57c00','#7b1fa2','#c62828','#00838f','#558b2f','#6d4c41','#455a64','#e91e63'];

function StackedBar({ segments }: { segments: { value: number; color: string }[] }) {
  const total = segments.reduce((s, seg) => s + seg.value, 0);
  if (total === 0) return <div style={{ height: 28, background: '#eee', borderRadius: 4 }} />;
  return (
    <div style={{ display: 'flex', height: 28, borderRadius: 4, overflow: 'hidden', gap: 1 }}>
      {segments.map((seg, i) =>
        seg.value > 0 ? (
          <div key={i} style={{ flex: seg.value, background: seg.color }} title={`$${seg.value.toFixed(4)}`} />
        ) : null
      )}
    </div>
  );
}

function FinOpsPage() {
  const fetchApi  = useApi(fetchApiRef);
  const configApi = useApi(configApiRef);
  const base = configApi.getString('backend.baseUrl');

  const [window_, setWindow]   = useState('7d');
  const [aggregate, setAgg]    = useState('namespace');
  const [rows, setRows]        = useState<any[]>([]);
  const [dailyBuckets, setDailyBuckets] = useState<{ label: string; items: Record<string, number> }[]>([]);
  const [loading, setLoading]  = useState(true);
  const [error, setError]      = useState<string | null>(null);

  useEffect(() => {
    setLoading(true); setError(null);
    const steps = window_ === '1d' ? 24 : window_ === '7d' ? 7 : 30;
    const step  = window_ === '1d' ? '1h' : '1d';
    Promise.all([
      fetchApi.fetch(`${base}/api/proxy/opencost/allocation/compute?window=${window_}&aggregate=${aggregate}&accumulate=true`),
      fetchApi.fetch(`${base}/api/proxy/opencost/allocation/compute?window=${window_}&aggregate=${aggregate}&accumulate=false&step=${step}`),
    ])
      .then(([r1, r2]) => Promise.all([r1.ok ? r1.json() : Promise.reject(r1.status), r2.ok ? r2.json() : Promise.resolve({ data: [] })]))
      .then(([total, daily]: [any, any]) => {
        const alloc: Record<string, any> = total?.data?.[0] ?? {};
        const sorted = Object.entries(alloc)
          .map(([name, info]: [string, any]) => ({ name, total: info.totalCost ?? 0, cpu: info.cpuCost ?? 0, ram: info.ramCost ?? 0, pv: info.pvCost ?? 0, efficiency: info.totalEfficiency ?? 0 }))
          .sort((a, b) => b.total - a.total);
        setRows(sorted);
        const buckets = (daily?.data ?? []).map((bucket: any, i: number) => {
          const d = new Date(); d.setDate(d.getDate() - (steps - 1 - i));
          const label = window_ === '1d' ? `${i}:00` : `${d.getMonth()+1}/${d.getDate()}`;
          const items: Record<string, number> = {};
          Object.entries(bucket ?? {}).forEach(([k, v]: [string, any]) => { items[k] = v.totalCost ?? 0; });
          return { label, items };
        });
        setDailyBuckets(buckets);
        setLoading(false);
      })
      .catch((err: any) => { setError(String(err)); setLoading(false); });
  }, [base, fetchApi, window_, aggregate]);

  const names = rows.map(r => r.name);
  const grandTotal = rows.reduce((s, r) => s + r.total, 0);
  const maxBucketTotal = Math.max(...dailyBuckets.map(b => Object.values(b.items).reduce((s, v) => s + v, 0)), 0.0001);

  const DEMO_ROWS = [
    { name: 'monitoring', total: 0.42, cpu: 0.28, ram: 0.10, pv: 0.04, efficiency: 31 },
    { name: 'services-dev', total: 0.31, cpu: 0.18, ram: 0.09, pv: 0.04, efficiency: 42 },
    { name: 'argocd', total: 0.18, cpu: 0.11, ram: 0.05, pv: 0.02, efficiency: 38 },
    { name: 'kagent', total: 0.12, cpu: 0.07, ram: 0.04, pv: 0.01, efficiency: 55 },
    { name: 'ml-platform', total: 0.09, cpu: 0.05, ram: 0.03, pv: 0.01, efficiency: 48 },
    { name: 'kube-system', total: 0.07, cpu: 0.04, ram: 0.02, pv: 0.01, efficiency: 61 },
    { name: 'ingress-nginx', total: 0.04, cpu: 0.02, ram: 0.01, pv: 0.01, efficiency: 70 },
    { name: 'backstage', total: 0.03, cpu: 0.02, ram: 0.01, pv: 0.00, efficiency: 44 },
  ];
  const isDemo = !loading && (error || rows.length === 0);
  const displayRows = isDemo ? DEMO_ROWS : rows;
  const displayTotal = isDemo ? DEMO_ROWS.reduce((s, r) => s + r.total, 0) : grandTotal;

  return (
    <Page themeId="tool">
      <Header title="FinOps — Cost Overview" subtitle="Kubernetes spend · powered by OpenCost" />
      <Content>
        {loading && <Progress />}
        {isDemo && (
          <Paper style={{ padding: '8px 16px', marginBottom: 16, background: '#fff8e1', border: '1px solid #ffe082' }}>
            <Typography variant="body2" style={{ color: '#7c6000' }}>
              📊 <strong>Demo data</strong> — OpenCost unavailable. Deploy with <code>bootstrap-local.sh</code> to see live spend.
            </Typography>
          </Paper>
        )}
        {!loading && (
          <>
            {/* Controls */}
            <Box display="flex" style={{ gap: 16, marginBottom: 20, alignItems: 'center', flexWrap: 'wrap' }}>
              <Box>
                <Typography variant="caption" style={{ display: 'block', marginBottom: 4, fontWeight: 600 }}>Date Range</Typography>
                <Box display="flex" style={{ gap: 4 }}>
                  {[['1d','Last 24h'],['7d','Last Week'],['30d','Last Month']].map(([v, l]) => (
                    <button key={v} onClick={() => setWindow(v)} style={{ padding: '4px 12px', borderRadius: 16, border: '1px solid', cursor: 'pointer', fontWeight: v === window_ ? 700 : 400, background: v === window_ ? '#1976d2' : '#fff', color: v === window_ ? '#fff' : '#333', borderColor: v === window_ ? '#1976d2' : '#ddd' }}>{l}</button>
                  ))}
                </Box>
              </Box>
              <Box>
                <Typography variant="caption" style={{ display: 'block', marginBottom: 4, fontWeight: 600 }}>Breakdown</Typography>
                <Box display="flex" style={{ gap: 4 }}>
                  {[['namespace','Namespace'],['label:team','Team'],['container','Container']].map(([v, l]) => (
                    <button key={v} onClick={() => setAgg(v)} style={{ padding: '4px 12px', borderRadius: 16, border: '1px solid', cursor: 'pointer', fontWeight: v === aggregate ? 700 : 400, background: v === aggregate ? '#1976d2' : '#fff', color: v === aggregate ? '#fff' : '#333', borderColor: v === aggregate ? '#1976d2' : '#ddd' }}>{l}</button>
                  ))}
                </Box>
              </Box>
              <Paper style={{ padding: '8px 20px', marginLeft: 'auto', textAlign: 'center' }}>
                <Typography variant="h5" style={{ fontWeight: 700, color: '#1976d2' }}>${displayTotal.toFixed(2)}</Typography>
                <Typography variant="caption" color="textSecondary">Total Cost (USD)</Typography>
              </Paper>
            </Box>

            {/* Stacked bar chart */}
            {(dailyBuckets.length > 0 || isDemo) && (
              <Paper style={{ padding: 16, marginBottom: 20 }}>
                <Typography variant="h6" gutterBottom>Spend Over Time by {aggregate === 'namespace' ? 'Namespace' : aggregate === 'label:team' ? 'Team' : 'Container'}</Typography>
                <Box style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 160, overflowX: 'auto', paddingBottom: 24, position: 'relative' }}>
                  {(isDemo
                    ? Array.from({ length: 7 }, (_, i) => {
                        const d = new Date(); d.setDate(d.getDate() - (6 - i));
                        return { label: `${d.getMonth()+1}/${d.getDate()}`, items: Object.fromEntries(DEMO_ROWS.map(r => [r.name, r.total / 7 * (0.8 + Math.random() * 0.4)])) };
                      })
                    : dailyBuckets
                  ).map((bucket, bi) => {
                    const bucketTotal = Object.values(bucket.items).reduce((s: number, v: any) => s + v, 0);
                    const barH = 120;
                    return (
                      <Box key={bi} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 32 }}>
                        <Box style={{ width: '100%', height: barH, display: 'flex', flexDirection: 'column-reverse', borderRadius: '4px 4px 0 0', overflow: 'hidden' }}>
                          {displayRows.map((row, ri) => {
                            const val = bucket.items[row.name] ?? 0;
                            const h = bucketTotal > 0 ? (val / (isDemo ? bucketTotal : maxBucketTotal)) * barH : 0;
                            return h > 0 ? <div key={ri} style={{ width: '100%', height: h, background: COST_COLORS[ri % COST_COLORS.length] }} title={`${row.name}: $${val.toFixed(4)}`} /> : null;
                          })}
                        </Box>
                        <Typography variant="caption" style={{ fontSize: 9, marginTop: 2 }}>{bucket.label}</Typography>
                      </Box>
                    );
                  })}
                </Box>
                {/* Legend */}
                <Box display="flex" style={{ flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                  {displayRows.slice(0, 8).map((row, i) => (
                    <Box key={i} display="flex" alignItems="center" style={{ gap: 4 }}>
                      <div style={{ width: 10, height: 10, borderRadius: 2, background: COST_COLORS[i % COST_COLORS.length] }} />
                      <Typography variant="caption">{row.name}</Typography>
                    </Box>
                  ))}
                </Box>
              </Paper>
            )}

            {/* Cost table */}
            <Paper>
              <TableContainer>
                <MuiTable size="small">
                  <TableHead>
                    <TableRow style={{ background: '#f5f5f5' }}>
                      <TableCell><strong>Name</strong></TableCell>
                      <TableCell><strong>Cost breakdown</strong></TableCell>
                      <TableCell align="right"><strong>CPU</strong></TableCell>
                      <TableCell align="right"><strong>RAM</strong></TableCell>
                      <TableCell align="right"><strong>PV</strong></TableCell>
                      <TableCell align="right"><strong>Efficiency</strong></TableCell>
                      <TableCell align="right"><strong>Total Cost</strong></TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {displayRows.map((row, i) => (
                      <TableRow key={row.name} hover>
                        <TableCell style={{ fontWeight: 500 }}>
                          <Box display="flex" alignItems="center" style={{ gap: 6 }}>
                            <div style={{ width: 10, height: 10, borderRadius: 2, background: COST_COLORS[i % COST_COLORS.length], flexShrink: 0 }} />
                            {row.name}
                          </Box>
                        </TableCell>
                        <TableCell style={{ minWidth: 140 }}>
                          <StackedBar segments={[
                            { value: row.cpu, color: '#1976d2' },
                            { value: row.ram, color: '#388e3c' },
                            { value: row.pv,  color: '#f57c00' },
                          ]} />
                        </TableCell>
                        <TableCell align="right">${row.cpu.toFixed(3)}</TableCell>
                        <TableCell align="right">${row.ram.toFixed(3)}</TableCell>
                        <TableCell align="right">${row.pv.toFixed(3)}</TableCell>
                        <TableCell align="right">
                          <span style={{ color: row.efficiency > 50 ? '#388e3c' : row.efficiency > 25 ? '#f57c00' : '#c62828', fontWeight: 600 }}>
                            {typeof row.efficiency === 'number' ? `${(row.efficiency * (row.efficiency <= 1 ? 100 : 1)).toFixed(0)}%` : '—'}
                          </span>
                        </TableCell>
                        <TableCell align="right"><strong>${row.total.toFixed(3)}</strong></TableCell>
                      </TableRow>
                    ))}
                    <TableRow style={{ background: '#f5f5f5' }}>
                      <TableCell colSpan={2}><strong>Totals</strong></TableCell>
                      <TableCell align="right"><strong>${displayRows.reduce((s,r)=>s+r.cpu,0).toFixed(3)}</strong></TableCell>
                      <TableCell align="right"><strong>${displayRows.reduce((s,r)=>s+r.ram,0).toFixed(3)}</strong></TableCell>
                      <TableCell align="right"><strong>${displayRows.reduce((s,r)=>s+r.pv,0).toFixed(3)}</strong></TableCell>
                      <TableCell align="right" />
                      <TableCell align="right"><strong>${displayTotal.toFixed(3)}</strong></TableCell>
                    </TableRow>
                  </TableBody>
                </MuiTable>
              </TableContainer>
            </Paper>
          </>
        )}
      </Content>
    </Page>
  );
}

const finOpsRouteRef = createRouteRef();

const finOpsPage = PageBlueprint.make({
  name: 'finops',
  params: {
    path: '/finops',
    routeRef: finOpsRouteRef,
    loader: async () => <FinOpsPage />,
  },
});

const finOpsNavItem = NavItemBlueprint.make({
  name: 'finops',
  params: {
    title: 'Cost Overview',
    icon: AttachMoneyIcon as any,
    routeRef: finOpsRouteRef,
  },
});

function uuidv4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ── AI Assistant page ─────────────────────────────────────────────────────────
// Native chat UI that talks to the idp-assistant KAgent agent via the Backstage
// proxy (/api/proxy/kagent → kagent-ui:8080).
//
// Flow per user turn:
//   1. POST /a2a/kagent/idp-assistant  (KAgent Next.js route adds auth headers)
//   2. Poll GET /api/sessions           every 500 ms for up to 12 s — find session
//   3. Poll GET /api/sessions/<id>      every 1 s for up to 90 s — wait for text

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
}

function AiAssistantPage() {
  const fetchApi = useApi(fetchApiRef);
  const configApi = useApi(configApiRef);
  const identityApi = useApi(identityApiRef);
  const [userRef, setUserRef] = useState<string>('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [statusText, setStatusText] = useState('');
  // contextId persists the KAgent session across turns so the agent keeps history
  const contextIdRef = useRef<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Load user identity once, then restore their stored session from localStorage
  useEffect(() => {
    identityApi.getBackstageIdentity().then(identity => {
      const ref = identity.userEntityRef;
      setUserRef(ref);
      const storedContextId = localStorage.getItem(`ai-chat-ctx:${ref}`);
      const storedMessages = localStorage.getItem(`ai-chat-msgs:${ref}`);
      if (storedContextId) contextIdRef.current = storedContextId;
      if (storedMessages) {
        try { setMessages(JSON.parse(storedMessages)); } catch { /* ignore */ }
      }
    });
  }, [identityApi]);

  // Persist messages to localStorage whenever they change (per user)
  useEffect(() => {
    if (!userRef) return;
    localStorage.setItem(`ai-chat-msgs:${userRef}`, JSON.stringify(messages));
  }, [messages, userRef]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput('');
    setMessages(prev => [...prev, { role: 'user', text }]);
    setLoading(true);
    setStatusText('Sending…');

    const base = configApi.getString('backend.baseUrl');
    const proxyBase = `${base}/api/proxy/kagent`;

    try {
      // Include contextId to continue the same session (agent keeps full history).
      const message: any = {
        messageId: uuidv4(),
        role: 'user',
        parts: [{ kind: 'text', text }],
      };
      if (contextIdRef.current) message.contextId = contextIdRef.current;

      // X-Backstage-User is set from the authenticated identity and forwarded
      // by KAgent to outgoing MCP calls — the LLM cannot influence it.
      // This is the out-of-band identity binding for user memory (IDOR prevention).
      const identityHeaders: Record<string, string> = userRef
        ? { 'X-Backstage-User': userRef }
        : {};

      const a2aRes = await fetchApi.fetch(`${proxyBase}/a2a/kagent/platform-assistant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...identityHeaders },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'message/send',
          params: { message },
          id: 1,
        }),
      });

      if (!a2aRes.ok) {
        throw new Error(`KAgent request failed: ${a2aRes.status}`);
      }

      // a2a endpoint returns event stream, contextId usually comes from session polling
      let sessionId: string | null = contextIdRef.current;
      try {
        // Try to parse as JSON in case it's a direct response
        const a2aBody = await a2aRes.json();
        if (a2aBody.result?.contextId) sessionId = a2aBody.result.contextId;
      } catch {
        // Event stream response is expected; we'll find the session via polling
      }

      // If we don't have a sessionId yet, poll the sessions list with
      // exponential backoff + jitter (200ms → 2s, total deadline ~45s) so
      // concurrent chat sessions don't fan out a constant 2 req/s per user.
      // 45s deadline accounts for Claude API cold start on local Kind (~8–15s).
      if (!sessionId) {
        setStatusText('Connecting to agent — this may take a few seconds on local…');
        const sentAt = Date.now();
        const sessionDeadline = Date.now() + 45_000;
        let sAttempt = 0;
        let lastError = '';
        while (!sessionId && Date.now() < sessionDeadline) {
          const base = Math.min(2000, 200 * Math.pow(2, sAttempt));
          const jitter = base * (0.8 + Math.random() * 0.4);
          await new Promise(r => setTimeout(r, jitter));
          sAttempt++;
          try {
            const res = await fetchApi.fetch(`${proxyBase}/api/sessions`);
            // 308 is a redirect; skip this attempt and retry
            if (res.status === 308) {
              continue;
            }
            if (!res.ok) {
              lastError = `Sessions endpoint returned ${res.status}`;
              continue;
            }
            const body = await res.json();
            const sessions: any[] = body.data ?? [];
            // Find the most recent matching session (they're usually sorted newest first)
            // Look for idp-assistant agent, created within a wide time window
            for (const s of sessions) {
              if (s.agent_id === 'kagent__NS__platform_assistant') {
                const sessionTime = new Date(s.created_at).getTime();
                // Accept sessions created from 5 seconds before to 30 seconds after send time
                // This accounts for clock skew and agent startup time
                if (sessionTime >= sentAt - 5000 && sessionTime <= Date.now() + 5000) {
                  sessionId = s.id;
                  break;
                }
              }
            }
          } catch (e) {
            lastError = String(e);
          }
        }
        if (!sessionId) {
          throw new Error(`No session created after waiting. ${lastError}`);
        }
      }
      contextIdRef.current = sessionId;
      if (userRef) localStorage.setItem(`ai-chat-ctx:${userRef}`, sessionId);

      // Poll for agent response with exponential backoff + jitter (500ms → 3s,
      // total deadline ~5 min). Scaffold can take up to 3 min (list_templates +
      // get_template_params + scaffold_service). Backoff replaces the previous
      // fixed-500ms cadence that hit the proxy at 2 req/s × all active users.
      setStatusText('Agent is thinking… (local Claude API may take 10–20s)');
      let agentReply: string | null = null;
      const replyDeadline = Date.now() + 300_000; // 5 min
      const replyStart = Date.now();
      let rAttempt = 0;
      while (!agentReply && Date.now() < replyDeadline) {
        const base = Math.min(3000, 500 * Math.pow(2, rAttempt));
        const jitter = base * (0.8 + Math.random() * 0.4);
        await new Promise(r => setTimeout(r, jitter));
        rAttempt++;
        const elapsed = Math.round((Date.now() - replyStart) / 1000);
        if (elapsed > 5 && !agentReply)
          setStatusText(`Agent is thinking… (${elapsed}s elapsed)`);
        const res = await fetchApi.fetch(`${proxyBase}/api/sessions/${sessionId}`);
        if (!res.ok) continue;
        const body = await res.json();
        const events: any[] = body.data?.events ?? [];

        const parsed = events.map((e: any) => {
          try { return JSON.parse(e.data); } catch { return null; }
        }).filter(Boolean);

        const agentEvents = parsed.filter(
          (d: any) => d?.author === 'idp_assistant' && d?.content?.parts,
        );

        if (agentEvents.length === 0) continue;

        // [0] is the newest agent event (events are newest-first)
        const newest = agentEvents[0];
        const parts: any[] = newest.content.parts;
        const activeTool = parts.find((p: any) => p.function_call)?.function_call?.name;
        const textParts = parts.filter((p: any) => p.text);

        if (activeTool) {
          // Show which tool is running so the user knows it's working
          const labels: Record<string, string> = {
            list_templates: 'Fetching available templates…',
            get_template_params: 'Reading template parameters…',
            scaffold_service: 'Scaffolding service — this may take a minute…',
            list_deployments: 'Listing deployments…',
            catalog_search: 'Searching catalog…',
            get_service_metrics: 'Fetching metrics…',
          };
          setStatusText(labels[activeTool] ?? `Running ${activeTool}…`);
        } else if (textParts.length > 0) {
          agentReply = textParts.map((p: any) => p.text).join('');
        }
      }

      if (!agentReply) throw new Error('Agent did not respond in time');
      setMessages(prev => [...prev, { role: 'assistant', text: agentReply! }]);
    } catch (err: any) {
      setMessages(prev => [
        ...prev,
        { role: 'assistant', text: `⚠️ ${err.message}` },
      ]);
    } finally {
      setLoading(false);
      setStatusText('');
    }
  };

  const newChat = () => {
    if (loading) return;
    setMessages([]);
    setInput('');
    setStatusText('');
    contextIdRef.current = null;
    if (userRef) {
      localStorage.removeItem(`ai-chat-ctx:${userRef}`);
      localStorage.removeItem(`ai-chat-msgs:${userRef}`);
    }
  };

  return (
    <Page themeId="tool">
      <Header title="AI Assistant" subtitle="Powered by KAgent · platform-assistant" />
      <Content>
        <Box display="flex" flexDirection="column" height="calc(100vh - 180px)">
          {/* Toolbar */}
          <Box display="flex" justifyContent="flex-end" mb={1}>
            <Tooltip title="Start a new conversation">
              <span>
                <Button
                  variant="outlined"
                  size="small"
                  startIcon={<AddCommentIcon />}
                  onClick={newChat}
                  disabled={loading || messages.length === 0}
                >
                  New Chat
                </Button>
              </span>
            </Tooltip>
          </Box>

          {/* Quick-action chips — only shown on an empty chat */}
          {messages.length === 0 && !loading && (
            <Box mb={2}>
              <Typography variant="caption" color="textSecondary" display="block" gutterBottom style={{ fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase' }}>
                Suggested
              </Typography>
              <Box display="flex" flexWrap="wrap" style={{ gap: 8 }}>
                {[
                  { label: 'List my services', prompt: 'List all services in the catalog' },
                  { label: 'Scaffold a Go service', prompt: 'Scaffold a new Go microservice' },
                  { label: 'Add a Playwright suite', prompt: 'Add a Playwright E2E test suite to an existing service' },
                  { label: 'Check hello-service metrics', prompt: 'Show me the request rate, error rate and latency for hello-service' },
                  { label: 'List deployments', prompt: 'List all running Kubernetes deployments' },
                  { label: 'Find payment services', prompt: 'Find all services related to payments' },
                ].map(({ label, prompt }) => (
                  <Chip
                    key={label}
                    label={label}
                    size="small"
                    clickable
                    variant="outlined"
                    onClick={() => { setInput(prompt); }}
                    style={{ cursor: 'pointer' }}
                  />
                ))}
              </Box>
            </Box>
          )}

          {/* Message list */}
          <Box flex={1} overflow="auto" mb={2} px={1}>
            {messages.length === 0 && !loading && (
              <Typography variant="body2" color="textSecondary" align="center" style={{ marginTop: 16 }}>
                Select a suggestion above or type your question below.
              </Typography>
            )}
            {messages.map((msg, i) => (
              <Box
                key={i}
                display="flex"
                justifyContent={msg.role === 'user' ? 'flex-end' : 'flex-start'}
                mb={1}
              >
                <Paper
                  elevation={1}
                  style={{
                    padding: '10px 16px',
                    maxWidth: '75%',
                    backgroundColor: msg.role === 'user' ? '#1976d2' : '#f5f5f5',
                    color: msg.role === 'user' ? '#fff' : 'inherit',
                    borderRadius: msg.role === 'user' ? '18px 18px 4px 18px' : '18px 18px 18px 4px',
                    wordBreak: 'break-word',
                  }}
                >
                  {msg.role === 'user' ? (
                    <Typography variant="body2" style={{ whiteSpace: 'pre-wrap' }}>{msg.text}</Typography>
                  ) : (
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        p: ({ children }) => <Typography variant="body2" style={{ margin: '4px 0' }}>{children}</Typography>,
                        code: ({ children, className }) => {
                          const isBlock = !!className;
                          return isBlock ? (
                            <pre style={{ background: '#e0e0e0', borderRadius: 4, padding: '8px 12px', overflowX: 'auto', margin: '6px 0' }}>
                              <code style={{ fontSize: 12, fontFamily: 'monospace' }}>{children}</code>
                            </pre>
                          ) : (
                            <code style={{ background: '#e0e0e0', borderRadius: 3, padding: '1px 4px', fontSize: 12, fontFamily: 'monospace' }}>{children}</code>
                          );
                        },
                        ul: ({ children }) => <ul style={{ paddingLeft: 20, margin: '4px 0' }}>{children}</ul>,
                        ol: ({ children }) => <ol style={{ paddingLeft: 20, margin: '4px 0' }}>{children}</ol>,
                        li: ({ children }) => <li style={{ marginBottom: 2 }}><Typography variant="body2" component="span">{children}</Typography></li>,
                        h1: ({ children }) => <Typography variant="h6" style={{ marginTop: 8 }}>{children}</Typography>,
                        h2: ({ children }) => <Typography variant="subtitle1" style={{ fontWeight: 600, marginTop: 6 }}>{children}</Typography>,
                        h3: ({ children }) => <Typography variant="subtitle2" style={{ fontWeight: 600, marginTop: 4 }}>{children}</Typography>,
                        strong: ({ children }) => <strong style={{ fontWeight: 600 }}>{children}</strong>,
                        a: ({ href, children }) => <Link href={href} target="_blank" rel="noopener noreferrer">{children}</Link>,
                      }}
                    >
                      {msg.text}
                    </ReactMarkdown>
                  )}
                </Paper>
              </Box>
            ))}
            {loading && (
              <Box display="flex" alignItems="center" mb={1} style={{ gap: 8 }}>
                <CircularProgress size={16} />
                <Typography variant="caption" color="textSecondary">{statusText}</Typography>
              </Box>
            )}
            <div ref={bottomRef} />
          </Box>

          {/* Input */}
          <Box display="flex" alignItems="center" style={{ gap: 8 }}>
            <TextField
              fullWidth
              variant="outlined"
              size="small"
              placeholder="Ask about services, deployments, metrics…"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
              disabled={loading}
              InputProps={{
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton size="small" onClick={sendMessage} disabled={loading || !input.trim()}>
                      <SendIcon fontSize="small" />
                    </IconButton>
                  </InputAdornment>
                ),
              }}
            />
          </Box>
        </Box>
      </Content>
    </Page>
  );
}

// ── Semantic Search (RAG) page ────────────────────────────────────────────────
// Calls /api/rag-search/search → Voyage AI embeddings → pgvector similarity.

interface RagResult {
  id: string;
  title: string;
  kind: string;
  url: string;
  content: string;
  similarity: number;
}

function SemanticSearchPage() {
  const fetchApi = useApi(fetchApiRef);
  const configApi = useApi(configApiRef);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<RagResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [indexing, setIndexing] = useState(false);
  const [indexMsg, setIndexMsg] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runSearch = async (q: string) => {
    if (!q.trim()) { setResults([]); return; }
    setLoading(true);
    setError(null);
    const base = configApi.getString('backend.baseUrl');
    try {
      const resp = await fetchApi.fetch(
        `${base}/api/rag-search/search?q=${encodeURIComponent(q)}`,
      );
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({})) as any;
        throw new Error(body.error ?? `HTTP ${resp.status}`);
      }
      const data = await resp.json() as { results: RagResult[] };
      setResults(data.results);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleQueryChange = (value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runSearch(value), 400);
  };

  const handleReindex = async () => {
    setIndexing(true);
    setIndexMsg(null);
    const base = configApi.getString('backend.baseUrl');
    try {
      await fetchApi.fetch(`${base}/api/rag-search/index`, { method: 'POST' });
      setIndexMsg('Re-index started — results will update within a minute.');
    } catch (err: any) {
      setIndexMsg(`Re-index failed: ${err.message}`);
    } finally {
      setIndexing(false);
    }
  };

  const kindColors: Record<string, 'default' | 'primary' | 'secondary'> = {
    Component: 'primary',
    Template: 'secondary',
    API: 'default',
  };

  return (
    <Page themeId="tool">
      <Header title="AI Search" subtitle="Semantic search powered by Voyage AI + pgvector" />
      <Content>
        <Box mb={2} display="flex" alignItems="center" style={{ gap: 8 }}>
          <TextField
            fullWidth
            variant="outlined"
            size="small"
            placeholder="Search by intent, e.g. 'deploy a Go service' or 'ML training pipeline'…"
            value={query}
            onChange={e => handleQueryChange(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') runSearch(query); }}
            InputProps={{
              endAdornment: (
                <InputAdornment position="end">
                  <IconButton size="small" onClick={() => runSearch(query)} disabled={loading || !query.trim()}>
                    <SearchIcon fontSize="small" />
                  </IconButton>
                </InputAdornment>
              ),
            }}
          />
          <Tooltip title="Re-index catalog entities and external sources">
            <span>
              <Button
                variant="outlined"
                size="small"
                onClick={handleReindex}
                disabled={indexing}
                style={{ whiteSpace: 'nowrap' }}
              >
                {indexing ? 'Indexing…' : 'Re-index'}
              </Button>
            </span>
          </Tooltip>
        </Box>

        {indexMsg && (
          <Box mb={1}><Typography variant="caption" color="textSecondary">{indexMsg}</Typography></Box>
        )}

        {loading && <LinearProgress style={{ marginBottom: 12 }} />}

        {error && (
          <Box mb={2}><Typography color="error" variant="body2">{error}</Typography></Box>
        )}

        {!loading && !error && results.length === 0 && query.trim() && (
          <Typography variant="body2" color="textSecondary">
            No results found. Try re-indexing if this is a first run.
          </Typography>
        )}

        {results.map(r => (
          <Paper key={r.id} elevation={1} style={{ padding: '12px 16px', marginBottom: 10 }}>
            <Box display="flex" alignItems="center" mb={1} style={{ gap: 8 }}>
              <Chip
                label={r.kind}
                size="small"
                color={kindColors[r.kind] ?? 'default'}
              />
              <Typography variant="subtitle2">
                {r.url ? (
                  <Link href={r.url} target="_blank" rel="noopener">
                    {r.title}
                  </Link>
                ) : r.title}
              </Typography>
              <Typography variant="caption" color="textSecondary" style={{ marginLeft: 'auto' }}>
                {Math.round(r.similarity * 100)}% match
              </Typography>
            </Box>
            {r.content && (
              <Typography variant="body2" color="textSecondary" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {r.content.slice(0, 200)}{r.content.length > 200 ? '…' : ''}
              </Typography>
            )}
          </Paper>
        ))}
      </Content>
    </Page>
  );
}

const semanticSearchRouteRef = createRouteRef();

const semanticSearchPage = PageBlueprint.make({
  name: 'ai-search',
  params: {
    path: '/ai-search',
    routeRef: semanticSearchRouteRef,
    loader: async () => <SemanticSearchPage />,
  },
});

const semanticSearchNavItem = NavItemBlueprint.make({
  name: 'ai-search',
  params: {
    title: 'AI Search',
    icon: SearchIcon as any,
    routeRef: semanticSearchRouteRef,
  },
});

const aiAssistantRouteRef = createRouteRef();

const aiAssistantPage = PageBlueprint.make({
  name: 'ai-assistant',
  params: {
    path: '/ai-assistant',
    routeRef: aiAssistantRouteRef,
    loader: async () => <AiAssistantPage />,
  },
});

const aiAssistantNavItem = NavItemBlueprint.make({
  name: 'ai-assistant',
  params: {
    title: 'AI Assistant',
    icon: ChatIcon as any,
    routeRef: aiAssistantRouteRef,
  },
});

// ── Shift-Left Scorecard tab ──────────────────────────────────────────────────
// Renders the Bronze/Silver/Gold quality scorecard on every Component entity
// page. Computes the 11 checks client-side from the entity's annotations,
// relations, and tags — keep this logic in sync with
// backstage/app/packages/backend/src/modules/idpTechInsights.ts.
// See docs/shift-left.md for the tier model.

type CheckKey =
  | 'has-owner'
  | 'has-techdocs'
  | 'has-health-probes'
  | 'has-runbook-url'
  | 'has-api-definition'
  | 'uses-pinned-image-tag'
  | 'has-coverage-gate'
  | 'has-static-analysis'
  | 'has-vuln-scan'
  | 'has-contract-tests'
  | 'has-e2e-tests'
  | 'has-model-card'
  | 'has-eval-suite'
  | 'has-ai-observability'
  | 'has-sonar-scanning'
  | 'has-snyk-scanning';

interface CheckDef {
  id: CheckKey;
  label: string;
  group: 'Hygiene' | 'Shift-Left CI' | 'Test Coverage' | 'AI Governance' | 'Security';
  remediation: string;
}

const CHECKS: CheckDef[] = [
  { id: 'has-owner',             group: 'Hygiene',       label: 'Has owner',                 remediation: 'Set spec.owner in catalog-info.yaml.' },
  { id: 'has-techdocs',          group: 'Hygiene',       label: 'Has TechDocs',              remediation: 'Add annotation backstage.io/techdocs-ref: dir:.' },
  { id: 'has-health-probes',     group: 'Hygiene',       label: 'Has Kubernetes probes',     remediation: 'Add annotation backstage.io/kubernetes-id (the Helm chart wires the probes).' },
  { id: 'has-runbook-url',       group: 'Hygiene',       label: 'Has runbook URL',           remediation: 'Add annotation backstage.io/runbook-url linking to your service runbook.' },
  { id: 'has-api-definition',    group: 'Hygiene',       label: 'Has API definition',        remediation: 'Declare providesApis in catalog-info.yaml or expose /openapi.json.' },
  { id: 'uses-pinned-image-tag', group: 'Hygiene',       label: 'Pinned image tag (no :latest)', remediation: 'Set annotation backstage.io/image-tag to a SHA or version; avoid latest.' },
  { id: 'has-coverage-gate',     group: 'Shift-Left CI', label: 'Coverage gate in CI',       remediation: 'Add "coverage" to idp.io/quality-gates annotation (skeleton CI already enforces 70%).' },
  { id: 'has-static-analysis',   group: 'Shift-Left CI', label: 'Static analysis in CI',     remediation: 'Add "static-analysis" to idp.io/quality-gates annotation.' },
  { id: 'has-vuln-scan',         group: 'Shift-Left CI', label: 'Vuln scan in CI',           remediation: 'Add "vuln-scan" to idp.io/quality-gates annotation.' },
  { id: 'has-contract-tests',    group: 'Test Coverage', label: 'Contract tests',            remediation: 'Run the enable-contract-testing scaffolder template, or add "contract" to idp.io/quality-gates.' },
  { id: 'has-e2e-tests',         group: 'Test Coverage', label: 'End-to-end tests',          remediation: 'Run the playwright-e2e-suite scaffolder, or tag the entity with e2e/playwright.' },
  { id: 'has-model-card',        group: 'AI Governance', label: 'Has model card',            remediation: 'Add annotation backstage.io/model-card-url documenting the model, its training data, and performance.' },
  { id: 'has-eval-suite',        group: 'AI Governance', label: 'LLM eval suite in CI',      remediation: 'Add "llm-eval" to idp.io/quality-gates and run the deepeval-llm-eval-suite scaffolder.' },
  { id: 'has-ai-observability',  group: 'AI Governance', label: 'AI observability wired',    remediation: 'Add annotation backstage.io/kubernetes-id and tag the entity with "ai" to enable Grafana dashboards.' },
  { id: 'has-sonar-scanning',    group: 'Security',      label: 'SonarCloud quality gate',   remediation: 'Run the enable-security-scanning scaffolder, or add a sonarcloud.io/project-key annotation.' },
  { id: 'has-snyk-scanning',     group: 'Security',      label: 'Snyk SCA scan',             remediation: 'Run the enable-security-scanning scaffolder, or add a snyk.io/org-slug annotation.' },
];

type TierName = 'none' | 'bronze' | 'silver' | 'gold';

// Thresholds for non-AI entities (11 checks) and AI entities (14 checks)
const TIER_THRESHOLDS: Record<Exclude<TierName, 'none'>, number> = {
  bronze: 4,   // ~36% of 11 checks
  silver: 7,   // ~64% of 11 checks
  gold:   9,   // ~82% of 11 checks
};
const AI_TIER_THRESHOLDS: Record<Exclude<TierName, 'none'>, number> = {
  bronze: 5,   // ~36% of 14 checks
  silver: 9,   // ~64% of 14 checks
  gold:   12,  // ~86% of 14 checks
};

interface ScorecardResult {
  results: Record<CheckKey, boolean>;
  passed: number;
  total: number;
  tier: TierName;
}

function parseGates(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(raw.split(',').map(s => s.trim()).filter(Boolean));
}

function computeScorecard(entity: Entity): ScorecardResult {
  const annotations = entity.metadata.annotations ?? {};
  const relations   = entity.relations ?? [];
  const tags        = entity.metadata.tags ?? [];
  const gates       = parseGates(annotations['idp.io/quality-gates']);

  const hasOwner = Boolean(
    entity.spec?.owner &&
    relations.some(r => r.type === 'ownedBy'),
  );
  const hasApiDefinition = relations.some(r => r.type === 'providesApi');
  const imageTag         = annotations['backstage.io/image-tag'] ?? '';
  const hasE2eTagged     = tags.some(t =>
    ['e2e', 'playwright', 'cypress', 'appium'].includes(t.toLowerCase()),
  );

  const hasKubernetesId = Boolean(annotations['backstage.io/kubernetes-id']);
  const isAiEntity =
    tags.some(t => t.toLowerCase() === 'ai') ||
    ['ai-agent', 'model-serving', 'llm', 'ml-model'].includes(
      ((entity.spec as any)?.type ?? '').toLowerCase(),
    );

  const results: Record<CheckKey, boolean> = {
    'has-owner':             hasOwner,
    'has-techdocs':          Boolean(annotations['backstage.io/techdocs-ref']),
    'has-health-probes':     hasKubernetesId,
    'has-runbook-url':       Boolean(annotations['backstage.io/runbook-url']),
    'has-api-definition':    hasApiDefinition,
    'uses-pinned-image-tag': imageTag !== '' && imageTag !== 'latest',
    'has-coverage-gate':     gates.has('coverage'),
    'has-static-analysis':   gates.has('static-analysis'),
    'has-vuln-scan':         gates.has('vuln-scan'),
    'has-contract-tests':    gates.has('contract') || hasApiDefinition,
    'has-e2e-tests':         gates.has('e2e') || hasE2eTagged || relations.some(r => r.type === 'consumesApi'),
    'has-model-card':        isAiEntity && Boolean(annotations['backstage.io/model-card-url']),
    'has-eval-suite':        isAiEntity && gates.has('llm-eval'),
    'has-ai-observability':  isAiEntity && hasKubernetesId,
    'has-sonar-scanning':    gates.has('sonar-scanning') || Boolean(annotations['sonarcloud.io/project-key']),
    'has-snyk-scanning':     gates.has('snyk-scanning') || Boolean(annotations['snyk.io/org-slug']),
  };

  const thresholds = isAiEntity ? AI_TIER_THRESHOLDS : TIER_THRESHOLDS;
  const activeChecks = CHECKS.filter(c => c.group !== 'AI Governance' || isAiEntity);
  const passed = activeChecks.filter(c => results[c.id]).length;
  let tier: TierName = 'none';
  if (passed >= thresholds.gold)        tier = 'gold';
  else if (passed >= thresholds.silver) tier = 'silver';
  else if (passed >= thresholds.bronze) tier = 'bronze';
  return { results, passed, total: activeChecks.length, tier };
}

const TIER_COLORS: Record<TierName, string> = {
  none:   '#9e9e9e',
  bronze: '#cd7f32',
  silver: '#a8a8a8',
  gold:   '#daa520',
};

function TierBadge({ tier, passed, total }: { tier: TierName; passed: number; total: number }) {
  const label = tier === 'none' ? 'No tier yet' : tier.charAt(0).toUpperCase() + tier.slice(1);
  return (
    <Box display="flex" alignItems="center" style={{ gap: 16 }}>
      <Box
        display="flex"
        alignItems="center"
        justifyContent="center"
        style={{
          width: 80, height: 80, borderRadius: '50%',
          backgroundColor: TIER_COLORS[tier], color: '#fff',
        }}
      >
        <EmojiEventsIcon style={{ fontSize: 40 }} />
      </Box>
      <Box>
        <Typography variant="h5">{label} tier</Typography>
        <Typography variant="body2" color="textSecondary">
          {passed} of {total} checks passing
        </Typography>
        <Typography variant="caption" color="textSecondary">
          Thresholds — Bronze ≥4, Silver ≥7, Gold ≥10
        </Typography>
      </Box>
    </Box>
  );
}

function NextTierHint({ tier, results, isAiEntity }: { tier: TierName; results: Record<CheckKey, boolean>; isAiEntity: boolean }) {
  const thresholds = isAiEntity ? AI_TIER_THRESHOLDS : TIER_THRESHOLDS;
  const activeChecks = CHECKS.filter(c => c.group !== 'AI Governance' || isAiEntity);
  const passed = activeChecks.filter(c => results[c.id]).length;
  const target = tier === 'gold' ? null
    : tier === 'silver' ? thresholds.gold
    : tier === 'bronze' ? thresholds.silver
    : thresholds.bronze;
  if (target === null) {
    return (
      <Typography variant="body2" color="textSecondary">
        🎉 Gold tier — full shift-left adoption. Consider mutation testing next.
      </Typography>
    );
  }
  const missing = activeChecks.filter(c => !results[c.id]);
  return (
    <Typography variant="body2" color="textSecondary">
      {target - passed} more check{target - passed === 1 ? '' : 's'} to reach{' '}
      {target === thresholds.gold ? 'Gold' : target === thresholds.silver ? 'Silver' : 'Bronze'}.
      Cheapest unfilled: <strong>{missing[0]?.label ?? '—'}</strong>.
    </Typography>
  );
}

function ScorecardEntityContent() {
  const { entity } = useEntity();
  const score = useMemo(() => computeScorecard(entity), [entity]);

  const isAiEntity = useMemo(() => {
    const tags = entity.metadata.tags ?? [];
    const type = (entity.spec as any)?.type ?? '';
    return tags.some(t => t.toLowerCase() === 'ai') ||
      ['ai-agent', 'model-serving', 'llm', 'ml-model'].includes(type.toLowerCase());
  }, [entity]);

  const grouped = useMemo(() => {
    const groups: Record<string, CheckDef[]> = {};
    for (const c of CHECKS) {
      if (c.group === 'AI Governance' && !isAiEntity) continue;
      (groups[c.group] ||= []).push(c);
    }
    return groups;
  }, [isAiEntity]);

  return (
    <Content>
      <Box mb={3}>
        <TierBadge tier={score.tier} passed={score.passed} total={score.total} />
        <Box mt={2}>
          <NextTierHint tier={score.tier} results={score.results} isAiEntity={isAiEntity} />
        </Box>
      </Box>

      {Object.entries(grouped).map(([group, checks]) => (
        <Box key={group} mb={3}>
          <Typography variant="subtitle1" style={{ marginBottom: 8 }}>
            {group}
          </Typography>
          <TableContainer component={Paper}>
            <MuiTable size="small">
              <TableHead>
                <TableRow>
                  <TableCell style={{ width: 60 }}>Status</TableCell>
                  <TableCell>Check</TableCell>
                  <TableCell>How to fix if failing</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {checks.map(c => {
                  const ok = score.results[c.id];
                  return (
                    <TableRow key={c.id}>
                      <TableCell>
                        {ok
                          ? <CheckCircleIcon style={{ color: '#4caf50' }} />
                          : <CancelIcon style={{ color: '#f44336' }} />}
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2"><strong>{c.label}</strong></Typography>
                        <Typography variant="caption" color="textSecondary">{c.id}</Typography>
                      </TableCell>
                      <TableCell>
                        {ok
                          ? <Typography variant="caption" color="textSecondary">—</Typography>
                          : <Typography variant="caption">{c.remediation}</Typography>}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </MuiTable>
          </TableContainer>
        </Box>
      ))}

      <Box mt={2}>
        <Typography variant="caption" color="textSecondary">
          Programme reference: <Link href="https://github.com/moatazeldebsy/backstage-platform-template/blob/main/docs/shift-left.md" target="_blank" rel="noopener">docs/shift-left.md</Link>
        </Typography>
      </Box>
    </Content>
  );
}

const scorecardEntityContent = EntityContentBlueprint.make({
  name: 'shift-left-scorecard',
  params: {
    path: '/scorecard',
    title: 'Scorecard',
    filter: 'kind:component',
    loader: async () => <ScorecardEntityContent />,
  },
});

// ── Security tab (SonarCloud + Snyk) ───────────────────────────────────────────
// Reads the sonarcloud.io/project-key and snyk.io/org-slug annotations from the
// entity and fetches live results via the Backstage proxy. Empty state when
// annotations are missing (e.g. before the team runs enable-security-scanning).

interface SonarMeasures {
  qualityGate: 'OK' | 'WARN' | 'ERROR' | 'NONE' | null;
  coverage?: string;
  bugs?: string;
  vulnerabilities?: string;
  codeSmells?: string;
  securityHotspots?: string;
}

function SonarCloudCard({ projectKey }: { projectKey: string }) {
  const fetchApi  = useApi(fetchApiRef);
  const configApi = useApi(configApiRef);
  const [data, setData]       = useState<SonarMeasures | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  useEffect(() => {
    const baseUrl = configApi.getString('backend.baseUrl');
    const metricKeys = 'coverage,bugs,vulnerabilities,code_smells,security_hotspots';
    const gateUrl    = `${baseUrl}/api/proxy/sonarcloud/api/qualitygates/project_status?projectKey=${encodeURIComponent(projectKey)}`;
    const measUrl    = `${baseUrl}/api/proxy/sonarcloud/api/measures/component?component=${encodeURIComponent(projectKey)}&metricKeys=${metricKeys}`;

    Promise.all([fetchApi.fetch(gateUrl), fetchApi.fetch(measUrl)])
      .then(async ([gR, mR]) => {
        if (!gR.ok) throw new Error(`SonarCloud quality gate: ${gR.status}`);
        if (!mR.ok) throw new Error(`SonarCloud measures: ${mR.status}`);
        const gateJson = await gR.json();
        const measJson = await mR.json();
        const measures: Record<string, string> = {};
        for (const m of measJson?.component?.measures ?? []) measures[m.metric] = m.value;
        setData({
          qualityGate: gateJson?.projectStatus?.status ?? 'NONE',
          coverage:         measures.coverage,
          bugs:             measures.bugs,
          vulnerabilities:  measures.vulnerabilities,
          codeSmells:       measures.code_smells,
          securityHotspots: measures.security_hotspots,
        });
        setLoading(false);
      })
      .catch((err: Error) => { setError(err.message); setLoading(false); });
  }, [fetchApi, configApi, projectKey]);

  const dashboardUrl = `https://sonarcloud.io/dashboard?id=${encodeURIComponent(projectKey)}`;
  const gateColor = data?.qualityGate === 'OK' ? '#4caf50'
    : data?.qualityGate === 'WARN' ? '#ff9800'
    : data?.qualityGate === 'ERROR' ? '#f44336' : '#9e9e9e';

  return (
    <Box mb={3}>
      <Typography variant="subtitle1" style={{ marginBottom: 8 }}>
        SonarCloud — <code>{projectKey}</code>
      </Typography>
      <Paper style={{ padding: 16 }}>
        {loading && <Progress />}
        {!loading && error && (
          <Typography variant="body2" color="textSecondary">
            Unable to load SonarCloud data: <strong>{error}</strong>. Verify
            <code> SONAR_TOKEN</code> is set and the projectKey exists.
            <Box mt={1}><Link href={dashboardUrl} target="_blank" rel="noopener">Open SonarCloud dashboard ↗</Link></Box>
          </Typography>
        )}
        {!loading && !error && data && (
          <Box>
            <Box display="flex" alignItems="center" style={{ gap: 12, marginBottom: 12 }}>
              <Chip
                label={`Quality gate: ${data.qualityGate}`}
                style={{ backgroundColor: gateColor, color: 'white' }}
              />
              <Link href={dashboardUrl} target="_blank" rel="noopener">Open in SonarCloud ↗</Link>
            </Box>
            <TableContainer>
              <MuiTable size="small">
                <TableBody>
                  <TableRow><TableCell>Coverage</TableCell><TableCell>{data.coverage ? `${data.coverage}%` : '—'}</TableCell></TableRow>
                  <TableRow><TableCell>Bugs</TableCell><TableCell>{data.bugs ?? '—'}</TableCell></TableRow>
                  <TableRow><TableCell>Vulnerabilities</TableCell><TableCell>{data.vulnerabilities ?? '—'}</TableCell></TableRow>
                  <TableRow><TableCell>Security hotspots</TableCell><TableCell>{data.securityHotspots ?? '—'}</TableCell></TableRow>
                  <TableRow><TableCell>Code smells</TableCell><TableCell>{data.codeSmells ?? '—'}</TableCell></TableRow>
                </TableBody>
              </MuiTable>
            </TableContainer>
          </Box>
        )}
      </Paper>
    </Box>
  );
}

function SnykCard({ orgSlug, repoSlug }: { orgSlug: string; repoSlug?: string }) {
  // The Snyk REST API requires a project ID we don't have at scaffold time;
  // we link out to the org/project dashboard and surface the org/repo it's
  // scoped to. Live counts can be wired in later via the /reporting endpoint.
  const orgUrl     = `https://app.snyk.io/org/${encodeURIComponent(orgSlug)}`;
  const projectUrl = repoSlug
    ? `https://app.snyk.io/org/${encodeURIComponent(orgSlug)}/projects?searchQuery=${encodeURIComponent(repoSlug)}`
    : orgUrl;

  return (
    <Box mb={3}>
      <Typography variant="subtitle1" style={{ marginBottom: 8 }}>
        Snyk — <code>{orgSlug}</code>
      </Typography>
      <Paper style={{ padding: 16 }}>
        <Typography variant="body2" color="textSecondary">
          Snyk monitors this service for dependency, container, and IaC vulnerabilities.
          The <code>Snyk monitor</code> CI step uploads scan results on every push to main.
        </Typography>
        <Box mt={2} display="flex" style={{ gap: 16 }}>
          <Link href={projectUrl} target="_blank" rel="noopener">Open project in Snyk ↗</Link>
          <Link href={orgUrl} target="_blank" rel="noopener">Org dashboard ↗</Link>
        </Box>
      </Paper>
    </Box>
  );
}

function SecurityEntityContent() {
  const { entity } = useEntity();
  const annotations = entity.metadata.annotations ?? {};
  const projectKey = annotations['sonarcloud.io/project-key'];
  const orgSlug    = annotations['snyk.io/org-slug'];
  const repoSlug   = annotations['github.com/project-slug']?.split('/')[1];

  const configured = Boolean(projectKey || orgSlug);

  return (
    <Content>
      {!configured && (
        <Box mb={3}>
          <Paper style={{ padding: 24, textAlign: 'center' }}>
            <Typography variant="h6" gutterBottom>Security scanning not configured</Typography>
            <Typography variant="body2" color="textSecondary">
              This service does not have SonarCloud or Snyk annotations yet.
              Run the <strong>Enable Security Scanning</strong> scaffolder template
              (Catalog → Create → search "security") to open a PR that wires both
              into this service's CI.
            </Typography>
            <Box mt={2}>
              <Link href="/create" target="_self">Open scaffolder ↗</Link>
            </Box>
          </Paper>
        </Box>
      )}
      {projectKey && <SonarCloudCard projectKey={projectKey} />}
      {orgSlug     && <SnykCard orgSlug={orgSlug} repoSlug={repoSlug} />}
    </Content>
  );
}

const securityEntityContent = EntityContentBlueprint.make({
  name: 'security-scanning',
  params: {
    path: '/security',
    title: 'Security',
    filter: 'kind:component',
    loader: async () => <SecurityEntityContent />,
  },
});

// ── PagerDuty on-call tab ──────────────────────────────────────────────────────
// Reads pagerduty.com/service-id annotation and shows on-call person + open
// incidents via the /api/proxy/pagerduty endpoint.

function PagerDutyOnCallCard({ serviceId }: { serviceId: string }) {
  const fetchApi  = useApi(fetchApiRef);
  const configApi = useApi(configApiRef);
  const base = configApi.getString('backend.baseUrl');

  const [oncall, setOncall]       = useState<any[]>([]);
  const [incidents, setIncidents] = useState<any[]>([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState<string | null>(null);

  useEffect(() => {
    const headers = { 'Content-Type': 'application/json' };
    Promise.all([
      fetchApi.fetch(`${base}/api/proxy/pagerduty/oncalls?service_ids[]=${serviceId}&include[]=users`, { headers })
        .then(r => r.ok ? r.json() : Promise.reject(r.status)),
      fetchApi.fetch(`${base}/api/proxy/pagerduty/incidents?service_ids[]=${serviceId}&statuses[]=triggered&statuses[]=acknowledged`, { headers })
        .then(r => r.ok ? r.json() : Promise.reject(r.status)),
    ])
      .then(([oc, inc]) => { setOncall(oc.oncalls ?? []); setIncidents(inc.incidents ?? []); })
      .catch(e => setError(`PagerDuty unavailable (${e}). Set PAGERDUTY_TOKEN in local/backstage/.env`))
      .finally(() => setLoading(false));
  }, [serviceId, base, fetchApi]);

  if (loading) return <CircularProgress size={24} style={{ margin: 24 }} />;

  if (error) return (
    <Paper style={{ padding: 24, margin: 16 }}>
      <Typography variant="body2" color="textSecondary">{error}</Typography>
    </Paper>
  );

  const primary = oncall.find(o => o.escalation_level === 1);

  return (
    <Box p={2} display="flex" flexDirection="column" style={{ gap: 16 }}>
      <Paper style={{ padding: 16 }}>
        <Typography variant="h6" gutterBottom>On-Call Now</Typography>
        {primary ? (
          <Box display="flex" alignItems="center" style={{ gap: 12 }}>
            <Typography variant="body1" style={{ fontWeight: 600 }}>
              {primary.user?.summary ?? 'Unknown'}
            </Typography>
            <Chip size="small" label={`L${primary.escalation_level}`} color="primary" />
          </Box>
        ) : (
          <Typography variant="body2" color="textSecondary">No on-call schedule found for this service.</Typography>
        )}
        {oncall.length > 1 && (
          <Box mt={1}>
            <Typography variant="caption" color="textSecondary">
              Escalation chain: {oncall.map(o => o.user?.summary).filter(Boolean).join(' → ')}
            </Typography>
          </Box>
        )}
      </Paper>

      <Paper style={{ padding: 16 }}>
        <Box display="flex" justifyContent="space-between" alignItems="center" mb={1}>
          <Typography variant="h6">Open Incidents</Typography>
          <Chip
            size="small"
            label={incidents.length}
            style={{ background: incidents.length > 0 ? '#d32f2f' : '#388e3c', color: '#fff' }}
          />
        </Box>
        {incidents.length === 0 ? (
          <Typography variant="body2" color="textSecondary">No open incidents.</Typography>
        ) : (
          <TableContainer>
            <MuiTable size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Title</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Urgency</TableCell>
                  <TableCell>Created</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {incidents.slice(0, 10).map((inc: any) => (
                  <TableRow key={inc.id}>
                    <TableCell>
                      <Link href={inc.html_url} target="_blank" rel="noopener">{inc.title}</Link>
                    </TableCell>
                    <TableCell><Chip size="small" label={inc.status} /></TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        label={inc.urgency}
                        style={{ background: inc.urgency === 'high' ? '#d32f2f' : '#f57c00', color: '#fff' }}
                      />
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption">
                        {new Date(inc.created_at).toLocaleString()}
                      </Typography>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </MuiTable>
          </TableContainer>
        )}
      </Paper>
    </Box>
  );
}

function PagerDutyEntityContent() {
  const { entity } = useEntity();
  const serviceId = entity.metadata.annotations?.['pagerduty.com/service-id'];

  if (!serviceId) return (
    <Content>
      <Paper style={{ padding: 24, margin: 16, textAlign: 'center' }}>
        <Typography variant="h6" gutterBottom>PagerDuty not configured</Typography>
        <Typography variant="body2" color="textSecondary">
          Add <code>pagerduty.com/service-id: YOUR_PD_SERVICE_ID</code> to this service's{' '}
          <code>catalog-info.yaml</code> annotations to see on-call and incidents here.
        </Typography>
      </Paper>
    </Content>
  );

  return <Content><PagerDutyOnCallCard serviceId={serviceId} /></Content>;
}

const pagerDutyEntityContent = EntityContentBlueprint.make({
  name: 'pagerduty',
  params: {
    path: '/on-call',
    title: 'On-Call',
    filter: 'kind:component',
    loader: async () => <PagerDutyEntityContent />,
  },
});

// ── Grafana Alerts tab ─────────────────────────────────────────────────────────
// Uses the existing /grafana/api proxy. Shows firing alerts for the service
// filtered by the grafana/alert-label-selector annotation.

function GrafanaAlertsCard({ labelSelector }: { labelSelector: string }) {
  const fetchApi  = useApi(fetchApiRef);
  const configApi = useApi(configApiRef);
  const base = configApi.getString('backend.baseUrl');

  const [alerts, setAlerts]   = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  useEffect(() => {
    const encoded = encodeURIComponent(labelSelector);
    fetchApi
      .fetch(`${base}/api/proxy/grafana/api/api/alertmanager/grafana/api/v2/alerts?filter=${encoded}&active=true&silenced=false&inhibited=false`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(data => setAlerts(Array.isArray(data) ? data : []))
      .catch(e => {
        const hint =
          e === 401 || e === 403 ? 'Check GRAFANA_TOKEN in local/backstage/.env.' :
          e === 502 || e === 503 || e === 504 ? 'Grafana is unreachable — is the cluster running and grafana.idp.local resolvable?' :
          'Check the Backstage proxy config and GRAFANA_TOKEN in local/backstage/.env.';
        setError(`Grafana alerts unavailable (${e}). ${hint}`);
      })
      .finally(() => setLoading(false));
  }, [labelSelector, base, fetchApi]);

  if (loading) return <CircularProgress size={24} style={{ margin: 24 }} />;

  if (error) return (
    <Paper style={{ padding: 24, margin: 16 }}>
      <Typography variant="body2" color="textSecondary">{error}</Typography>
    </Paper>
  );

  return (
    <Paper style={{ padding: 16, margin: 16 }}>
      <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
        <Typography variant="h6">Firing Alerts</Typography>
        <Chip
          size="small"
          label={alerts.length === 0 ? 'All Clear' : `${alerts.length} Firing`}
          style={{ background: alerts.length === 0 ? '#388e3c' : '#d32f2f', color: '#fff' }}
        />
      </Box>
      {alerts.length === 0 ? (
        <Typography variant="body2" color="textSecondary">
          No firing alerts. Filter: <code>{labelSelector}</code>
        </Typography>
      ) : (
        <TableContainer>
          <MuiTable size="small">
            <TableHead>
              <TableRow>
                <TableCell>Alert</TableCell>
                <TableCell>Severity</TableCell>
                <TableCell>Since</TableCell>
                <TableCell>Summary</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {alerts.map((a: any, i: number) => (
                <TableRow key={i}>
                  <TableCell><Typography variant="body2" style={{ fontWeight: 600 }}>{a.labels?.alertname}</Typography></TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      label={a.labels?.severity ?? 'unknown'}
                      style={{
                        background: a.labels?.severity === 'critical' ? '#d32f2f' : a.labels?.severity === 'warning' ? '#f57c00' : '#616161',
                        color: '#fff',
                      }}
                    />
                  </TableCell>
                  <TableCell>
                    <Typography variant="caption">{a.startsAt ? new Date(a.startsAt).toLocaleString() : '—'}</Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="caption">{a.annotations?.summary ?? a.annotations?.description ?? '—'}</Typography>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </MuiTable>
        </TableContainer>
      )}
    </Paper>
  );
}

function GrafanaEntityContent() {
  const { entity } = useEntity();
  const annotations = entity.metadata.annotations ?? {};
  const labelSelector = annotations['grafana/alert-label-selector'];
  const dashboardUrl  = entity.metadata.links?.find(l => l.title === 'Grafana Dashboard')?.url;

  return (
    <Content>
      {dashboardUrl && (
        <Box p={2}>
          <Button variant="outlined" href={dashboardUrl} target="_blank" rel="noopener">
            Open Grafana Dashboard ↗
          </Button>
        </Box>
      )}
      {labelSelector ? (
        <GrafanaAlertsCard labelSelector={labelSelector} />
      ) : (
        <Paper style={{ padding: 24, margin: 16, textAlign: 'center' }}>
          <Typography variant="body2" color="textSecondary">
            Add <code>grafana/alert-label-selector: service={entity.metadata.name}</code> to this
            entity's annotations to show live Grafana alerts here.
          </Typography>
        </Paper>
      )}
    </Content>
  );
}

const grafanaEntityContent = EntityContentBlueprint.make({
  name: 'grafana-alerts',
  params: {
    path: '/grafana',
    title: 'Grafana',
    filter: 'kind:component',
    loader: async () => <GrafanaEntityContent />,
  },
});

// ── Jira Issues tab ────────────────────────────────────────────────────────────
// Reads jira/project-key annotation and shows open issues via /api/proxy/jira.

function JiraIssuesCard({ projectKey }: { projectKey: string }) {
  const fetchApi  = useApi(fetchApiRef);
  const configApi = useApi(configApiRef);
  const base = configApi.getString('backend.baseUrl');

  const [issues, setIssues]   = useState<any[]>([]);
  const [total, setTotal]     = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  useEffect(() => {
    const jql = encodeURIComponent(`project = ${projectKey} AND statusCategory != Done ORDER BY created DESC`);
    fetchApi
      .fetch(`${base}/api/proxy/jira/rest/api/2/search?jql=${jql}&maxResults=10&fields=summary,status,priority,assignee,issuetype,created`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(data => { setIssues(data.issues ?? []); setTotal(data.total ?? 0); })
      .catch(e => setError(`Jira unavailable (${e}). Set JIRA_TOKEN and JIRA_URL in local/backstage/.env`))
      .finally(() => setLoading(false));
  }, [projectKey, base, fetchApi]);

  if (loading) return <CircularProgress size={24} style={{ margin: 24 }} />;

  if (error) return (
    <Paper style={{ padding: 24, margin: 16 }}>
      <Typography variant="body2" color="textSecondary">{error}</Typography>
    </Paper>
  );

  return (
    <Paper style={{ padding: 16, margin: 16 }}>
      <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
        <Typography variant="h6">Open Issues — {projectKey}</Typography>
        <Chip size="small" label={`${total} open`} color="primary" />
      </Box>
      {issues.length === 0 ? (
        <Typography variant="body2" color="textSecondary">No open issues in this project.</Typography>
      ) : (
        <TableContainer>
          <MuiTable size="small">
            <TableHead>
              <TableRow>
                <TableCell>Key</TableCell>
                <TableCell>Summary</TableCell>
                <TableCell>Type</TableCell>
                <TableCell>Priority</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Assignee</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {issues.map((issue: any) => (
                <TableRow key={issue.key}>
                  <TableCell>
                    <Link href={`${issue.self?.split('/rest')[0]}/browse/${issue.key}`} target="_blank" rel="noopener">
                      {issue.key}
                    </Link>
                  </TableCell>
                  <TableCell><Typography variant="body2">{issue.fields?.summary}</Typography></TableCell>
                  <TableCell><Typography variant="caption">{issue.fields?.issuetype?.name}</Typography></TableCell>
                  <TableCell>
                    <Chip size="small" label={issue.fields?.priority?.name ?? '—'} />
                  </TableCell>
                  <TableCell>
                    <Chip size="small" label={issue.fields?.status?.name ?? '—'} />
                  </TableCell>
                  <TableCell>
                    <Typography variant="caption">{issue.fields?.assignee?.displayName ?? 'Unassigned'}</Typography>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </MuiTable>
        </TableContainer>
      )}
    </Paper>
  );
}

function JiraEntityContent() {
  const { entity } = useEntity();
  const projectKey = entity.metadata.annotations?.['jira/project-key'];

  if (!projectKey) return (
    <Content>
      <Paper style={{ padding: 24, margin: 16, textAlign: 'center' }}>
        <Typography variant="h6" gutterBottom>Jira not configured</Typography>
        <Typography variant="body2" color="textSecondary">
          Add <code>jira/project-key: YOUR_PROJECT_KEY</code> to this service's{' '}
          <code>catalog-info.yaml</code> to see open issues here.
        </Typography>
      </Paper>
    </Content>
  );

  return <Content><JiraIssuesCard projectKey={projectKey} /></Content>;
}

const jiraEntityContent = EntityContentBlueprint.make({
  name: 'jira-issues',
  params: {
    path: '/jira',
    title: 'Jira',
    filter: 'kind:component',
    loader: async () => <JiraEntityContent />,
  },
});

// ── GitHub Copilot Metrics page ────────────────────────────────────────────────
// Custom nav page showing Copilot usage via GitHub REST API (public, free).
// Requires GITHUB_TOKEN in local/backstage/.env (already required for catalog).

const copilotRouteRef = createRouteRef({ id: 'copilot-metrics' });

interface CopilotDay {
  date: string;
  total_active_users: number;
  total_engaged_users: number;
  copilot_ide_code_completions?: {
    total_engaged_users: number;
    languages?: { name: string; total_code_acceptances: number; total_code_suggestions: number; total_code_lines_accepted: number; total_code_lines_suggested: number }[];
  };
}

/** 28 days of realistic-looking demo Copilot data shown when the real API is unavailable. */
function generateDemoCopilotData(): CopilotDay[] {
  const languages = ['TypeScript', 'Python', 'Go', 'JavaScript', 'YAML'];
  return Array.from({ length: 28 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (27 - i));
    const date = d.toISOString().slice(0, 10);
    const activeUsers    = 18 + Math.floor(Math.sin(i / 3) * 5 + Math.random() * 4);
    const engagedUsers   = Math.round(activeUsers * (0.7 + Math.random() * 0.15));
    const langData = languages.map(name => {
      const suggested = 200 + Math.floor(Math.random() * 300 + i * 8);
      const accepted  = Math.round(suggested * (0.28 + Math.random() * 0.18));
      return { name, total_code_suggestions: suggested, total_code_acceptances: accepted,
               total_code_lines_suggested: suggested * 3, total_code_lines_accepted: accepted * 3 };
    });
    return { date, total_active_users: activeUsers, total_engaged_users: engagedUsers,
             copilot_ide_code_completions: { total_engaged_users: engagedUsers, languages: langData } };
  });
}

function CopilotMetricsPage() {
  const fetchApi  = useApi(fetchApiRef);
  const configApi = useApi(configApiRef);
  const base = configApi.getString('backend.baseUrl');

  const [days, setDays]       = useState<CopilotDay[]>([]);
  const [loading, setLoading] = useState(true);
  const [isDemo, setIsDemo]   = useState(false);

  useEffect(() => {
    fetchApi
      .fetch(`${base}/api/proxy/github-copilot/orgs/moatazeldebsy/copilot/metrics`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(data => setDays(Array.isArray(data) ? data.slice(-28) : []))
      .catch(() => { setDays(generateDemoCopilotData()); setIsDemo(true); })
      .finally(() => setLoading(false));
  }, [base, fetchApi]);

  const latest = days[days.length - 1];
  const completions = latest?.copilot_ide_code_completions;
  const totalSuggested = completions?.languages?.reduce((s, l) => s + l.total_code_lines_suggested, 0) ?? 0;
  const totalAccepted  = completions?.languages?.reduce((s, l) => s + l.total_code_lines_accepted, 0) ?? 0;
  const acceptanceRate = totalSuggested > 0 ? ((totalAccepted / totalSuggested) * 100).toFixed(1) : '—';

  return (
    <Page themeId="tool">
      <Header title="GitHub Copilot Metrics" subtitle="Developer productivity via AI assistance" />
      <Content>
        {loading && <CircularProgress style={{ margin: 24 }} />}
        {isDemo && (
          <Paper style={{ padding: '10px 20px', marginBottom: 16, background: '#fff8e1', border: '1px solid #ffe082' }}>
            <Typography variant="body2" style={{ color: '#7c6000' }}>
              📊 <strong>Demo data</strong> — GitHub Copilot API unavailable (no licence or token). Connect a Copilot-enabled org to see live metrics.
            </Typography>
          </Paper>
        )}
        {!loading && (
          <>
            <Box display="flex" style={{ gap: 16, flexWrap: 'wrap', marginBottom: 24 }}>
              {[
                { label: 'Active Users (latest day)', value: latest?.total_active_users ?? '—' },
                { label: 'Engaged Users (latest day)', value: latest?.total_engaged_users ?? '—' },
                { label: 'Lines Accepted (latest day)', value: totalAccepted.toLocaleString() },
                { label: 'Acceptance Rate', value: `${acceptanceRate}%` },
              ].map(({ label, value }) => (
                <Paper key={label} style={{ padding: 20, minWidth: 180, flex: 1 }}>
                  <Typography variant="h4" style={{ fontWeight: 700 }}>{String(value)}</Typography>
                  <Typography variant="body2" color="textSecondary">{label}</Typography>
                </Paper>
              ))}
            </Box>

            <Paper style={{ padding: 16 }}>
              <Typography variant="h6" gutterBottom>Daily Active Users (last 28 days)</Typography>
              <TableContainer>
                <MuiTable size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Date</TableCell>
                      <TableCell align="right">Active Users</TableCell>
                      <TableCell align="right">Engaged Users</TableCell>
                      <TableCell align="right">Lines Suggested</TableCell>
                      <TableCell align="right">Lines Accepted</TableCell>
                      <TableCell align="right">Acceptance %</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {[...days].reverse().map((d) => {
                      const lang = d.copilot_ide_code_completions?.languages;
                      const sug  = lang?.reduce((s, l) => s + l.total_code_lines_suggested, 0) ?? 0;
                      const acc  = lang?.reduce((s, l) => s + l.total_code_lines_accepted, 0) ?? 0;
                      const rate = sug > 0 ? ((acc / sug) * 100).toFixed(1) : '—';
                      return (
                        <TableRow key={d.date}>
                          <TableCell>{d.date}</TableCell>
                          <TableCell align="right">{d.total_active_users}</TableCell>
                          <TableCell align="right">{d.total_engaged_users}</TableCell>
                          <TableCell align="right">{sug.toLocaleString()}</TableCell>
                          <TableCell align="right">{acc.toLocaleString()}</TableCell>
                          <TableCell align="right">{rate}%</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </MuiTable>
              </TableContainer>
            </Paper>
          </>
        )}
      </Content>
    </Page>
  );
}

const copilotPage = PageBlueprint.make({
  name: 'copilot-metrics',
  params: {
    path: '/copilot',
    loader: async () => <CopilotMetricsPage />,
    routeRef: copilotRouteRef,
  },
});

const copilotNavItem = NavItemBlueprint.make({
  name: 'copilot-metrics',
  params: {
    title: 'Copilot Metrics',
    routeRef: copilotRouteRef,
    icon: AttachMoneyIcon as any,
  },
});

// ── DORA Metrics entity tab ────────────────────────────────────────────────────
// Queries Prometheus for per-service DORA metrics and shows 4 stat cards with
// SVG sparklines and DORA performance band badges (Elite / High / Medium / Low).

interface DoraMetric { value: number; series: number[] }

function doraBand(metric: string, v: number): { label: string; color: string } {
  if (metric === 'freq') {
    if (v >= 1)    return { label: 'Elite',  color: '#1b5e20' };
    if (v >= 0.14) return { label: 'High',   color: '#388e3c' };
    if (v >= 0.03) return { label: 'Medium', color: '#f57c00' };
    return             { label: 'Low',    color: '#c62828' };
  }
  if (metric === 'cfr') {
    if (v <= 5)  return { label: 'Elite',  color: '#1b5e20' };
    if (v <= 15) return { label: 'High',   color: '#388e3c' };
    if (v <= 45) return { label: 'Medium', color: '#f57c00' };
    return           { label: 'Low',    color: '#c62828' };
  }
  // lead time + mttr in minutes
  if (v <= 60)    return { label: 'Elite',  color: '#1b5e20' };
  if (v <= 1440)  return { label: 'High',   color: '#388e3c' };
  if (v <= 10080) return { label: 'Medium', color: '#f57c00' };
  return              { label: 'Low',    color: '#c62828' };
}

function Sparkline({ series, color }: { series: number[]; color: string }) {
  if (series.length < 2) return <svg width="80" height="32" />;
  const max = Math.max(...series, 0.001);
  const w = 80; const h = 32; const pad = 2;
  const pts = series.map((v, i) => {
    const x = pad + (i / (series.length - 1)) * (w - pad * 2);
    const y = h - pad - (v / max) * (h - pad * 2);
    return `${x},${y}`;
  });
  return (
    <svg width={w} height={h} style={{ display: 'block' }}>
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
      <circle cx={pts[pts.length-1].split(',')[0]} cy={pts[pts.length-1].split(',')[1]} r="3" fill={color} />
    </svg>
  );
}

function DoraMetricCard({ title, value, unit, series, band, metricKey }: {
  title: string; value: number; unit: string; series: number[]; band: { label: string; color: string }; metricKey: string;
}) {
  const displayVal = metricKey === 'freq'
    ? value < 1 ? `${(value * 7).toFixed(1)}/wk` : `${value.toFixed(1)}/day`
    : metricKey === 'cfr' ? `${value.toFixed(1)}%`
    : value < 60 ? `${value.toFixed(0)} min` : `${(value/60).toFixed(1)} hr`;

  return (
    <Paper style={{ padding: 16, flex: 1, minWidth: 160 }}>
      <Typography variant="caption" style={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, color: '#666' }}>{title}</Typography>
      <Box display="flex" alignItems="center" justifyContent="space-between" style={{ marginTop: 4 }}>
        <Typography variant="h4" style={{ fontWeight: 700 }}>{displayVal}</Typography>
        <Sparkline series={series} color={band.color} />
      </Box>
      <Box display="flex" alignItems="center" justifyContent="space-between" style={{ marginTop: 8 }}>
        <span style={{ background: band.color, color: '#fff', padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 700 }}>{band.label}</span>
        <Typography variant="caption" color="textSecondary">{unit}</Typography>
      </Box>
    </Paper>
  );
}

// dataSource tracks where metrics came from so the UI can be honest about it.
// 'service' = per-entity Prometheus data (best)
// 'aggregate' = all-services Prometheus aggregate (real but platform-wide)
// 'demo' = generated placeholder (Prometheus unreachable or no data at all)
type DoraDataSource = 'service' | 'aggregate' | 'demo';

function DoraEntityContent() {
  const { entity } = useEntity();
  const fetchApi  = useApi(fetchApiRef);
  const configApi = useApi(configApiRef);
  const base = configApi.getString('backend.baseUrl');
  const serviceName = entity.metadata.name;
  // Also try the repo name from github.com/project-slug annotation
  const projectSlug = entity.metadata.annotations?.['github.com/project-slug'] ?? '';
  const repoName = projectSlug.split('/').pop() ?? '';

  const [metrics, setMetrics]   = useState<Record<string, DoraMetric> | null>(null);
  const [loading, setLoading]   = useState(true);
  const [dataSource, setSource] = useState<DoraDataSource>('demo');

  useEffect(() => {
    const promQuery = (expr: string) =>
      fetchApi.fetch(`${base}/api/proxy/prometheus/api/v1/query?query=${encodeURIComponent(expr)}`)
        .then(r => r.ok ? r.json() : Promise.reject(r.status))
        .then(d => parseFloat(d?.data?.result?.[0]?.value?.[1] ?? 'NaN'));

    const promRange = (expr: string) =>
      fetchApi.fetch(`${base}/api/proxy/prometheus/api/v1/query_range?query=${encodeURIComponent(expr)}&start=${Math.floor(Date.now()/1000)-604800}&end=${Math.floor(Date.now()/1000)}&step=86400`)
        .then(r => r.ok ? r.json() : Promise.reject(r.status))
        .then(d => (d?.data?.result?.[0]?.values ?? []).map((v: any[]) => parseFloat(v[1])).filter((v: number) => !isNaN(v)));

    const fetchForService = async (svc: string) => {
      const [freq, lead, cfr, mttr, fS, lS, cS, mS] = await Promise.all([
        promQuery(`max by (service) (dora_deploy_frequency_per_day{service="${svc}"})`),
        promQuery(`max by (service) (dora_lead_time_minutes{service="${svc}"})`),
        promQuery(`max by (service) (dora_change_failure_rate_percent{service="${svc}"})`),
        promQuery(`max by (service) (dora_mttr_minutes{service="${svc}"})`),
        promRange(`max by (service) (dora_deploy_frequency_per_day{service="${svc}"})`),
        promRange(`max by (service) (dora_lead_time_minutes{service="${svc}"})`),
        promRange(`max by (service) (dora_change_failure_rate_percent{service="${svc}"})`),
        promRange(`max by (service) (dora_mttr_minutes{service="${svc}"})`),
      ]);
      return { freq: { value: freq, series: fS }, lead: { value: lead, series: lS }, cfr: { value: cfr, series: cS }, mttr: { value: mttr, series: mS } };
    };

    const hasData = (m: Record<string, DoraMetric>) => !isNaN(m.freq.value) && m.freq.value > 0;

    const DEMO: Record<string, DoraMetric> = {
      freq: { value: 3.2,  series: [1.8,2.1,2.4,3.0,3.2,2.9,3.2] },
      lead: { value: 42,   series: [68,55,50,45,42,39,42] },
      cfr:  { value: 4.8,  series: [8,6,5.5,5,4.8,5.1,4.8] },
      mttr: { value: 28,   series: [65,50,40,35,30,28,28] },
    };

    const candidates = [serviceName, repoName].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);

    (async () => {
      // 1. Try each candidate name that might match a Prometheus service label
      for (const name of candidates) {
        try {
          const m = await fetchForService(name);
          if (hasData(m)) { setMetrics(m); setSource('service'); setLoading(false); return; }
        } catch { /* try next */ }
      }
      // 2. Fall back to platform aggregate (real data, but org-wide not per-service)
      try {
        const agg = await fetchForService('all-services');
        if (hasData(agg)) { setMetrics(agg); setSource('aggregate'); setLoading(false); return; }
      } catch { /* fall through */ }
      // 3. No Prometheus data — show demo
      setMetrics(DEMO); setSource('demo'); setLoading(false);
    })();
  }, [base, fetchApi, serviceName, repoName]);

  const CARDS = [
    { key: 'freq', title: 'Deploy Frequency', unit: 'deploys/day' },
    { key: 'lead', title: 'Lead Time',         unit: 'commit → deploy' },
    { key: 'cfr',  title: 'Change Failure Rate', unit: '% of deploys' },
    { key: 'mttr', title: 'MTTR',               unit: 'time to restore' },
  ];

  const bannerProps: Record<DoraDataSource, { bg: string; border: string; text: string; color: string }> = {
    service: { bg: '#e8f5e9', border: '#a5d6a7', color: '#1b5e20',
      text: `✅ Live per-service data for "${serviceName}" from Prometheus.` },
    aggregate: { bg: '#e3f2fd', border: '#90caf9', color: '#0d47a1',
      text: `ℹ️ Showing platform aggregate (all repos) — no per-service entry found for "${serviceName}" in Prometheus. The DORA exporter tracks GitHub repos by their repository name. If this service lives in a separate GitHub repo, it will appear here automatically once the exporter runs.` },
    demo: { bg: '#fff8e1', border: '#ffe082', color: '#7c6000',
      text: `📊 Demo data — Prometheus is unreachable or the DORA exporter hasn't run yet. Start the cluster and ensure GITHUB_TOKEN is set in local/.env.` },
  };

  return (
    <Content>
      {loading && <CircularProgress style={{ margin: 24 }} />}
      {!loading && metrics && (
        <>
          {/* Always show the data source banner */}
          {(() => { const b = bannerProps[dataSource]; return (
            <Paper style={{ padding: '8px 16px', marginBottom: 16, background: b.bg, border: `1px solid ${b.border}` }}>
              <Typography variant="body2" style={{ color: b.color }}>{b.text}</Typography>
            </Paper>
          ); })()}
          <Box display="flex" style={{ gap: 16, flexWrap: 'wrap', marginBottom: 24 }}>
            {CARDS.map(({ key, title, unit }) => {
              const m = metrics[key];
              const v = isNaN(m.value) ? (key === 'cfr' ? 0 : key === 'freq' ? 0.1 : 60) : m.value;
              const band = doraBand(key, v);
              return <DoraMetricCard key={key} title={title} value={v} unit={unit} series={m.series.length ? m.series : [v]} band={band} metricKey={key} />;
            })}
          </Box>
          <Paper style={{ padding: 16 }}>
            <Typography variant="h6" gutterBottom>Performance Bands</Typography>
            <MuiTable size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Metric</TableCell>
                  <TableCell><span style={{ background: '#1b5e20', color: '#fff', padding: '2px 8px', borderRadius: 12, fontSize: 11 }}>Elite</span></TableCell>
                  <TableCell><span style={{ background: '#388e3c', color: '#fff', padding: '2px 8px', borderRadius: 12, fontSize: 11 }}>High</span></TableCell>
                  <TableCell><span style={{ background: '#f57c00', color: '#fff', padding: '2px 8px', borderRadius: 12, fontSize: 11 }}>Medium</span></TableCell>
                  <TableCell><span style={{ background: '#c62828', color: '#fff', padding: '2px 8px', borderRadius: 12, fontSize: 11 }}>Low</span></TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {[
                  ['Deploy Frequency', '>1/day', '1/week', '1/month', '<1/month'],
                  ['Lead Time',        '<1 hour', '<1 day', '<1 week', '>1 week'],
                  ['Change Fail Rate', '0–5%',   '5–15%', '15–45%', '>45%'],
                  ['MTTR',             '<1 hour', '<1 day', '<1 week', '>1 week'],
                ].map(([metric, elite, high, med, low]) => (
                  <TableRow key={metric}>
                    <TableCell style={{ fontWeight: 600 }}>{metric}</TableCell>
                    <TableCell>{elite}</TableCell><TableCell>{high}</TableCell>
                    <TableCell>{med}</TableCell><TableCell>{low}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </MuiTable>
          </Paper>
        </>
      )}
    </Content>
  );
}

const doraEntityContent = EntityContentBlueprint.make({
  name: 'dora-metrics',
  params: {
    path: '/dora',
    title: 'DORA',
    filter: 'kind:component',
    loader: async () => <DoraEntityContent />,
  },
});

// ── Team Budget entity tab (kind:group) ───────────────────────────────────────
// Reads idp.io/cost-budget-monthly-usd and idp.io/cost-namespace annotations.
// Queries Prometheus for actual spend and utilization ratio pushed by tech-insights-exporter.

function TeamBudgetEntityContent() {
  const { entity } = useEntity();
  const fetchApi  = useApi(fetchApiRef);
  const configApi = useApi(configApiRef);
  const base = configApi.getString('backend.baseUrl');

  const teamName   = entity.metadata.name;
  const budgetStr  = (entity.metadata.annotations as Record<string, string> | undefined)?.['idp.io/cost-budget-monthly-usd'];
  const namespaces = (entity.metadata.annotations as Record<string, string> | undefined)?.['idp.io/cost-namespace'];
  const budget     = budgetStr ? parseFloat(budgetStr) : null;

  const [actual, setActual]   = useState<number | null>(null);
  const [ratio, setRatio]     = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [noData, setNoData]   = useState(false);

  useEffect(() => {
    const promQuery = (expr: string) =>
      fetchApi.fetch(`${base}/api/proxy/prometheus/api/v1/query?query=${encodeURIComponent(expr)}`)
        .then(r => r.ok ? r.json() : Promise.reject(r.status))
        .then((d: any) => {
          const val = d?.data?.result?.[0]?.value?.[1];
          return val != null ? parseFloat(val) : NaN;
        });

    Promise.all([
      promQuery(`idp_team_actual_cost_usd_monthly{team="${teamName}"}`),
      promQuery(`idp_team_budget_utilization_ratio{team="${teamName}"}`),
    ])
      .then(([a, r]) => {
        if (!isNaN(a)) setActual(a);
        if (!isNaN(r)) setRatio(r);
        setNoData(isNaN(a));
        setLoading(false);
      })
      .catch(() => { setNoData(true); setLoading(false); });
  }, [base, fetchApi, teamName]);

  const utilization = ratio ?? (budget != null && actual != null ? actual / budget : null);
  const pct = utilization != null ? Math.round(utilization * 100) : null;
  const barColor = pct == null ? '#9e9e9e' : pct >= 100 ? '#f44336' : pct >= 80 ? '#ff9800' : '#4caf50';
  const remaining = budget != null && actual != null ? budget - actual : null;

  return (
    <Content>
      {loading && <Progress />}
      {!loading && (
        <>
          {!budgetStr && (
            <Paper style={{ padding: 16, marginBottom: 16, background: '#fff8e1', border: '1px solid #ffe082' }}>
              <Typography variant="body2" style={{ color: '#7c6000' }}>
                No budget set for this team. Add the annotation{' '}
                <code>idp.io/cost-budget-monthly-usd</code> to this Group entity.
              </Typography>
            </Paper>
          )}
          {noData && budgetStr && (
            <Paper style={{ padding: 16, marginBottom: 16, background: '#e3f2fd', border: '1px solid #90caf9' }}>
              <Typography variant="body2" style={{ color: '#0d47a1' }}>
                Budget configured at <strong>${budget?.toFixed(0)}/month</strong>. Actual spend metrics are
                pushed every 15 min by tech-insights-exporter once OpenCost is running.
              </Typography>
            </Paper>
          )}

          <Box display="flex" style={{ gap: 16, flexWrap: 'wrap', marginBottom: 24 }}>
            <Paper style={{ padding: 16, minWidth: 260, flex: 2 }}>
              <Typography variant="caption" style={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, color: '#666' }}>
                Monthly Budget
              </Typography>
              <Box display="flex" justifyContent="space-between" alignItems="center" mt={1} mb={1}>
                <Typography variant="h4" style={{ fontWeight: 700 }}>
                  {budgetStr ? `$${budget?.toFixed(0)}` : '—'}
                </Typography>
                {pct != null && (
                  <Chip label={`${pct}% used`} style={{ backgroundColor: barColor, color: 'white', fontWeight: 700 }} />
                )}
              </Box>
              {pct != null && (
                <div style={{ height: 12, borderRadius: 6, background: '#eee', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${Math.min(pct, 100)}%`, background: barColor, borderRadius: 6, transition: 'width 0.4s ease' }} />
                </div>
              )}
            </Paper>

            <Paper style={{ padding: 16, minWidth: 140, flex: 1 }}>
              <Typography variant="caption" style={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, color: '#666' }}>
                Actual (MTD)
              </Typography>
              <Typography variant="h4" style={{ fontWeight: 700, marginTop: 8 }}>
                {actual != null ? `$${actual.toFixed(2)}` : '—'}
              </Typography>
              <Typography variant="caption" color="textSecondary">month-to-date</Typography>
            </Paper>

            <Paper style={{ padding: 16, minWidth: 140, flex: 1 }}>
              <Typography variant="caption" style={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, color: '#666' }}>
                Remaining
              </Typography>
              <Typography variant="h4" style={{ fontWeight: 700, marginTop: 8, color: remaining != null && remaining < 0 ? '#f44336' : '#1b5e20' }}>
                {remaining != null
                  ? remaining >= 0 ? `$${remaining.toFixed(2)}` : `-$${Math.abs(remaining).toFixed(2)}`
                  : '—'}
              </Typography>
              <Typography variant="caption" color="textSecondary">
                {remaining != null && remaining < 0 ? 'over budget' : 'available'}
              </Typography>
            </Paper>
          </Box>

          <Paper style={{ padding: 16 }}>
            <Typography variant="subtitle1" gutterBottom>Budget Configuration</Typography>
            <MuiTable size="small">
              <TableBody>
                <TableRow>
                  <TableCell style={{ fontWeight: 600, width: 200 }}>Team</TableCell>
                  <TableCell><code>{teamName}</code></TableCell>
                </TableRow>
                <TableRow>
                  <TableCell style={{ fontWeight: 600 }}>Monthly budget</TableCell>
                  <TableCell>{budgetStr ? `$${budget?.toFixed(2)} USD` : <em style={{ color: '#9e9e9e' }}>Not configured</em>}</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell style={{ fontWeight: 600 }}>Cost namespaces</TableCell>
                  <TableCell>
                    {namespaces
                      ? namespaces.split(',').map((ns: string) => (
                          <Chip key={ns} label={ns.trim()} size="small" style={{ marginRight: 4, marginBottom: 2 }} />
                        ))
                      : <em style={{ color: '#9e9e9e' }}>Not configured</em>}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell style={{ fontWeight: 600 }}>Alert thresholds</TableCell>
                  <TableCell>Warning at 80% · Critical at 100%</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell style={{ fontWeight: 600 }}>Data source</TableCell>
                  <TableCell>OpenCost → Pushgateway (every 15 min)</TableCell>
                </TableRow>
              </TableBody>
            </MuiTable>
          </Paper>
          <Box mt={2}>
            <Typography variant="caption" color="textSecondary">
              Annotations: <code>idp.io/cost-budget-monthly-usd</code> · <code>idp.io/cost-namespace</code> ·{' '}
              <Link href="https://github.com/moatazeldebsy/backstage-platform-template/blob/main/docs/dora-finops.md" target="_blank" rel="noopener">
                docs/dora-finops.md ↗
              </Link>
            </Typography>
          </Box>
        </>
      )}
    </Content>
  );
}

const teamBudgetEntityContent = EntityContentBlueprint.make({
  name: 'team-budget',
  params: {
    path: '/budget',
    title: 'Budget',
    filter: 'kind:group',
    loader: async () => <TeamBudgetEntityContent />,
  },
});

// ── SLO / Error Budget entity tab (kind:component) ────────────────────────────
// Reads idp.io/slo-availability-target and idp.io/slo-latency-target annotations.
// Queries Prometheus for Sloth-generated recording rules (sloth_slo_info +
// slo:slo_error_ratio:ratio_rate5m) to show live error budget gauges per SLO.

interface SlothSloInfo {
  sloth_id: string;
  sloth_slo: string;
  objective: string;
}

function SloGauge({ label, objective, errorRatio }: { label: string; objective: number; errorRatio: number | null }) {
  const errorBudget = 1 - objective / 100;
  const budgetRemaining = errorRatio != null && errorBudget > 0
    ? Math.max(0, (1 - errorRatio / errorBudget)) * 100
    : null;

  const color = budgetRemaining == null ? '#9e9e9e'
    : budgetRemaining > 50 ? '#4caf50'
    : budgetRemaining > 10 ? '#ff9800'
    : '#f44336';

  const status = budgetRemaining == null ? 'No data'
    : budgetRemaining > 50 ? 'Healthy'
    : budgetRemaining > 10 ? 'Burning fast'
    : 'Critical';

  return (
    <Paper style={{ padding: 16, flex: 1, minWidth: 200 }}>
      <Typography variant="caption" style={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, color: '#666' }}>
        {label}
      </Typography>
      <Box display="flex" alignItems="center" justifyContent="space-between" mt={1} mb={1}>
        <Typography variant="h4" style={{ fontWeight: 700 }}>
          {objective}%
        </Typography>
        <Chip label={status} style={{ backgroundColor: color, color: 'white', fontWeight: 700, fontSize: 11 }} />
      </Box>
      <Typography variant="caption" color="textSecondary" style={{ display: 'block', marginBottom: 6 }}>
        SLO target · error budget {errorBudget < 0.001 ? `${(errorBudget * 100).toFixed(3)}%` : `${(errorBudget * 100).toFixed(2)}%`}
      </Typography>
      {budgetRemaining != null && (
        <>
          <div style={{ height: 10, borderRadius: 5, background: '#eee', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${budgetRemaining}%`, background: color, borderRadius: 5, transition: 'width 0.4s ease' }} />
          </div>
          <Typography variant="caption" color="textSecondary" style={{ marginTop: 4, display: 'block' }}>
            {budgetRemaining.toFixed(1)}% error budget remaining
          </Typography>
        </>
      )}
    </Paper>
  );
}

function SloEntityContent() {
  const { entity } = useEntity();
  const fetchApi  = useApi(fetchApiRef);
  const configApi = useApi(configApiRef);
  const base = configApi.getString('backend.baseUrl');

  const annotations = entity.metadata.annotations as Record<string, string> | undefined;
  const slothService = annotations?.['idp.io/sloth-service'] ?? entity.metadata.name;
  const availTarget  = annotations?.['idp.io/slo-availability-target'];
  const latencyTarget = annotations?.['idp.io/slo-latency-target'];

  const [sloInfos, setSloInfos]   = useState<SlothSloInfo[]>([]);
  const [errorRatios, setRatios]  = useState<Record<string, number>>({});
  const [loading, setLoading]     = useState(true);
  const [hasSloth, setHasSloth]   = useState(false);

  useEffect(() => {
    const promQuery = (expr: string) =>
      fetchApi.fetch(`${base}/api/proxy/prometheus/api/v1/query?query=${encodeURIComponent(expr)}`)
        .then(r => r.ok ? r.json() : Promise.reject(r.status));

    (async () => {
      try {
        // Fetch SLO metadata from Sloth's info metric
        const infoResult = await promQuery(`sloth_slo_info{sloth_service="${slothService}"}`);
        const infos: SlothSloInfo[] = (infoResult?.data?.result ?? []).map((r: any) => ({
          sloth_id:  r.metric.sloth_id ?? '',
          sloth_slo: r.metric.sloth_slo ?? '',
          objective: r.metric.objective ?? '99',
        }));
        setSloInfos(infos);
        setHasSloth(infos.length > 0);

        // Fetch current error ratios for each SLO
        const ratioResult = await promQuery(`slo:slo_error_ratio:ratio_rate5m{sloth_service="${slothService}"}`);
        const ratios: Record<string, number> = {};
        for (const r of ratioResult?.data?.result ?? []) {
          const id = r.metric.sloth_id ?? '';
          ratios[id] = parseFloat(r.value?.[1] ?? 'NaN');
        }
        setRatios(ratios);
      } catch { /* Prometheus unreachable */ }
      setLoading(false);
    })();
  }, [base, fetchApi, slothService]);

  const annotationSlos = [
    availTarget  && { id: 'availability', label: 'Availability',      objective: parseFloat(availTarget) },
    latencyTarget && { id: 'latency',     label: 'Latency (p99<500ms)', objective: parseFloat(latencyTarget) },
  ].filter(Boolean) as { id: string; label: string; objective: number }[];

  // Merge: prefer live Sloth data; fall back to annotations
  const displaySlos: { id: string; label: string; objective: number }[] =
    hasSloth
      ? sloInfos.map(s => ({
          id:        s.sloth_id,
          label:     s.sloth_id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
          objective: parseFloat(s.objective),
        }))
      : annotationSlos;

  return (
    <Content>
      {loading && <Progress />}
      {!loading && (
        <>
          {!hasSloth && annotationSlos.length === 0 && (
            <Paper style={{ padding: 16, marginBottom: 16, background: '#fff8e1', border: '1px solid #ffe082' }}>
              <Typography variant="body2" style={{ color: '#7c6000' }}>
                No SLOs configured for this service. Use the{' '}
                <strong>SLO Definition</strong> template in the Backstage catalog to generate Sloth SLO manifests,
                or add annotations <code>idp.io/slo-availability-target</code> and <code>idp.io/slo-latency-target</code>.
              </Typography>
            </Paper>
          )}

          {!hasSloth && annotationSlos.length > 0 && (
            <Paper style={{ padding: '8px 16px', marginBottom: 16, background: '#e3f2fd', border: '1px solid #90caf9' }}>
              <Typography variant="body2" style={{ color: '#0d47a1' }}>
                SLO targets loaded from entity annotations. Live error budget data will appear once Sloth recording
                rules are applied to Prometheus (<code>sloth generate -i observability/slo/... | kubectl apply -f -</code>).
              </Typography>
            </Paper>
          )}

          {hasSloth && (
            <Paper style={{ padding: '8px 16px', marginBottom: 16, background: '#e8f5e9', border: '1px solid #a5d6a7' }}>
              <Typography variant="body2" style={{ color: '#1b5e20' }}>
                Live SLO data from Prometheus — Sloth recording rules active for <strong>{slothService}</strong>.
              </Typography>
            </Paper>
          )}

          {displaySlos.length > 0 && (
            <Box display="flex" style={{ gap: 16, flexWrap: 'wrap', marginBottom: 24 }}>
              {displaySlos.map(s => (
                <SloGauge
                  key={s.id}
                  label={s.label}
                  objective={s.objective}
                  errorRatio={errorRatios[s.id] ?? null}
                />
              ))}
            </Box>
          )}

          <Paper style={{ padding: 16 }}>
            <Typography variant="subtitle1" gutterBottom>SLO Configuration</Typography>
            <MuiTable size="small">
              <TableBody>
                <TableRow>
                  <TableCell style={{ fontWeight: 600, width: 200 }}>Service</TableCell>
                  <TableCell><code>{slothService}</code></TableCell>
                </TableRow>
                <TableRow>
                  <TableCell style={{ fontWeight: 600 }}>SLO engine</TableCell>
                  <TableCell>
                    <Link href="https://sloth.slok.dev" target="_blank" rel="noopener">Sloth ↗</Link>
                    {' '}(Prometheus multi-window burn-rate)
                  </TableCell>
                </TableRow>
                {availTarget && (
                  <TableRow>
                    <TableCell style={{ fontWeight: 600 }}>Availability target</TableCell>
                    <TableCell>{availTarget}% · error budget {(100 - parseFloat(availTarget)).toFixed(2)}%</TableCell>
                  </TableRow>
                )}
                {latencyTarget && (
                  <TableRow>
                    <TableCell style={{ fontWeight: 600 }}>Latency target</TableCell>
                    <TableCell>{latencyTarget}% requests under 500ms</TableCell>
                  </TableRow>
                )}
                <TableRow>
                  <TableCell style={{ fontWeight: 600 }}>Alert tiers</TableCell>
                  <TableCell>Page (critical burn rate) · Ticket (slow burn rate)</TableCell>
                </TableRow>
              </TableBody>
            </MuiTable>
          </Paper>
          <Box mt={2}>
            <Typography variant="caption" color="textSecondary">
              Annotations: <code>idp.io/slo-availability-target</code> · <code>idp.io/sloth-service</code> ·{' '}
              <Link href="https://github.com/moatazeldebsy/backstage-platform-template/blob/main/docs/sre-reliability.md" target="_blank" rel="noopener">
                docs/sre-reliability.md ↗
              </Link>
            </Typography>
          </Box>
        </>
      )}
    </Content>
  );
}

const sloEntityContent = EntityContentBlueprint.make({
  name: 'slo-error-budget',
  params: {
    path: '/slo',
    title: 'SLOs',
    filter: 'kind:component',
    loader: async () => <SloEntityContent />,
  },
});

// ── Plugin registration ────────────────────────────────────────────────────────
export const customPagesPlugin = createFrontendPlugin({
  pluginId: 'custom-pages',
  routes: {
    root: finOpsRouteRef,
  },
  extensions: [
    finOpsPage,
    finOpsNavItem,
    aiAssistantPage,
    aiAssistantNavItem,
    semanticSearchPage,
    semanticSearchNavItem,
    doraEntityContent,
    scorecardEntityContent,
    securityEntityContent,
    pagerDutyEntityContent,
    grafanaEntityContent,
    jiraEntityContent,
    teamBudgetEntityContent,
    sloEntityContent,
    copilotPage,
    copilotNavItem,
  ],
});
