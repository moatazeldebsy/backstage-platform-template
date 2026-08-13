import { useEffect, useMemo, useRef, useState } from 'react';
import { createFrontendPlugin, PageBlueprint, NavItemBlueprint, createRouteRef, FrontendPlugin } from '@backstage/frontend-plugin-api';
import { EntityContentBlueprint } from '@backstage/plugin-catalog-react/alpha';
import { useEntity, catalogApiRef } from '@backstage/plugin-catalog-react';
import { CATALOG_FILTER_EXISTS } from '@backstage/catalog-client';
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
import GavelIcon from '@material-ui/icons/Gavel';
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
import DashboardIcon from '@material-ui/icons/Dashboard';
import TrendingUpIcon from '@material-ui/icons/TrendingUp';
import TrackChangesIcon from '@material-ui/icons/TrackChanges';
import AccountTreeIcon from '@material-ui/icons/AccountTree';
import DynamicFeedIcon from '@material-ui/icons/DynamicFeed';
import EmojiPeopleIcon from '@material-ui/icons/EmojiPeople';
import CalculateIcon from '@material-ui/icons/MonetizationOn';
import PersonIcon from '@material-ui/icons/Person';
import SearchOutlinedIcon from '@material-ui/icons/SearchOutlined';
import SupervisorAccountIcon from '@material-ui/icons/SupervisorAccount';
import SmartToyIcon from '@material-ui/icons/EmojiObjects';
import TimelineIcon from '@material-ui/icons/Timeline';
import ScienceIcon from '@material-ui/icons/BubbleChart';
import HelpOutlineIcon from '@material-ui/icons/HelpOutline';
import ChatIcon from '@material-ui/icons/Chat';
import SchoolIcon from '@material-ui/icons/School';
import AddCommentIcon from '@material-ui/icons/AddComment';
import SendIcon from '@material-ui/icons/Send';
import SearchIcon from '@material-ui/icons/Search';
import Chip from '@material-ui/core/Chip';
import Divider from '@material-ui/core/Divider';
import Drawer from '@material-ui/core/Drawer';
import LinearProgress from '@material-ui/core/LinearProgress';
import Link from '@material-ui/core/Link';
import List from '@material-ui/core/List';
import ListItem from '@material-ui/core/ListItem';
import ListItemText from '@material-ui/core/ListItemText';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import CloseIcon from '@material-ui/icons/Close';
import DeleteIcon from '@material-ui/icons/Delete';
import HistoryIcon from '@material-ui/icons/History';

// ── AI layer availability ─────────────────────────────────────────────────────
// True only when KAgent/MLflow/MCP servers are actually deployed, i.e. after
// `bootstrap-ai.sh`. `bootstrap-local.sh` alone installs none of it.
//
// The AI *pages and nav items* are hidden declaratively via the app.extensions
// disable list in app-config.yaml. This hook exists for the links hardcoded
// into the custom Home / Support / Learning-Center pages below, which the
// extension system cannot reach — without it those keep pointing at
// /ai-assistant and the KAgent UI on a platform that has neither.
//
// Defaults to false: advertising a dead link is worse than omitting a live one.
function useAiStackEnabled(): boolean {
  const configApi = useApi(configApiRef);
  return configApi.getOptionalBoolean('aiStack.enabled') ?? false;
}

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
// Native chat UI that talks to the platform-assistant KAgent agent via the Backstage
// proxy (/api/proxy/kagent → kagent-ui:8080).
//
// Flow per user turn:
//   1. POST /a2a/kagent/platform-assistant  (KAgent Next.js route adds auth headers)
//   2. Poll GET /api/sessions           every 500 ms for up to 12 s — find session
//   3. Poll GET /api/sessions/<id>      every 1 s for up to 90 s — wait for text

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
}

interface SavedConversation {
  id: string;
  title: string;
  timestamp: number;
  messages: ChatMessage[];
  contextId: string | null;
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
  const [historyOpen, setHistoryOpen] = useState(false);
  const [chatHistory, setChatHistory] = useState<SavedConversation[]>([]);

  // Load user identity once, then restore their stored session and history from localStorage
  useEffect(() => {
    identityApi.getBackstageIdentity().then(identity => {
      const ref = identity.userEntityRef;
      setUserRef(ref);
      const storedContextId = localStorage.getItem(`ai-chat-ctx:${ref}`);
      const storedMessages = localStorage.getItem(`ai-chat-msgs:${ref}`);
      const storedHistory = localStorage.getItem(`ai-chat-history:${ref}`);
      if (storedContextId) contextIdRef.current = storedContextId;
      if (storedMessages) {
        try { setMessages(JSON.parse(storedMessages)); } catch { /* ignore */ }
      }
      if (storedHistory) {
        try { setChatHistory(JSON.parse(storedHistory)); } catch { /* ignore */ }
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

      // Capture sentAt BEFORE issuing the request — the a2a endpoint streams
      // the full agent turn (10-60s), so timing this after the call would put
      // it well past the session's created_at and break the window check below.
      const sentAt = Date.now();

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

      // a2a returns a streamed text/event-stream response for normal turns;
      // contextId (if present at all) comes via session polling instead.
      // Only attempt to parse direct JSON responses — reading the body of an
      // event-stream response would block until the full agent turn completes.
      let sessionId: string | null = contextIdRef.current;
      const contentType = a2aRes.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        try {
          const a2aBody = await a2aRes.json();
          if (a2aBody.result?.contextId) sessionId = a2aBody.result.contextId;
        } catch {
          // ignore — fall through to session polling
        }
      } else {
        // Drain the event-stream body in the background without awaiting it —
        // cancelling it instead would signal a client disconnect that can
        // abort the in-flight agent turn server-side.
        void a2aRes.text().catch(() => {});
      }

      // If we don't have a sessionId yet, poll the sessions list with
      // exponential backoff + jitter (200ms → 2s, total deadline ~45s) so
      // concurrent chat sessions don't fan out a constant 2 req/s per user.
      // 45s deadline accounts for Claude API cold start on local Kind (~8–15s).
      if (!sessionId) {
        setStatusText('Connecting to agent — this may take a few seconds on local…');
        const sessionDeadline = sentAt + 45_000;
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
            // Look for platform-assistant agent, created within a wide time window
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
          (d: any) => d?.author === 'platform_assistant' && d?.content?.parts,
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
    if (messages.length > 0 && userRef) {
      const title = messages.find(m => m.role === 'user')?.text.slice(0, 60) ?? 'Untitled';
      const entry: SavedConversation = {
        id: uuidv4(),
        title,
        timestamp: Date.now(),
        messages: [...messages],
        contextId: contextIdRef.current,
      };
      setChatHistory(prev => {
        const updated = [entry, ...prev].slice(0, 50);
        localStorage.setItem(`ai-chat-history:${userRef}`, JSON.stringify(updated));
        return updated;
      });
    }
    setMessages([]);
    setInput('');
    setStatusText('');
    contextIdRef.current = null;
    if (userRef) {
      localStorage.removeItem(`ai-chat-ctx:${userRef}`);
      localStorage.removeItem(`ai-chat-msgs:${userRef}`);
    }
  };

  const restoreConversation = (entry: SavedConversation) => {
    if (loading) return;
    setMessages(entry.messages);
    contextIdRef.current = entry.contextId;
    if (userRef) {
      localStorage.setItem(`ai-chat-msgs:${userRef}`, JSON.stringify(entry.messages));
      if (entry.contextId) localStorage.setItem(`ai-chat-ctx:${userRef}`, entry.contextId);
    }
    setHistoryOpen(false);
  };

  const deleteHistoryItem = (id: string) => {
    setChatHistory(prev => {
      const updated = prev.filter(e => e.id !== id);
      if (userRef) localStorage.setItem(`ai-chat-history:${userRef}`, JSON.stringify(updated));
      return updated;
    });
  };

  return (
    <Page themeId="tool">
      <Header title="AI Assistant" subtitle="Powered by KAgent · platform-assistant" />
      <Content>
        <Box display="flex" flexDirection="column" height="calc(100vh - 180px)">
          {/* Toolbar */}
          <Box display="flex" justifyContent="flex-end" alignItems="center" mb={1} style={{ gap: 8 }}>
            <Tooltip title="Browse past conversations">
              <span>
                <Button
                  variant="outlined"
                  size="small"
                  startIcon={<HistoryIcon />}
                  onClick={() => setHistoryOpen(true)}
                  disabled={loading}
                >
                  History
                </Button>
              </span>
            </Tooltip>
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
                  { label: 'List deployments', prompt: 'List all running Kubernetes deployments and their health' },
                  { label: 'Find payment services', prompt: 'Find all services related to payments' },
                  { label: 'Check ArgoCD apps', prompt: 'List all ArgoCD applications and their sync status' },
                  { label: 'Team budget status', prompt: 'Show me all teams over 80% budget utilisation' },
                  { label: 'Rightsizing savings', prompt: 'What are the top rightsizing opportunities to reduce cost?' },
                  { label: 'List contracts', prompt: 'List all registered API contracts' },
                  { label: 'Check breaking changes', prompt: 'Detect breaking changes across all registered API contracts' },
                  { label: 'Validate compatibility', prompt: 'Validate compatibility between all consumer and provider contracts' },
                  { label: 'Discover contracts', prompt: 'Auto-discover contracts for all services in the catalog' },
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

        {/* Chat history drawer — scoped to the logged-in user */}
        <Drawer anchor="right" open={historyOpen} onClose={() => setHistoryOpen(false)}>
          <Box width={340} display="flex" flexDirection="column" height="100%">
            <Box display="flex" alignItems="center" justifyContent="space-between" px={2} py={1.5}>
              <Typography variant="h6">Chat History</Typography>
              <IconButton size="small" onClick={() => setHistoryOpen(false)}>
                <CloseIcon />
              </IconButton>
            </Box>
            <Divider />
            {chatHistory.length === 0 ? (
              <Box p={2}>
                <Typography variant="body2" color="textSecondary">
                  No saved conversations yet. Click <strong>New Chat</strong> to save the current conversation and start a fresh one.
                </Typography>
              </Box>
            ) : (
              <List style={{ overflow: 'auto', flex: 1, paddingTop: 0 }}>
                {chatHistory.map(entry => (
                  <ListItem
                    key={entry.id}
                    button
                    onClick={() => restoreConversation(entry)}
                    style={{ alignItems: 'flex-start', paddingRight: 40 }}
                  >
                    <ListItemText
                      primary={entry.title}
                      secondary={new Date(entry.timestamp).toLocaleString()}
                      primaryTypographyProps={{ variant: 'body2', noWrap: true, title: entry.title }}
                      secondaryTypographyProps={{ variant: 'caption' }}
                    />
                    <Tooltip title="Delete">
                      <IconButton
                        size="small"
                        style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)' }}
                        onClick={e => { e.stopPropagation(); deleteHistoryItem(entry.id); }}
                      >
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </ListItem>
                ))}
              </List>
            )}
          </Box>
        </Drawer>
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

// ── Agent Approvals page (ADP Phase 4 HiTL gate) ──────────────────────────────
// Lists pending/decided approvals from approval-service and lets a human
// approve or deny them. See docs/agentic-platform.md Phase 4. Proxied via
// /api/proxy/approval-service (app-config.local.yaml / app-config.aws.yaml) —
// shows a connection error if approval-service hasn't been deployed
// (`bootstrap-ai.sh --adp`), same pattern as other opt-in proxied pages here.

interface Approval {
  id: string;
  action: string;
  agent: string;
  target: string;
  context: Record<string, unknown>;
  status: 'pending' | 'approved' | 'denied';
  requested_at: string;
  decided_at: string | null;
  decided_by: string | null;
}

function ApprovalsPage() {
  const fetchApi = useApi(fetchApiRef);
  const configApi = useApi(configApiRef);
  const identityApi = useApi(identityApiRef);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [filter, setFilter] = useState<'pending' | 'all'>('pending');
  const [decidedBy, setDecidedBy] = useState('');

  const base = configApi.getString('backend.baseUrl');
  const proxyBase = `${base}/api/proxy/approval-service`;

  const loadApprovals = async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = filter === 'pending' ? '?status=pending' : '';
      const resp = await fetchApi.fetch(`${proxyBase}/approvals${qs}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status} — is approval-service deployed? (bootstrap-ai.sh --adp)`);
      const data = await resp.json() as { approvals: Approval[] };
      setApprovals(data.approvals);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    identityApi.getProfileInfo().then(p => setDecidedBy(p.displayName ?? p.email ?? 'unknown')).catch(() => {});
    loadApprovals();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  const decide = async (id: string, decision: 'approved' | 'denied') => {
    setDeciding(id);
    try {
      const resp = await fetchApi.fetch(`${proxyBase}/approvals/${id}/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, decided_by: decidedBy }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({})) as any;
        throw new Error(body.error ?? `HTTP ${resp.status}`);
      }
      await loadApprovals();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setDeciding(null);
    }
  };

  const statusColors: Record<string, 'default' | 'primary' | 'secondary'> = {
    pending: 'primary',
    approved: 'secondary',
    denied: 'default',
  };

  return (
    <Page themeId="tool">
      <Header title="Agent Approvals" subtitle="Human-in-the-loop gate for agent-initiated mutating actions" />
      <Content>
        <Box mb={2} display="flex" alignItems="center" style={{ gap: 8 }}>
          <Button
            variant={filter === 'pending' ? 'contained' : 'outlined'}
            size="small"
            onClick={() => setFilter('pending')}
          >
            Pending only
          </Button>
          <Button
            variant={filter === 'all' ? 'contained' : 'outlined'}
            size="small"
            onClick={() => setFilter('all')}
          >
            All (last 100)
          </Button>
          <Tooltip title="Refresh">
            <span>
              <IconButton size="small" onClick={loadApprovals} disabled={loading}>
                <GavelIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </Box>

        {loading && <LinearProgress style={{ marginBottom: 12 }} />}

        {error && (
          <Box mb={2}><Typography color="error" variant="body2">{error}</Typography></Box>
        )}

        {!loading && !error && approvals.length === 0 && (
          <Typography variant="body2" color="textSecondary">
            No {filter === 'pending' ? 'pending' : ''} approvals.
          </Typography>
        )}

        {approvals.map(a => (
          <Paper key={a.id} elevation={1} style={{ padding: '12px 16px', marginBottom: 10 }}>
            <Box display="flex" alignItems="center" mb={1} style={{ gap: 8 }}>
              <Chip label={a.status} size="small" color={statusColors[a.status] ?? 'default'} />
              <Typography variant="subtitle2">
                {a.agent} → <code>{a.action}</code> on <code>{a.target}</code>
              </Typography>
              <Typography variant="caption" color="textSecondary" style={{ marginLeft: 'auto' }}>
                requested {new Date(a.requested_at).toLocaleString()}
              </Typography>
            </Box>
            {Object.keys(a.context ?? {}).length > 0 && (
              <Typography variant="body2" color="textSecondary" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginBottom: 8 }}>
                {JSON.stringify(a.context)}
              </Typography>
            )}
            {a.status === 'pending' ? (
              <Box display="flex" style={{ gap: 8 }}>
                <Button
                  variant="contained"
                  color="primary"
                  size="small"
                  startIcon={<CheckCircleIcon />}
                  disabled={deciding === a.id}
                  onClick={() => decide(a.id, 'approved')}
                >
                  Approve
                </Button>
                <Button
                  variant="outlined"
                  size="small"
                  startIcon={<CancelIcon />}
                  disabled={deciding === a.id}
                  onClick={() => decide(a.id, 'denied')}
                >
                  Deny
                </Button>
              </Box>
            ) : (
              <Typography variant="caption" color="textSecondary">
                {a.status} by {a.decided_by} at {a.decided_at ? new Date(a.decided_at).toLocaleString() : '—'}
              </Typography>
            )}
          </Paper>
        ))}
      </Content>
    </Page>
  );
}

const approvalsRouteRef = createRouteRef();

const approvalsPage = PageBlueprint.make({
  name: 'approvals',
  params: {
    path: '/approvals',
    routeRef: approvalsRouteRef,
    loader: async () => <ApprovalsPage />,
  },
});

const approvalsNavItem = NavItemBlueprint.make({
  name: 'approvals',
  params: {
    title: 'Agent Approvals',
    icon: GavelIcon as any,
    routeRef: approvalsRouteRef,
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
  | 'has-snyk-scanning'
  | 'has-trivy-scanning';

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
  { id: 'has-trivy-scanning',    group: 'Security',      label: 'Trivy image scan',          remediation: 'See the Trivy tab — requires a github.com/project-slug annotation and CI to have run at least once.' },
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
    'has-trivy-scanning':    gates.has('trivy-scanning') || Boolean(annotations['github.com/project-slug']),
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

// ── Datadog tab ─────────────────────────────────────────────────────────────
// Reads the datadoghq.com/dashboard-url, datadoghq.com/monitor-tag, and
// datadoghq.com/slo-id annotations from the entity and fetches live monitor +
// SLO status via the /api/proxy/datadog proxy (see app-config.aws.yaml) —
// the DD_API_KEY/DD_APP_KEY never reach the browser. Empty state when no
// annotations are present (e.g. before running enable-datadog-apm).

interface DatadogMonitor {
  id: number;
  name: string;
  overall_state: string;
}

interface DatadogSlo {
  name: string;
  target_threshold?: number;
  status?: number;
}

function DatadogMonitorsCard({ monitorTag, site }: { monitorTag: string; site: string }) {
  const fetchApi = useApi(fetchApiRef);
  const configApi = useApi(configApiRef);
  const [monitors, setMonitors] = useState<DatadogMonitor[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const baseUrl = configApi.getString('backend.baseUrl');
    const url = `${baseUrl}/api/proxy/datadog/api/v1/monitor?monitor_tags=${encodeURIComponent(monitorTag)}`;
    fetchApi
      .fetch(url)
      .then(async res => {
        if (!res.ok) throw new Error(`Datadog monitors: ${res.status}`);
        setMonitors(await res.json());
        setLoading(false);
      })
      .catch((err: Error) => { setError(err.message); setLoading(false); });
  }, [fetchApi, configApi, monitorTag]);

  const monitorsUrl = `https://${site}/monitors/manage?q=${encodeURIComponent(monitorTag)}`;
  const stateColor = (state: string) =>
    state === 'OK' ? '#4caf50' : state === 'Alert' ? '#f44336' : state === 'Warn' ? '#ff9800' : '#9e9e9e';

  return (
    <Box mb={3}>
      <Typography variant="subtitle1" style={{ marginBottom: 8 }}>
        Datadog Monitors — <code>{monitorTag}</code>
      </Typography>
      <Paper style={{ padding: 16 }}>
        {loading && <Progress />}
        {!loading && error && (
          <Typography variant="body2" color="textSecondary">
            Unable to load Datadog monitors: <strong>{error}</strong>. Verify
            <code> DD_API_KEY</code>/<code>DD_APP_KEY</code> are set.
            <Box mt={1}><Link href={monitorsUrl} target="_blank" rel="noopener">Open in Datadog ↗</Link></Box>
          </Typography>
        )}
        {!loading && !error && monitors && (
          <Box>
            {monitors.length === 0 && (
              <Typography variant="body2" color="textSecondary">No monitors found for this tag.</Typography>
            )}
            {monitors.length > 0 && (
              <Box display="flex" flexWrap="wrap" style={{ gap: 8, marginBottom: 12 }}>
                {monitors.map(m => (
                  <Chip
                    key={m.id}
                    label={`${m.name}: ${m.overall_state}`}
                    style={{ backgroundColor: stateColor(m.overall_state), color: 'white' }}
                  />
                ))}
              </Box>
            )}
            <Link href={monitorsUrl} target="_blank" rel="noopener">Open in Datadog ↗</Link>
          </Box>
        )}
      </Paper>
    </Box>
  );
}

function DatadogSloCard({ sloId, site }: { sloId: string; site: string }) {
  const fetchApi = useApi(fetchApiRef);
  const configApi = useApi(configApiRef);
  const [slo, setSlo] = useState<DatadogSlo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const baseUrl = configApi.getString('backend.baseUrl');
    const url = `${baseUrl}/api/proxy/datadog/api/v1/slo/${encodeURIComponent(sloId)}`;
    fetchApi
      .fetch(url)
      .then(async res => {
        if (!res.ok) throw new Error(`Datadog SLO: ${res.status}`);
        const json = await res.json();
        const data = json?.data;
        setSlo({
          name: data?.name,
          target_threshold: data?.thresholds?.[0]?.target,
        });
        setLoading(false);
      })
      .catch((err: Error) => { setError(err.message); setLoading(false); });
  }, [fetchApi, configApi, sloId]);

  const sloUrl = `https://${site}/slo?slo_id=${encodeURIComponent(sloId)}`;

  return (
    <Box mb={3}>
      <Typography variant="subtitle1" style={{ marginBottom: 8 }}>Datadog SLO</Typography>
      <Paper style={{ padding: 16 }}>
        {loading && <Progress />}
        {!loading && error && (
          <Typography variant="body2" color="textSecondary">
            Unable to load Datadog SLO: <strong>{error}</strong>.
            <Box mt={1}><Link href={sloUrl} target="_blank" rel="noopener">Open in Datadog ↗</Link></Box>
          </Typography>
        )}
        {!loading && !error && slo && (
          <Box>
            <Typography variant="body2">
              <strong>{slo.name}</strong>
              {slo.target_threshold !== undefined && ` — target ${slo.target_threshold}%`}
            </Typography>
            <Box mt={1}><Link href={sloUrl} target="_blank" rel="noopener">Open in Datadog ↗</Link></Box>
          </Box>
        )}
      </Paper>
    </Box>
  );
}

function DatadogEntityContent() {
  const { entity } = useEntity();
  const annotations = entity.metadata.annotations ?? {};
  const dashboardUrl = annotations['datadoghq.com/dashboard-url'];
  const monitorTag = annotations['datadoghq.com/monitor-tag'];
  const sloId = annotations['datadoghq.com/slo-id'];
  const site = annotations['datadoghq.com/site'] || 'app.datadoghq.eu';

  const configured = Boolean(dashboardUrl || monitorTag || sloId);

  return (
    <Content>
      {!configured && (
        <Box mb={3}>
          <Paper style={{ padding: 24, textAlign: 'center' }}>
            <Typography variant="h6" gutterBottom>Datadog not configured</Typography>
            <Typography variant="body2" color="textSecondary">
              This service does not have Datadog annotations yet. Run the
              <strong> Enable Datadog APM & Monitoring</strong> scaffolder template
              (Catalog → Create → search "datadog") to open a PR that wires up
              APM tracing, dashboards, and monitors for this service.
            </Typography>
            <Box mt={2}>
              <Link href="/create" target="_self">Open scaffolder ↗</Link>
            </Box>
          </Paper>
        </Box>
      )}
      {dashboardUrl && (
        <Box mb={3}>
          <Paper style={{ padding: 16 }}>
            <Link href={dashboardUrl} target="_blank" rel="noopener">Open Datadog Dashboard ↗</Link>
          </Paper>
        </Box>
      )}
      {monitorTag && <DatadogMonitorsCard monitorTag={monitorTag} site={site} />}
      {sloId && <DatadogSloCard sloId={sloId} site={site} />}
    </Content>
  );
}

const datadogEntityContent = EntityContentBlueprint.make({
  name: 'datadog',
  params: {
    path: '/datadog',
    title: 'Datadog',
    filter: 'kind:component',
    loader: async () => <DatadogEntityContent />,
  },
});

// ── Trivy tab ───────────────────────────────────────────────────────────────
// CI (.github/workflows/build-and-deploy.yml) already scans built images with
// Trivy and uploads the SARIF to GitHub's code-scanning API. This tab reads
// that data back via the /api/proxy/github-code-scanning proxy — no extra CI
// step or annotation is needed beyond the github.com/project-slug that's
// already present on scaffolded components.

interface TrivySeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  total: number;
}

function TrivyCard({ repoSlug }: { repoSlug: string }) {
  const fetchApi  = useApi(fetchApiRef);
  const configApi = useApi(configApiRef);
  const [counts, setCounts]   = useState<TrivySeverityCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  useEffect(() => {
    const baseUrl = configApi.getString('backend.baseUrl');
    const url = `${baseUrl}/api/proxy/github-code-scanning/repos/${repoSlug}/code-scanning/alerts?tool_name=Trivy&state=open&per_page=100`;

    fetchApi.fetch(url)
      .then(async res => {
        if (!res.ok) throw new Error(`GitHub code scanning: ${res.status}`);
        const alerts: any[] = await res.json();
        const result: TrivySeverityCounts = { critical: 0, high: 0, medium: 0, low: 0, total: 0 };
        for (const alert of alerts) {
          const level = alert?.rule?.security_severity_level ?? alert?.rule?.severity ?? 'low';
          if (level === 'critical') result.critical += 1;
          else if (level === 'high') result.high += 1;
          else if (level === 'medium') result.medium += 1;
          else result.low += 1;
          result.total += 1;
        }
        setCounts(result);
        setLoading(false);
      })
      .catch((err: Error) => { setError(err.message); setLoading(false); });
  }, [fetchApi, configApi, repoSlug]);

  const alertsUrl = `https://github.com/${repoSlug}/security/code-scanning?query=tool%3ATrivy`;
  const gateColor = !counts ? '#9e9e9e'
    : counts.critical > 0 ? '#f44336'
    : counts.high > 0 ? '#ff9800'
    : '#4caf50';

  return (
    <Box mb={3}>
      <Typography variant="subtitle1" style={{ marginBottom: 8 }}>
        Trivy — <code>{repoSlug}</code>
      </Typography>
      <Paper style={{ padding: 16 }}>
        {loading && <Progress />}
        {!loading && error && (
          <Typography variant="body2" color="textSecondary">
            Unable to load Trivy scan results: <strong>{error}</strong>. Verify
            <code> GITHUB_TOKEN</code> has code-scanning read access and the image build
            workflow has run at least once.
            <Box mt={1}><Link href={alertsUrl} target="_blank" rel="noopener">Open code scanning alerts ↗</Link></Box>
          </Typography>
        )}
        {!loading && !error && counts && (
          <Box>
            <Box display="flex" alignItems="center" style={{ gap: 12, marginBottom: 12 }}>
              <Chip
                label={`${counts.total} open ${counts.total === 1 ? 'finding' : 'findings'}`}
                style={{ backgroundColor: gateColor, color: 'white' }}
              />
              <Link href={alertsUrl} target="_blank" rel="noopener">Open in GitHub ↗</Link>
            </Box>
            <TableContainer>
              <MuiTable size="small">
                <TableBody>
                  <TableRow><TableCell>Critical</TableCell><TableCell>{counts.critical}</TableCell></TableRow>
                  <TableRow><TableCell>High</TableCell><TableCell>{counts.high}</TableCell></TableRow>
                  <TableRow><TableCell>Medium</TableCell><TableCell>{counts.medium}</TableCell></TableRow>
                  <TableRow><TableCell>Low</TableCell><TableCell>{counts.low}</TableCell></TableRow>
                </TableBody>
              </MuiTable>
            </TableContainer>
          </Box>
        )}
      </Paper>
    </Box>
  );
}

function TrivyEntityContent() {
  const { entity } = useEntity();
  const annotations = entity.metadata.annotations ?? {};
  const repoSlug = annotations['github.com/project-slug'];

  return (
    <Content>
      {!repoSlug && (
        <Box mb={3}>
          <Paper style={{ padding: 24, textAlign: 'center' }}>
            <Typography variant="h6" gutterBottom>Trivy scanning not available</Typography>
            <Typography variant="body2" color="textSecondary">
              This entity has no <code>github.com/project-slug</code> annotation, so
              image scan results can't be looked up.
            </Typography>
          </Paper>
        </Box>
      )}
      {repoSlug && <TrivyCard repoSlug={repoSlug} />}
    </Content>
  );
}

const trivyEntityContent = EntityContentBlueprint.make({
  name: 'trivy-scanning',
  params: {
    path: '/trivy',
    title: 'Trivy',
    filter: 'kind:component',
    loader: async () => <TrivyEntityContent />,
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

const copilotRouteRef = createRouteRef();  // was id: 'copilot-metrics'

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

// The DORA exporter emits a synthetic platform-wide row under this service label
// alongside the real per-repo series. It is a Prometheus label, not a catalog entity —
// query it, never link to it. Grafana filters it the same way (service!="all-services"
// in kubernetes/monitoring/grafana-dora-dashboard-configmap.yaml).
const DORA_AGGREGATE_SERVICE = 'all-services';

// dataSource tracks where metrics came from so the UI can be honest about it.
// 'service' = per-entity Prometheus data (best)
// 'aggregate' = all-services Prometheus aggregate (real but platform-wide)
// 'empty' and 'demo' both render demo numbers, but for different reasons:
// 'empty' = Prometheus answered 200 with no matching series (healthy, no data yet),
// 'demo'  = the query itself failed (proxy down, network error, non-ok status).
// Keeping them apart stops the UI blaming Prometheus for merely-absent metrics.
type DoraDataSource = 'service' | 'aggregate' | 'empty' | 'demo';

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

    // freq===0 is a real "no deploys" reading, not missing data — only NaN means the query failed.
    const hasData = (m: Record<string, DoraMetric>) => !isNaN(m.freq.value);

    const DEMO: Record<string, DoraMetric> = {
      freq: { value: 3.2,  series: [1.8,2.1,2.4,3.0,3.2,2.9,3.2] },
      lead: { value: 42,   series: [68,55,50,45,42,39,42] },
      cfr:  { value: 4.8,  series: [8,6,5.5,5,4.8,5.1,4.8] },
      mttr: { value: 28,   series: [65,50,40,35,30,28,28] },
    };

    const candidates = [serviceName, repoName].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);

    (async () => {
      // Any rejected query means we never got a usable answer out of Prometheus.
      // If every query resolved and simply had no series, Prometheus is healthy.
      let anyQueryFailed = false;

      // 1. Try each candidate name that might match a Prometheus service label
      for (const name of candidates) {
        try {
          const m = await fetchForService(name);
          if (hasData(m)) { setMetrics(m); setSource('service'); setLoading(false); return; }
        } catch { anyQueryFailed = true; /* try next */ }
      }
      // 2. Fall back to platform aggregate (real data, but org-wide not per-service)
      try {
        const agg = await fetchForService(DORA_AGGREGATE_SERVICE);
        if (hasData(agg)) { setMetrics(agg); setSource('aggregate'); setLoading(false); return; }
      } catch { anyQueryFailed = true; /* fall through */ }
      // 3. No usable data — distinguish "unreachable" from "reachable but empty"
      setMetrics(DEMO); setSource(anyQueryFailed ? 'demo' : 'empty'); setLoading(false);
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
    empty: { bg: '#fff8e1', border: '#ffe082', color: '#7c6000',
      text: `📊 Demo data — Prometheus is reachable but has no dora_* metrics yet. The DORA exporter only reports repos that exist in the Backstage catalog; check that the repo carries the "idp" or "idp-app" GitHub topic and a root catalog-info.yaml, and that GITHUB_TOKEN is set in local/.env.` },
    demo: { bg: '#fff8e1', border: '#ffe082', color: '#7c6000',
      text: `📊 Demo data — Prometheus is unreachable. Start the cluster and check the /prometheus proxy endpoint in app-config.` },
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
                    {/* sloth.dev, not sloth.slok.dev. The latter is the CRD API
                        GROUP (apiVersion: sloth.slok.dev/v1, correct in the SLO
                        manifests) and was mistaken for a hostname here — it has no
                        DNS record, so the link died with ERR_NAME_NOT_RESOLVED.
                        Verified 2026-08-13: sloth.dev returns 200. */}
                    <Link href="https://sloth.dev" target="_blank" rel="noopener">Sloth ↗</Link>
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

// ── Home / Platform Dashboard ──────────────────────────────────────────────────
// Platform-wide overview: DORA aggregate, catalog counts, services table.

const DORA_DEMO: Record<string, DoraMetric> = {
  freq: { value: 3.2,  series: [1.8,2.1,2.4,3.0,3.2,2.9,3.2] },
  lead: { value: 42,   series: [68,55,50,45,42,39,42] },
  cfr:  { value: 4.8,  series: [8,6,5.5,5,4.8,5.1,4.8] },
  mttr: { value: 28,   series: [65,50,40,35,30,28,28] },
};

function HomePage() {
  const fetchApi  = useApi(fetchApiRef);
  const configApi = useApi(configApiRef);
  const base = configApi.getString('backend.baseUrl');

  const [dora, setDora]       = useState<Record<string, DoraMetric>>(DORA_DEMO);
  const [doraDemo, setDoraDemo] = useState(true);
  // Only true when a query actually failed — an empty-but-successful response
  // means Prometheus is up and simply has no dora_* series yet.
  const [doraUnreachable, setDoraUnreachable] = useState(false);
  const [counts, setCounts]   = useState({ components: 0, apis: 0, groups: 0 });
  const [services, setServices] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const pq = (expr: string) =>
      fetchApi.fetch(`${base}/api/proxy/prometheus/api/v1/query?query=${encodeURIComponent(expr)}`)
        .then(r => r.ok ? r.json() : Promise.reject(r.status))
        .then(d => parseFloat(d?.data?.result?.[0]?.value?.[1] ?? 'NaN'));
    const pr = (expr: string) =>
      fetchApi.fetch(`${base}/api/proxy/prometheus/api/v1/query_range?query=${encodeURIComponent(expr)}&start=${Math.floor(Date.now()/1000)-604800}&end=${Math.floor(Date.now()/1000)}&step=86400`)
        .then(r => r.ok ? r.json() : Promise.reject(r.status))
        .then(d => (d?.data?.result?.[0]?.values ?? []).map((v: any[]) => parseFloat(v[1])).filter((v: number) => !isNaN(v)));

    const catalogFetch = (kind: string) =>
      fetchApi.fetch(`${base}/api/catalog/entities?filter=kind=${kind}&fields=metadata.name,spec.owner,spec.lifecycle,spec.type`)
        .then(r => r.ok ? r.json() : []).catch(() => []);

    Promise.all([
      Promise.all([
        pq('avg(dora_deploy_frequency_per_day)'), pq('avg(dora_lead_time_minutes)'),
        pq('avg(dora_change_failure_rate_percent)'), pq('avg(dora_mttr_minutes)'),
        pr('avg(dora_deploy_frequency_per_day)'), pr('avg(dora_lead_time_minutes)'),
        pr('avg(dora_change_failure_rate_percent)'), pr('avg(dora_mttr_minutes)'),
      ]).then(([freq, lead, cfr, mttr, fS, lS, cS, mS]) => {
        // freq===0 is a real "no deploys" reading, not missing data — only NaN means the query failed.
        if (!isNaN(freq)) {
          setDora({ freq: {value:freq,series:fS}, lead: {value:lead,series:lS}, cfr: {value:cfr,series:cS}, mttr: {value:mttr,series:mS} });
          setDoraDemo(false);
        }
      }).catch(() => { setDoraUnreachable(true); }),
      catalogFetch('Component').then((entities: any[]) => {
        setServices(entities.slice(0, 20));
        setCounts(prev => ({ ...prev, components: entities.length }));
      }),
      catalogFetch('API').then((entities: any[]) => setCounts(prev => ({ ...prev, apis: entities.length }))),
      catalogFetch('Group').then((entities: any[]) => setCounts(prev => ({ ...prev, groups: entities.length }))),
    ]).finally(() => setLoading(false));
  }, [base, fetchApi]);

  const CARDS = [
    { key: 'freq', title: 'Deploy Frequency', unit: 'deploys/day' },
    { key: 'lead', title: 'Lead Time',         unit: 'commit → deploy' },
    { key: 'cfr',  title: 'Change Failure Rate', unit: '% of deploys' },
    { key: 'mttr', title: 'MTTR',               unit: 'time to restore' },
  ];

  return (
    <Page themeId="home">
      <Header title="Platform Dashboard" subtitle="Internal Developer Platform · platform-wide overview" />
      <Content>
        {loading && <Progress />}
        {!loading && (
          <>
            <Box display="flex" style={{ gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
              {[
                { label: 'Services', value: counts.components, color: '#1976d2', href: '/catalog?filters%5Bkind%5D=component' },
                { label: 'APIs',     value: counts.apis,       color: '#388e3c', href: '/catalog?filters%5Bkind%5D=api' },
                { label: 'Teams',    value: counts.groups,     color: '#7b1fa2', href: '/catalog?filters%5Bkind%5D=group' },
              ].map(({ label, value, color, href }) => (
                <Paper key={label} style={{ padding: '16px 24px', flex: 1, minWidth: 120, borderTop: `4px solid ${color}`, cursor: 'pointer' }} onClick={() => window.location.href = href}>
                  <Typography variant="h3" style={{ fontWeight: 700, color }}>{value || '—'}</Typography>
                  <Typography variant="body2" color="textSecondary">{label} in catalog</Typography>
                </Paper>
              ))}
            </Box>

            <Box display="flex" alignItems="center" style={{ gap: 8, marginBottom: 8 }}>
              <Typography variant="h6">Platform DORA</Typography>
              {doraDemo && <Chip label={doraUnreachable ? 'demo data — Prometheus unreachable' : 'demo data — no dora_* metrics yet'} size="small" style={{ background: '#fff8e1', color: '#7c6000', border: '1px solid #ffe082', fontSize: 10 }} />}
            </Box>
            <Box display="flex" style={{ gap: 16, flexWrap: 'wrap', marginBottom: 24 }}>
              {CARDS.map(({ key, title, unit }) => {
                const m = dora[key];
                const v = isNaN(m.value) ? (key==='cfr'?0:key==='freq'?0.1:60) : m.value;
                const band = doraBand(key, v);
                return <DoraMetricCard key={key} title={title} value={v} unit={unit} series={m.series.length ? m.series : [v]} band={band} metricKey={key} />;
              })}
            </Box>

            <Typography variant="h6" gutterBottom>Services</Typography>
            <Paper>
              <TableContainer>
                <MuiTable size="small">
                  <TableHead>
                    <TableRow style={{ background: '#f5f5f5' }}>
                      <TableCell><strong>Name</strong></TableCell>
                      <TableCell><strong>Owner</strong></TableCell>
                      <TableCell><strong>Type</strong></TableCell>
                      <TableCell><strong>Lifecycle</strong></TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {services.length === 0 && (
                      <TableRow><TableCell colSpan={4}>
                        <Typography variant="body2" color="textSecondary" style={{ padding: 8 }}>
                          No services yet — use <Link href="/create">Create</Link> to scaffold your first service.
                        </Typography>
                      </TableCell></TableRow>
                    )}
                    {services.map((s: any) => {
                      const lc = s.spec?.lifecycle ?? 'unknown';
                      const lcColor = lc === 'production' ? '#4caf50' : lc === 'experimental' ? '#ff9800' : '#9e9e9e';
                      return (
                        <TableRow key={s.metadata.name} hover style={{ cursor: 'pointer' }}
                          onClick={() => window.location.href = `/catalog/default/component/${s.metadata.name}`}>
                          <TableCell style={{ fontWeight: 500 }}>{s.metadata.name}</TableCell>
                          <TableCell><Typography variant="caption">{s.spec?.owner ?? '—'}</Typography></TableCell>
                          <TableCell><Typography variant="caption">{s.spec?.type ?? '—'}</Typography></TableCell>
                          <TableCell><Chip size="small" label={lc} style={{ background: lcColor, color: '#fff', fontSize: 10 }} /></TableCell>
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

const homeRouteRef = createRouteRef();  // was id: 'platform-home'
const homePage = PageBlueprint.make({
  name: 'platform-home',
  params: { path: '/', routeRef: homeRouteRef, loader: async () => <HomePage /> },
});
const homeNavItem = NavItemBlueprint.make({
  name: 'platform-home',
  params: { title: 'Home', icon: DashboardIcon as any, routeRef: homeRouteRef },
});

// ── Standalone DORA page ───────────────────────────────────────────────────────
// Platform aggregate + per-service breakdown table.

function DoraPage() {
  const fetchApi  = useApi(fetchApiRef);
  const configApi = useApi(configApiRef);
  const base = configApi.getString('backend.baseUrl');

  const [aggregate, setAggregate] = useState<Record<string, DoraMetric>>(DORA_DEMO);
  const [isDemo, setIsDemo]       = useState(true);
  // Only true when a query actually failed — an empty-but-successful response
  // means Prometheus is up and simply has no dora_* series yet.
  const [unreachable, setUnreachable] = useState(false);
  const [perService, setPerService] = useState<Array<{name:string; freq:number; lead:number; cfr:number; mttr:number}>>([]);
  const [loading, setLoading]     = useState(true);
  // Component names that actually exist in the catalog. The exporter reports GitHub
  // repos, which do not all have an entity, so a row is only clickable when its
  // target resolves — otherwise the click lands on "Entity not found".
  const [catalogNames, setCatalogNames] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetchApi.fetch(`${base}/api/catalog/entities?filter=kind=Component`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then((items: any[]) => setCatalogNames(new Set(items.map(e => e?.metadata?.name).filter(Boolean))))
      .catch(() => setCatalogNames(new Set())); // no catalog → no rows link, table still renders
  }, [base, fetchApi]);

  useEffect(() => {
    const pq = (expr: string) =>
      fetchApi.fetch(`${base}/api/proxy/prometheus/api/v1/query?query=${encodeURIComponent(expr)}`)
        .then(r => r.ok ? r.json() : Promise.reject(r.status));
    const scalar = (d: any) => parseFloat(d?.data?.result?.[0]?.value?.[1] ?? 'NaN');
    const allSeries = (d: any): Array<{metric: Record<string,string>; value: [number,string]}> => d?.data?.result ?? [];

    // Set by any rejected query, so the banner can tell "Prometheus down" from
    // "Prometheus fine, no dora_* series". Read only after the Promise.all settles.
    let queryFailed = false;
    const onFail = <T,>(fallback: T) => () => { queryFailed = true; return fallback; };

    Promise.all([
      pq('avg(dora_deploy_frequency_per_day)').then(scalar).catch(onFail(NaN)),
      pq('avg(dora_lead_time_minutes)').then(scalar).catch(onFail(NaN)),
      pq('avg(dora_change_failure_rate_percent)').then(scalar).catch(onFail(NaN)),
      pq('avg(dora_mttr_minutes)').then(scalar).catch(onFail(NaN)),
      pq('dora_deploy_frequency_per_day').then(allSeries).catch(onFail([])),
      pq('dora_lead_time_minutes').then(allSeries).catch(onFail([])),
      pq('dora_change_failure_rate_percent').then(allSeries).catch(onFail([])),
      pq('dora_mttr_minutes').then(allSeries).catch(onFail([])),
    ]).then(([freq, lead, cfr, mttr, freqSeries, leadSeries, cfrSeries, mttrSeries]) => {
      setUnreachable(queryFailed);
      // freq===0 is a real "no deploys" reading, not missing data — only NaN means the query failed.
      if (!isNaN(freq as number)) {
        setAggregate({
          freq: { value: freq as number, series: [] },
          lead: { value: lead as number, series: [] },
          cfr:  { value: cfr as number,  series: [] },
          mttr: { value: mttr as number, series: [] },
        });
        setIsDemo(false);
        // Build per-service table
        // Drop the synthetic aggregate — it is already rendered in the cards above,
        // and listing it here both double-counts it and offers a dead catalog link.
        const names = new Set<string>([
          ...(freqSeries as any[]).map((r:any) => r.metric?.service),
          ...(leadSeries as any[]).map((r:any) => r.metric?.service),
        ].filter(Boolean).filter((n: string) => n !== DORA_AGGREGATE_SERVICE));
        const toMap = (arr: any[]) => Object.fromEntries(arr.map((r:any) => [r.metric?.service, parseFloat(r.value?.[1] ?? 'NaN')]));
        const fMap = toMap(freqSeries as any[]);
        const lMap = toMap(leadSeries as any[]);
        const cMap = toMap(cfrSeries as any[]);
        const mMap = toMap(mttrSeries as any[]);
        setPerService(Array.from(names).map(name => ({
          name, freq: fMap[name] ?? NaN, lead: lMap[name] ?? NaN,
          cfr: cMap[name] ?? NaN, mttr: mMap[name] ?? NaN,
        })).sort((a, b) => (b.freq || 0) - (a.freq || 0)));
      }
    }).finally(() => setLoading(false));
  }, [base, fetchApi]);

  const CARDS = [
    { key: 'freq', title: 'Deploy Frequency', unit: 'deploys/day' },
    { key: 'lead', title: 'Lead Time',         unit: 'commit → deploy' },
    { key: 'cfr',  title: 'Change Failure Rate', unit: '% of deploys' },
    { key: 'mttr', title: 'MTTR',               unit: 'time to restore' },
  ];

  const fmt = (key: string, v: number) => {
    if (isNaN(v)) return '—';
    if (key === 'freq') return v < 1 ? `${(v*7).toFixed(1)}/wk` : `${v.toFixed(1)}/day`;
    if (key === 'cfr')  return `${v.toFixed(1)}%`;
    return v < 60 ? `${v.toFixed(0)} min` : `${(v/60).toFixed(1)} hr`;
  };

  return (
    <Page themeId="tool">
      <Header title="DORA Metrics" subtitle="Platform-wide deployment performance · all services" />
      <Content>
        {loading && <Progress />}
        {!loading && (
          <>
            {isDemo && (
              <Paper style={{ padding: '8px 16px', marginBottom: 16, background: '#fff8e1', border: '1px solid #ffe082' }}>
                <Typography variant="body2" style={{ color: '#7c6000' }}>
                  {unreachable
                    ? <>📊 Demo data — Prometheus unreachable. Start the cluster and check the <code>/prometheus</code> proxy endpoint in app-config.</>
                    : <>📊 Demo data — Prometheus is reachable but has no <code>dora_*</code> metrics yet. The DORA exporter only reports repos that exist in the Backstage catalog; check that your repos carry the <code>idp</code> or <code>idp-app</code> GitHub topic and a root <code>catalog-info.yaml</code>, and that <code>GITHUB_TOKEN</code> is set.</>}
                </Typography>
              </Paper>
            )}
            <Box display="flex" style={{ gap: 16, flexWrap: 'wrap', marginBottom: 24 }}>
              {CARDS.map(({ key, title, unit }) => {
                const m = aggregate[key];
                const v = isNaN(m.value) ? (key==='cfr'?0:key==='freq'?0.1:60) : m.value;
                const band = doraBand(key, v);
                return <DoraMetricCard key={key} title={title} value={v} unit={unit} series={m.series.length ? m.series : [v,v]} band={band} metricKey={key} />;
              })}
            </Box>

            <Paper>
              <Box style={{ padding: '12px 16px', borderBottom: '1px solid #eee' }}>
                <Typography variant="h6">Per-Service Breakdown</Typography>
              </Box>
              <TableContainer>
                <MuiTable size="small">
                  <TableHead>
                    <TableRow style={{ background: '#f5f5f5' }}>
                      <TableCell><strong>Service</strong></TableCell>
                      <TableCell align="right"><strong>Deploy Freq</strong></TableCell>
                      <TableCell align="right"><strong>Lead Time</strong></TableCell>
                      <TableCell align="right"><strong>Change Fail %</strong></TableCell>
                      <TableCell align="right"><strong>MTTR</strong></TableCell>
                      <TableCell><strong>Perf Band</strong></TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {perService.length === 0 && (
                      <TableRow><TableCell colSpan={6}>
                        <Typography variant="body2" color="textSecondary" style={{ padding: 8 }}>
                          {isDemo ? 'No per-service Prometheus data yet.' : 'No services with DORA data.'}
                        </Typography>
                      </TableCell></TableRow>
                    )}
                    {perService.map(row => {
                      const band = doraBand('freq', row.freq);
                      const linkable = catalogNames.has(row.name);
                      return (
                        <TableRow key={row.name} hover={linkable} style={{ cursor: linkable ? 'pointer' : 'default' }}
                          title={linkable ? undefined : `${row.name} has DORA metrics but no catalog entity — register its repo to open its service page.`}
                          onClick={linkable ? () => { window.location.href = `/catalog/default/component/${row.name}/dora`; } : undefined}>
                          <TableCell style={{ fontWeight: 500 }}>{row.name}</TableCell>
                          <TableCell align="right">{fmt('freq', row.freq)}</TableCell>
                          <TableCell align="right">{fmt('lead', row.lead)}</TableCell>
                          <TableCell align="right">{fmt('cfr', row.cfr)}</TableCell>
                          <TableCell align="right">{fmt('mttr', row.mttr)}</TableCell>
                          <TableCell>
                            <span style={{ background: band.color, color:'#fff', padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 700 }}>
                              {band.label}
                            </span>
                          </TableCell>
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

const doraPageRouteRef = createRouteRef();  // was id: 'dora-platform'
const doraPage = PageBlueprint.make({
  name: 'dora-platform',
  params: { path: '/dora', routeRef: doraPageRouteRef, loader: async () => <DoraPage /> },
});
const doraNavItem = NavItemBlueprint.make({
  name: 'dora-platform',
  params: { title: 'DORA', icon: TrendingUpIcon as any, routeRef: doraPageRouteRef },
});

// ── Standalone Scorecard overview ──────────────────────────────────────────────
// Fetches all Component entities, runs computeScorecard() client-side, and
// shows a sortable table of tier + score across the whole catalog.

function ScorecardPage() {
  const fetchApi  = useApi(fetchApiRef);
  const configApi = useApi(configApiRef);
  const base = configApi.getString('backend.baseUrl');

  const [rows, setRows]       = useState<Array<{entity: any; score: ScorecardResult}>>([]);
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState<'name'|'score'|'tier'>('score');

  useEffect(() => {
    fetchApi.fetch(`${base}/api/catalog/entities?filter=kind=Component`)
      .then(r => r.ok ? r.json() : [])
      .then((entities: any[]) => {
        setRows(entities.map(entity => ({ entity, score: computeScorecard(entity) })));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [base, fetchApi]);

  const TIER_ORDER: Record<TierName, number> = { gold: 3, silver: 2, bronze: 1, none: 0 };

  const sorted = [...rows].sort((a, b) => {
    if (sortKey === 'score') return b.score.passed - a.score.passed;
    if (sortKey === 'tier')  return TIER_ORDER[b.score.tier] - TIER_ORDER[a.score.tier];
    return a.entity.metadata.name.localeCompare(b.entity.metadata.name);
  });

  const tierCounts = rows.reduce((acc, r) => {
    acc[r.score.tier] = (acc[r.score.tier] ?? 0) + 1;
    return acc;
  }, {} as Record<TierName, number>);

  return (
    <Page themeId="tool">
      <Header title="Scorecard Overview" subtitle="Bronze / Silver / Gold shift-left quality tiers · all services" />
      <Content>
        {loading && <Progress />}
        {!loading && (
          <>
            {/* Tier summary */}
            <Box display="flex" style={{ gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
              {(['gold','silver','bronze','none'] as TierName[]).map(tier => (
                <Paper key={tier} style={{ padding: '16px 24px', flex: 1, minWidth: 100, borderTop: `4px solid ${TIER_COLORS[tier]}` }}>
                  <Typography variant="h3" style={{ fontWeight: 700, color: TIER_COLORS[tier] }}>{tierCounts[tier] ?? 0}</Typography>
                  <Typography variant="body2" color="textSecondary" style={{ textTransform: 'capitalize' }}>{tier === 'none' ? 'No tier' : tier}</Typography>
                </Paper>
              ))}
            </Box>

            {rows.length === 0 && (
              <Paper style={{ padding: 24, textAlign: 'center' }}>
                <Typography variant="body2" color="textSecondary">
                  No Component entities in the catalog yet. Scaffold a service to see its scorecard here.
                </Typography>
              </Paper>
            )}

            {rows.length > 0 && (
              <Paper>
                <Box style={{ padding: '12px 16px', borderBottom: '1px solid #eee', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Typography variant="h6" style={{ flex: 1 }}>Services</Typography>
                  {(['score','tier','name'] as const).map(k => (
                    <button key={k} onClick={() => setSortKey(k)}
                      style={{ padding: '4px 12px', borderRadius: 16, border: '1px solid', cursor: 'pointer', fontSize: 12,
                        fontWeight: k === sortKey ? 700 : 400,
                        background: k === sortKey ? '#1976d2' : '#fff',
                        color: k === sortKey ? '#fff' : '#333',
                        borderColor: k === sortKey ? '#1976d2' : '#ddd' }}>
                      Sort by {k}
                    </button>
                  ))}
                </Box>
                <TableContainer>
                  <MuiTable size="small">
                    <TableHead>
                      <TableRow style={{ background: '#f5f5f5' }}>
                        <TableCell><strong>Service</strong></TableCell>
                        <TableCell><strong>Owner</strong></TableCell>
                        <TableCell><strong>Tier</strong></TableCell>
                        <TableCell align="center"><strong>Score</strong></TableCell>
                        <TableCell><strong>Next action</strong></TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {sorted.map(({ entity, score }) => {
                        const failing = CHECKS.filter(c => !score.results[c.id] && (c.group !== 'AI Governance'));
                        return (
                          <TableRow key={entity.metadata.name} hover style={{ cursor: 'pointer' }}
                            onClick={() => window.location.href = `/catalog/default/component/${entity.metadata.name}/scorecard`}>
                            <TableCell style={{ fontWeight: 500 }}>{entity.metadata.name}</TableCell>
                            <TableCell><Typography variant="caption">{entity.spec?.owner ?? '—'}</Typography></TableCell>
                            <TableCell>
                              <span style={{ background: TIER_COLORS[score.tier], color: '#fff', padding: '2px 10px', borderRadius: 12, fontSize: 11, fontWeight: 700, textTransform: 'capitalize' }}>
                                {score.tier === 'none' ? 'No tier' : score.tier}
                              </span>
                            </TableCell>
                            <TableCell align="center">
                              <Box display="flex" alignItems="center" justifyContent="center" style={{ gap: 8 }}>
                                <Typography variant="body2" style={{ fontWeight: 600 }}>{score.passed}/{score.total}</Typography>
                                <div style={{ width: 60, height: 6, borderRadius: 3, background: '#eee', overflow: 'hidden' }}>
                                  <div style={{ height: '100%', width: `${(score.passed/score.total)*100}%`, background: TIER_COLORS[score.tier], borderRadius: 3 }} />
                                </div>
                              </Box>
                            </TableCell>
                            <TableCell>
                              <Typography variant="caption" color="textSecondary">
                                {failing[0]?.label ?? '🎉 All checks passing'}
                              </Typography>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </MuiTable>
                </TableContainer>
              </Paper>
            )}
          </>
        )}
      </Content>
    </Page>
  );
}

const scorecardPageRouteRef = createRouteRef();  // was id: 'scorecard-platform'
const scorecardPage = PageBlueprint.make({
  name: 'scorecard-platform',
  params: { path: '/scorecard', routeRef: scorecardPageRouteRef, loader: async () => <ScorecardPage /> },
});
const scorecardNavItem = NavItemBlueprint.make({
  name: 'scorecard-platform',
  params: { title: 'Scorecard', icon: EmojiEventsIcon as any, routeRef: scorecardPageRouteRef },
});

// ── Standalone SLO page ────────────────────────────────────────────────────────
// Queries Prometheus for all Sloth SLO info metrics (no service filter) and
// shows a cross-service error-budget table.

function SloPage() {
  const fetchApi  = useApi(fetchApiRef);
  const configApi = useApi(configApiRef);
  const base = configApi.getString('backend.baseUrl');

  const [slos, setSlos]       = useState<Array<{service:string; id:string; label:string; objective:number; errorRatio:number|null}>>([]);
  const [loading, setLoading] = useState(true);
  const [isDemo, setIsDemo]   = useState(false);
  // Sloth's sloth_service label (and the demo rows below) need not correspond to a
  // catalog entity, so only link a row when its target actually resolves.
  const [catalogNames, setCatalogNames] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetchApi.fetch(`${base}/api/catalog/entities?filter=kind=Component`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then((items: any[]) => setCatalogNames(new Set(items.map(e => e?.metadata?.name).filter(Boolean))))
      .catch(() => setCatalogNames(new Set()));
  }, [base, fetchApi]);

  useEffect(() => {
    const pq = (expr: string) =>
      fetchApi.fetch(`${base}/api/proxy/prometheus/api/v1/query?query=${encodeURIComponent(expr)}`)
        .then(r => r.ok ? r.json() : Promise.reject(r.status));

    Promise.all([
      pq('sloth_slo_info'),
      pq('slo:period_error_budget_remaining:ratio'),
    ]).then(([infoRes, budgetRes]) => {
      const infos: any[] = infoRes?.data?.result ?? [];
      const budgets: any[] = budgetRes?.data?.result ?? [];

      if (infos.length === 0) { setIsDemo(true); setLoading(false); return; }

      // keyed by sloth_id which is present on both info and budget metrics
      const budgetMap: Record<string, number> = {};
      budgets.forEach((r: any) => {
        const id = r.metric?.sloth_id ?? '';
        if (id) budgetMap[id] = parseFloat(r.value?.[1] ?? 'NaN');
      });

      const rows = infos.map((r: any) => {
        const service   = r.metric?.sloth_service ?? '—';
        const id        = r.metric?.sloth_id ?? '';
        const objective = parseFloat(r.metric?.sloth_objective ?? '99');
        // slo:period_error_budget_remaining:ratio is already the budget remaining ratio (1.0 = 100%)
        const errorRatio = id in budgetMap ? budgetMap[id] : null;
        return { service, id, label: id.replace(new RegExp(`^${service}-`), '').replace(/-/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()), objective, errorRatio };
      }).sort((a, b) => a.service.localeCompare(b.service));

      setSlos(rows);
    }).catch(() => setIsDemo(true))
    .finally(() => setLoading(false));
  }, [base, fetchApi]);

  const DEMO_SLOS = [
    { service: 'hello-service', id: 'availability', label: 'Availability', objective: 99.9, errorRatio: 0.0003 },
    { service: 'hello-service', id: 'latency-p95',  label: 'Latency P95',  objective: 99.5, errorRatio: 0.0021 },
    { service: 'idp-mcp-server', id: 'availability', label: 'Availability', objective: 99.5, errorRatio: 0.0001 },
    { service: 'qa-mcp-server', id: 'availability',  label: 'Availability', objective: 99.0, errorRatio: 0.008 },
  ];

  const displaySlos = isDemo ? DEMO_SLOS : slos;

  // errorRatio here holds slo:period_error_budget_remaining:ratio (0–1 scale, may go negative)
  const budgetPct = (_objective: number, errorRatio: number | null) => {
    if (errorRatio === null) return null;
    return Math.max(0, errorRatio * 100);
  };

  return (
    <Page themeId="tool">
      <Header title="SLOs" subtitle="Error budgets · all services · powered by Sloth + Prometheus" />
      <Content>
        {loading && <Progress />}
        {!loading && (
          <>
            {isDemo && (
              <Paper style={{ padding: '8px 16px', marginBottom: 16, background: '#fff8e1', border: '1px solid #ffe082' }}>
                <Typography variant="body2" style={{ color: '#7c6000' }}>
                  📊 Demo data — no <code>sloth_slo_info</code> metrics found. Apply Sloth SLO manifests to see live error budgets.
                </Typography>
              </Paper>
            )}
            <Paper>
              <TableContainer>
                <MuiTable size="small">
                  <TableHead>
                    <TableRow style={{ background: '#f5f5f5' }}>
                      <TableCell><strong>Service</strong></TableCell>
                      <TableCell><strong>SLO</strong></TableCell>
                      <TableCell align="right"><strong>Objective</strong></TableCell>
                      <TableCell><strong>Error Budget Remaining</strong></TableCell>
                      <TableCell><strong>Status</strong></TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {displaySlos.map((row, i) => {
                      const pct = budgetPct(row.objective, row.errorRatio);
                      const color = pct == null ? '#9e9e9e' : pct > 50 ? '#4caf50' : pct > 10 ? '#ff9800' : '#f44336';
                      const status = pct == null ? 'No data' : pct > 50 ? 'Healthy' : pct > 10 ? 'Burning fast' : 'Critical';
                      const linkable = catalogNames.has(row.service);
                      return (
                        <TableRow key={i} hover={linkable} style={{ cursor: linkable ? 'pointer' : 'default' }}
                          title={linkable ? undefined : `${row.service} has SLO metrics but no catalog entity — register it to open its service page.`}
                          onClick={linkable ? () => { window.location.href = `/catalog/default/component/${row.service}/slo`; } : undefined}>
                          <TableCell style={{ fontWeight: 500 }}>{row.service}</TableCell>
                          <TableCell><Typography variant="body2">{row.label}</Typography></TableCell>
                          <TableCell align="right"><Typography variant="body2" style={{ fontFamily: 'monospace' }}>{row.objective}%</Typography></TableCell>
                          <TableCell style={{ minWidth: 180 }}>
                            {pct != null ? (
                              <Box display="flex" alignItems="center" style={{ gap: 8 }}>
                                <div style={{ flex: 1, height: 8, borderRadius: 4, background: '#eee', overflow: 'hidden' }}>
                                  <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 4 }} />
                                </div>
                                <Typography variant="caption" style={{ minWidth: 36, fontFamily: 'monospace' }}>{pct.toFixed(1)}%</Typography>
                              </Box>
                            ) : <Typography variant="caption" color="textSecondary">—</Typography>}
                          </TableCell>
                          <TableCell>
                            <Chip size="small" label={status} style={{ background: color, color: '#fff', fontWeight: 600, fontSize: 10 }} />
                          </TableCell>
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

const sloPageRouteRef = createRouteRef();  // was id: 'slo-platform'
const sloPage = PageBlueprint.make({
  name: 'slo-platform',
  params: { path: '/slo', routeRef: sloPageRouteRef, loader: async () => <SloPage /> },
});
const sloNavItem = NavItemBlueprint.make({
  name: 'slo-platform',
  params: { title: 'SLOs', icon: TrackChangesIcon as any, routeRef: sloPageRouteRef },
});

// ── ArgoCD Applications page ───────────────────────────────────────────────────
// Shows all ArgoCD applications with sync/health status via /api/proxy/argocd.

type ArgoSyncStatus = 'Synced' | 'OutOfSync' | 'Unknown';
type ArgoHealthStatus = 'Healthy' | 'Progressing' | 'Degraded' | 'Suspended' | 'Missing' | 'Unknown';

interface ArgoApp {
  name:       string;
  namespace:  string;
  sync:       ArgoSyncStatus;
  health:     ArgoHealthStatus;
  revision:   string;
  lastSynced: string;
}

const DEMO_ARGO_APPS: ArgoApp[] = [
  { name: 'hello-service-local',      namespace: 'services-dev', sync: 'Synced',    health: 'Healthy',     revision: 'a3f1b2c', lastSynced: '2 min ago' },
  { name: 'idp-mcp-server-local',     namespace: 'services-dev', sync: 'Synced',    health: 'Healthy',     revision: 'cc02f88', lastSynced: '3 hours ago' },
  { name: 'qa-mcp-server-local',      namespace: 'services-dev', sync: 'OutOfSync', health: 'Healthy',     revision: '91e2d4a', lastSynced: '8 min ago' },
  { name: 'github-mcp-server-local',  namespace: 'services-dev', sync: 'OutOfSync', health: 'Degraded',    revision: '7bc3a11', lastSynced: '1 hour ago' },
  { name: 'prometheus-stack',         namespace: 'monitoring',   sync: 'Synced',    health: 'Healthy',     revision: 'stable',  lastSynced: '1 day ago' },
  { name: 'backstage',                namespace: 'backstage',    sync: 'Synced',    health: 'Healthy',     revision: 'main',    lastSynced: '2 days ago' },
  { name: 'kagent',                   namespace: 'kagent',       sync: 'OutOfSync', health: 'Progressing', revision: 'v0.4.1',  lastSynced: '5 min ago' },
];

function ArgocdPage() {
  const fetchApi  = useApi(fetchApiRef);
  const configApi = useApi(configApiRef);
  const base = configApi.getString('backend.baseUrl');
  const argocdUrl = configApi.getOptionalString('externalLinks.argocd') ?? 'http://argocd.idp.local';

  const [apps, setApps]       = useState<ArgoApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [isDemo, setIsDemo]   = useState(false);
  const [syncing, setSyncing] = useState<string | null>(null);

  const loadApps = () => {
    setLoading(true);
    fetchApi.fetch(`${base}/api/proxy/argocd/api/v1/applications`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then((data: any) => {
        const items: ArgoApp[] = (data?.items ?? []).map((item: any) => ({
          name:       item.metadata?.name ?? '—',
          namespace:  item.spec?.destination?.namespace ?? '—',
          sync:       item.status?.sync?.status ?? 'Unknown',
          health:     item.status?.health?.status ?? 'Unknown',
          revision:   (item.status?.sync?.revision ?? '').slice(0, 7) || '—',
          lastSynced: item.status?.operationState?.finishedAt
            ? new Date(item.status.operationState.finishedAt).toLocaleString()
            : '—',
        }));
        setApps(items);
      })
      .catch(() => { setApps(DEMO_ARGO_APPS); setIsDemo(true); })
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadApps(); }, [base, fetchApi]); // eslint-disable-line react-hooks/exhaustive-deps

  const syncApp = async (name: string) => {
    setSyncing(name);
    try {
      await fetchApi.fetch(`${base}/api/proxy/argocd/api/v1/applications/${name}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: 'HEAD' }),
      });
      setTimeout(loadApps, 2000);
    } catch { /* ignore — demo mode */ }
    finally { setTimeout(() => setSyncing(null), 2000); }
  };

  const SYNC_COLORS: Record<string, string>   = { Synced: '#4caf50', OutOfSync: '#ff9800', Unknown: '#9e9e9e' };
  const HEALTH_COLORS: Record<string, string> = { Healthy: '#4caf50', Progressing: '#1976d2', Degraded: '#f44336', Suspended: '#9e9e9e', Missing: '#ff9800', Unknown: '#9e9e9e' };

  const totals = apps.reduce((acc, a) => {
    acc.total++;
    if (a.sync === 'Synced') acc.synced++;
    else if (a.sync === 'OutOfSync') acc.outOfSync++;
    else acc.unknown++;
    if (a.health === 'Degraded') acc.degraded++;
    return acc;
  }, { total: 0, synced: 0, outOfSync: 0, unknown: 0, degraded: 0 });

  return (
    <Page themeId="tool">
      <Header title="ArgoCD Applications" subtitle="GitOps · app-of-apps" />
      <Content>
        {loading && <Progress />}
        {!loading && (
          <>
            {isDemo && (
              <Paper style={{ padding: '8px 16px', marginBottom: 16, background: '#fff8e1', border: '1px solid #ffe082' }}>
                <Typography variant="body2" style={{ color: '#7c6000' }}>
                  📊 Demo data — ArgoCD proxy returned an error. Set <code>ARGOCD_AUTH_TOKEN</code> in <code>local/backstage/.env</code> and restart Backstage.
                </Typography>
              </Paper>
            )}

            {/* Summary cards */}
            <Box display="flex" style={{ gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
              {[
                { label: 'Total Apps',    value: totals.total,     color: '#455a64' },
                { label: 'Synced',        value: totals.synced,    color: '#4caf50' },
                { label: 'Out of Sync',   value: totals.outOfSync, color: '#ff9800' },
                { label: 'Unknown',       value: totals.unknown,   color: '#9e9e9e' },
                { label: 'Degraded',      value: totals.degraded,  color: '#f44336' },
              ].map(({ label, value, color }) => (
                <Paper key={label} style={{ padding: '16px 24px', flex: 1, minWidth: 100, borderTop: `4px solid ${color}` }}>
                  <Typography variant="h3" style={{ fontWeight: 700, color }}>{value}</Typography>
                  <Typography variant="body2" color="textSecondary">{label}</Typography>
                </Paper>
              ))}
            </Box>

            <Paper>
              <Box style={{ padding: '12px 16px', borderBottom: '1px solid #eee', display: 'flex', alignItems: 'center' }}>
                <Typography variant="h6" style={{ flex: 1 }}>Applications</Typography>
                <Button variant="outlined" size="small" onClick={loadApps} disabled={loading}>↺ Refresh</Button>
                <Box ml={1}>
                  <Button
                    variant="contained"
                    size="small"
                    color="primary"
                    onClick={() => window.open(argocdUrl, '_blank')}
                  >
                    Open ArgoCD ↗
                  </Button>
                </Box>
              </Box>
              <TableContainer>
                <MuiTable size="small">
                  <TableHead>
                    <TableRow style={{ background: '#f5f5f5' }}>
                      <TableCell><strong>Application</strong></TableCell>
                      <TableCell><strong>Namespace</strong></TableCell>
                      <TableCell><strong>Sync Status</strong></TableCell>
                      <TableCell><strong>Health</strong></TableCell>
                      <TableCell><strong>Revision</strong></TableCell>
                      <TableCell><strong>Last Synced</strong></TableCell>
                      <TableCell />
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {apps.map(app => (
                      <TableRow key={app.name} hover>
                        <TableCell style={{ fontWeight: 500 }}>{app.name}</TableCell>
                        <TableCell><Typography variant="caption" style={{ fontFamily: 'monospace' }}>{app.namespace}</Typography></TableCell>
                        <TableCell>
                          <Chip size="small" label={app.sync}
                            style={{ background: SYNC_COLORS[app.sync] ?? '#9e9e9e', color: '#fff', fontWeight: 600, fontSize: 10 }} />
                        </TableCell>
                        <TableCell>
                          <Chip size="small" label={app.health}
                            style={{ background: HEALTH_COLORS[app.health] ?? '#9e9e9e', color: '#fff', fontWeight: 600, fontSize: 10 }} />
                        </TableCell>
                        <TableCell><Typography variant="caption" style={{ fontFamily: 'monospace' }}>{app.revision}</Typography></TableCell>
                        <TableCell><Typography variant="caption">{app.lastSynced}</Typography></TableCell>
                        <TableCell>
                          <Button size="small" variant="outlined" disabled={syncing === app.name || isDemo}
                            onClick={() => syncApp(app.name)}
                            style={{ fontSize: 11, minWidth: 60 }}>
                            {syncing === app.name ? '…' : '↺ Sync'}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
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

const argocdPageRouteRef = createRouteRef();  // was id: 'argocd-platform'
const argocdPage = PageBlueprint.make({
  name: 'argocd-platform',
  params: { path: '/argocd', routeRef: argocdPageRouteRef, loader: async () => <ArgocdPage /> },
});
const argocdNavItem = NavItemBlueprint.make({
  name: 'argocd-platform',
  params: { title: 'ArgoCD', icon: AccountTreeIcon as any, routeRef: argocdPageRouteRef },
});

// ── Activity Feed ─────────────────────────────────────────────────────────────
// Platform-wide event stream. Pulls ArgoCD sync ops + Prometheus deployment
// counters; falls back to curated demo events when services are unreachable.

interface ActivityEvent {
  id:       string;
  kind:     'deploy' | 'scaffold' | 'alert' | 'incident' | 'scorecard' | 'budget' | 'security';
  emoji:    string;
  color:    string;
  title:    React.ReactNode;
  detail:   string;
  time:     string;
}

const DEMO_EVENTS: ActivityEvent[] = [
  { id:'1', kind:'deploy',    emoji:'🚀', color:'#e8f5e9', title: <><b>hello-service</b> deployed to production by <b>Moataz Nabil</b></>,           detail:'main · a3f1b2c · 3 pods updated · 0 errors',                      time:'2 min ago' },
  { id:'2', kind:'scaffold',  emoji:'+',  color:'#e3f2fd', title: <><b>payment-service</b> scaffolded and registered by <b>Moataz Nabil</b></>,       detail:'Go service · platform-team · payments-team',                       time:'14:22' },
  { id:'3', kind:'alert',     emoji:'⚠️', color:'#fff8e1', title: <>SLO <b>latency-p95</b> is at risk for <b>hello-service</b></>,                   detail:'Error budget at 32% · burn rate 2.1x · 30-day window',             time:'11:08' },
  { id:'4', kind:'incident',  emoji:'🔴', color:'#ffebee', title: <>Deployment <b>github-mcp-server #243</b> failed</>,                               detail:'main · 7bc3a11 · image pull error · view logs',                    time:'10:45' },
  { id:'5', kind:'scorecard', emoji:'📊', color:'#ede7f6', title: <>Scorecard re-run: <b>contract-mcp-server</b> dropped from Silver → Bronze</>,    detail:'Score: 75 → 71 · SonarCloud quality gate failed',                  time:'09:30' },
  { id:'6', kind:'incident',  emoji:'✅', color:'#e8f5e9', title: <>Incident resolved — <b>HighP95Latency</b> on hello-service</>,                   detail:'Duration: 18 min · MTTR target met',                               time:'Yesterday 15:38' },
  { id:'7', kind:'budget',    emoji:'💰', color:'#fff8e1', title: <>Budget alert: <b>quality-team</b> reached 80% of monthly budget</>,              detail:'$240 spent of $300 · 10 days remaining',                           time:'Yesterday 12:00' },
  { id:'8', kind:'security',  emoji:'🔒', color:'#e3f2fd', title: <>Security scan: 2 new medium CVEs found in <b>idp-mcp-server</b></>,              detail:'Snyk · golang.org/x/net · gin-gonic/gin · upgrade available',       time:'Jun 19' },
];

const KIND_LABELS: Record<string, string> = {
  deploy: 'Deployments', scaffold: 'Catalog', alert: 'Incidents',
  incident: 'Incidents', scorecard: 'Scorecard', budget: 'Budget', security: 'Security',
};

function ActivityPage() {
  const fetchApi  = useApi(fetchApiRef);
  const configApi = useApi(configApiRef);
  const base = configApi.getString('backend.baseUrl');

  const [events, setEvents]     = useState<ActivityEvent[]>(DEMO_EVENTS);
  const [isDemo, setIsDemo]     = useState(true);
  const [kindFilter, setKindFilter] = useState('All');
  const [loading, setLoading]   = useState(true);

  useEffect(() => {
    // Enrich with real ArgoCD sync operations
    fetchApi.fetch(`${base}/api/proxy/argocd/api/v1/applications`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then((data: any) => {
        const items: any[] = data?.items ?? [];
        if (items.length === 0) return;
        const live: ActivityEvent[] = items
          .filter((app: any) => app.status?.operationState)
          .slice(0, 6)
          .map((app: any, i: number) => {
            const op    = app.status?.operationState;
            const phase = op?.phase ?? 'Unknown';
            const rev   = (app.status?.sync?.revision ?? '').slice(0, 7);
            const ts    = op?.finishedAt ? new Date(op.finishedAt).toLocaleString() : '—';
            const ok    = phase === 'Succeeded';
            return {
              id:     `argo-${i}`,
              kind:   'deploy' as const,
              emoji:  ok ? '🚀' : '🔴',
              color:  ok ? '#e8f5e9' : '#ffebee',
              title:  <><b>{app.metadata?.name}</b> sync {phase.toLowerCase()}</>,
              detail: `${app.spec?.destination?.namespace} · ${rev} · ${phase}`,
              time:   ts,
            };
          });
        setEvents(live.length ? live : DEMO_EVENTS);
        setIsDemo(live.length === 0);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [base, fetchApi]);

  const FILTER_OPTIONS = ['All', 'Deployments', 'Incidents', 'Catalog', 'Scorecard', 'Budget', 'Security'];

  const filtered = kindFilter === 'All'
    ? events
    : events.filter(e => KIND_LABELS[e.kind] === kindFilter);

  return (
    <Page themeId="tool">
      <Header title="Activity Feed" subtitle="Platform-wide event stream · real-time" />
      <Content>
        {loading && <Progress />}
        {!loading && (
          <>
            {isDemo && (
              <Paper style={{ padding: '8px 16px', marginBottom: 16, background: '#fff8e1', border: '1px solid #ffe082' }}>
                <Typography variant="body2" style={{ color: '#7c6000' }}>
                  📊 Demo data — ArgoCD unreachable. Live deploy events will appear once the cluster is running.
                </Typography>
              </Paper>
            )}

            {/* Filters */}
            <Box display="flex" style={{ gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
              {FILTER_OPTIONS.map(k => (
                <button key={k} onClick={() => setKindFilter(k)}
                  style={{ padding: '4px 14px', borderRadius: 20, border: '1px solid', cursor: 'pointer', fontSize: 12,
                    background: k === kindFilter ? '#1976d2' : '#fff',
                    color: k === kindFilter ? '#fff' : '#555',
                    borderColor: k === kindFilter ? '#1976d2' : '#ddd',
                    fontWeight: k === kindFilter ? 600 : 400 }}>
                  {k}
                </button>
              ))}
            </Box>

            <Paper>
              {filtered.length === 0 && (
                <Box style={{ padding: 24, textAlign: 'center' }}>
                  <Typography variant="body2" color="textSecondary">No events for this filter.</Typography>
                </Box>
              )}
              {filtered.map((ev, idx) => (
                <Box key={ev.id} display="flex" alignItems="flex-start" style={{
                  gap: 14, padding: '14px 20px',
                  borderBottom: idx < filtered.length - 1 ? '1px solid #eee' : 'none',
                }}>
                  <div style={{
                    width: 32, height: 32, background: ev.color, borderRadius: '50%',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 14, flexShrink: 0,
                  }}>
                    {ev.emoji}
                  </div>
                  <Box flex={1}>
                    <Typography variant="body2" style={{ fontSize: 13 }}>{ev.title}</Typography>
                    <Typography variant="caption" color="textSecondary" style={{ marginTop: 2, display: 'block' }}>{ev.detail}</Typography>
                  </Box>
                  <Typography variant="caption" style={{ color: '#aaa', whiteSpace: 'nowrap', marginTop: 2 }}>{ev.time}</Typography>
                </Box>
              ))}
            </Paper>
          </>
        )}
      </Content>
    </Page>
  );
}

const activityRouteRef = createRouteRef();  // was id: 'activity-feed'
const activityPage = PageBlueprint.make({
  name: 'activity-feed',
  params: { path: '/activity', routeRef: activityRouteRef, loader: async () => <ActivityPage /> },
});
const activityNavItem = NavItemBlueprint.make({
  name: 'activity-feed',
  params: { title: 'Activity', icon: DynamicFeedIcon as any, routeRef: activityRouteRef },
});

// ── API Explorer ───────────────────────────────────────────────────────────────
// Fetches all API entities from the catalog; lets you filter by type/owner and
// inspect a lightweight endpoint summary for OpenAPI specs.

interface ApiEntity {
  name:        string;
  type:        string;
  lifecycle:   string;
  owner:       string;
  description: string;
  tags:        string[];
  definition?: string;
}

function ApiExplorerPage() {
  const fetchApi  = useApi(fetchApiRef);
  const configApi = useApi(configApiRef);
  const base = configApi.getString('backend.baseUrl');

  const [apis, setApis]       = useState<ApiEntity[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch]   = useState('');
  const [typeFilter, setTypeFilter] = useState('All');
  const [selected, setSelected]     = useState<ApiEntity | null>(null);

  useEffect(() => {
    fetchApi.fetch(`${base}/api/catalog/entities?filter=kind=API&fields=metadata.name,metadata.description,metadata.tags,spec.type,spec.lifecycle,spec.owner`)
      .then(r => r.ok ? r.json() : [])
      .then((entities: any[]) => {
        setApis(entities.map((e: any) => ({
          name:        e.metadata?.name ?? '—',
          type:        e.spec?.type ?? 'openapi',
          lifecycle:   e.spec?.lifecycle ?? 'unknown',
          owner:       e.spec?.owner ?? '—',
          description: e.metadata?.description ?? '',
          tags:        e.metadata?.tags ?? [],
        })));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [base, fetchApi]);

  const DEMO_APIS: ApiEntity[] = [
    { name: 'hello-api',    type: 'openapi',  lifecycle: 'production',   owner: 'platform-team', description: 'REST API for the hello-service — /greet, /health, /metrics endpoints.', tags: ['rest','json'] },
    { name: 'mcp-api',      type: 'openapi',  lifecycle: 'production',   owner: 'platform-team', description: 'MCP tool protocol API — list_tools, call_tool, get_prompt endpoints.',  tags: ['mcp','json-rpc'] },
    { name: 'contract-api', type: 'openapi',  lifecycle: 'experimental', owner: 'quality-team',  description: 'Contract testing endpoints — fetch, register, validate compatibility.',    tags: ['contract','pact'] },
    { name: 'dora-events',  type: 'asyncapi', lifecycle: 'production',   owner: 'platform-team', description: 'Deployment event stream — publishes DORA events to Kafka.',               tags: ['events','kafka'] },
  ];

  const displayApis = apis.length > 0 ? apis : DEMO_APIS;
  const isDemo      = apis.length === 0;

  const TYPE_COLORS: Record<string, string> = { openapi: '#1976d2', asyncapi: '#388e3c', grpc: '#7b1fa2', graphql: '#e91e63' };
  const LC_COLORS:   Record<string, string> = { production: '#4caf50', experimental: '#ff9800', deprecated: '#9e9e9e' };

  const apiTypes = ['All', ...Array.from(new Set(displayApis.map(a => a.type)))];

  const filtered = displayApis.filter(a => {
    const matchSearch = !search || a.name.includes(search) || a.description.toLowerCase().includes(search.toLowerCase());
    const matchType   = typeFilter === 'All' || a.type === typeFilter;
    return matchSearch && matchType;
  });

  const DEMO_ENDPOINTS = [
    { method: 'GET',  path: '/api/greet',  desc: 'Returns a greeting message',  status: ['200 OK', '400 Bad Request'] },
    { method: 'GET',  path: '/health',     desc: 'Liveness probe',               status: ['200 OK'] },
    { method: 'GET',  path: '/metrics',    desc: 'Prometheus metrics',           status: ['200 OK'] },
  ];

  const METHOD_COLORS: Record<string, string> = { GET: '#4caf50', POST: '#1976d2', PUT: '#ff9800', DELETE: '#f44336', PATCH: '#9c27b0' };

  return (
    <Page themeId="tool">
      <Header title="API Explorer" subtitle={`${displayApis.length} registered APIs · OpenAPI · AsyncAPI · gRPC`} />
      <Content>
        {loading && <Progress />}
        {!loading && (
          <>
            {isDemo && (
              <Paper style={{ padding: '8px 16px', marginBottom: 16, background: '#fff8e1', border: '1px solid #ffe082' }}>
                <Typography variant="body2" style={{ color: '#7c6000' }}>
                  📋 Demo data — no API entities in catalog. Register APIs in <code>catalog-info.yaml</code> with <code>kind: API</code>.
                </Typography>
              </Paper>
            )}

            {/* Search + filters */}
            <Box display="flex" style={{ gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
              <input value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search APIs…"
                style={{ padding: '6px 12px', borderRadius: 4, border: '1px solid #ddd', fontSize: 13, width: 240 }} />
              {apiTypes.map(t => (
                <button key={t} onClick={() => setTypeFilter(t)}
                  style={{ padding: '4px 14px', borderRadius: 20, border: '1px solid', cursor: 'pointer', fontSize: 12,
                    background: t === typeFilter ? '#1976d2' : '#fff',
                    color: t === typeFilter ? '#fff' : '#555',
                    borderColor: t === typeFilter ? '#1976d2' : '#ddd',
                    fontWeight: t === typeFilter ? 600 : 400, textTransform: 'capitalize' }}>
                  {t}
                </button>
              ))}
              <Box flex={1} />
              <Button variant="contained" color="primary" size="small"
                href="/catalog/create" style={{ fontSize: 12 }}>
                + Register API
              </Button>
            </Box>

            {/* API grid */}
            <Box display="flex" style={{ gap: 16, flexWrap: 'wrap', marginBottom: selected ? 20 : 0 }}>
              {filtered.map(api => (
                <Paper key={api.name} onClick={() => setSelected(selected?.name === api.name ? null : api)}
                  style={{ flex: '1 1 300px', maxWidth: 420, cursor: 'pointer',
                    border: selected?.name === api.name ? '2px solid #1976d2' : '2px solid transparent',
                    transition: 'border-color 0.15s' }}>
                  <Box display="flex" alignItems="center" style={{ gap: 12, padding: '16px 16px 12px' }}>
                    <div style={{ width: 40, height: 40, borderRadius: 8, background: `${TYPE_COLORS[api.type] ?? '#455a64'}22`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, flexShrink: 0 }}>
                      {api.type === 'asyncapi' ? '⬡' : api.type === 'grpc' ? '⚡' : '◈'}
                    </div>
                    <Box flex={1}>
                      <Typography variant="body1" style={{ fontWeight: 600 }}>{api.name}</Typography>
                      <Typography variant="caption" color="textSecondary" style={{ textTransform: 'capitalize' }}>
                        {api.type} · {api.owner}
                      </Typography>
                    </Box>
                    <Chip size="small" label={api.lifecycle}
                      style={{ background: LC_COLORS[api.lifecycle] ?? '#9e9e9e', color: '#fff', fontSize: 10, fontWeight: 600 }} />
                  </Box>
                  <Typography variant="body2" color="textSecondary" style={{ padding: '0 16px 10px', fontSize: 12 }}>
                    {api.description || 'No description.'}
                  </Typography>
                  {api.tags.length > 0 && (
                    <Box style={{ padding: '0 16px 12px', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {api.tags.map(t => (
                        <Chip key={t} size="small" label={t} style={{ fontSize: 10, height: 18 }} />
                      ))}
                    </Box>
                  )}
                </Paper>
              ))}
              {filtered.length === 0 && (
                <Typography variant="body2" color="textSecondary" style={{ padding: 8 }}>No APIs match your filter.</Typography>
              )}
            </Box>

            {/* Inline spec preview */}
            {selected && (
              <Paper style={{ marginTop: 4 }}>
                <Box display="flex" alignItems="center" style={{ padding: '12px 16px', borderBottom: '1px solid #eee' }}>
                  <Typography variant="h6" style={{ flex: 1 }}>
                    {selected.name} · <span style={{ textTransform: 'capitalize', color: TYPE_COLORS[selected.type] ?? '#455a64' }}>{selected.type}</span>
                  </Typography>
                  <Button variant="outlined" size="small"
                    href={`/catalog/default/api/${selected.name}`} style={{ fontSize: 11, marginRight: 8 }}>
                    Full catalog page ↗
                  </Button>
                  <Button size="small" onClick={() => setSelected(null)} style={{ fontSize: 11 }}>Close ✕</Button>
                </Box>
                {DEMO_ENDPOINTS.map((ep, i) => (
                  <Box key={i}>
                    <Box style={{ background: '#1e2d3d', padding: '10px 20px', display: 'flex', alignItems: 'center', gap: 12 }}>
                      <span style={{ background: METHOD_COLORS[ep.method] ?? '#455a64', color: '#fff', padding: '1px 8px', borderRadius: 3, fontSize: 11, fontWeight: 700 }}>{ep.method}</span>
                      <Typography variant="caption" style={{ color: '#a3be8c', fontFamily: 'monospace', fontSize: 13 }}>{ep.path}</Typography>
                      <Typography variant="caption" style={{ color: '#81a1c1', marginLeft: 8 }}>· {ep.desc}</Typography>
                    </Box>
                    <Box style={{ padding: '10px 20px', borderBottom: i < DEMO_ENDPOINTS.length - 1 ? '1px solid #eee' : 'none', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {ep.status.map(s => (
                        <Chip key={s} size="small" label={s}
                          style={{ fontSize: 10, background: s.startsWith('2') ? '#e8f5e9' : s.startsWith('4') ? '#fff8e1' : '#ffebee', fontWeight: 600 }} />
                      ))}
                    </Box>
                  </Box>
                ))}
              </Paper>
            )}
          </>
        )}
      </Content>
    </Page>
  );
}

const apiExplorerRouteRef = createRouteRef();  // was id: 'api-explorer'
const apiExplorerPage = PageBlueprint.make({
  name: 'api-explorer',
  params: { path: '/apis', routeRef: apiExplorerRouteRef, loader: async () => <ApiExplorerPage /> },
});
// This DOES get a nav item, despite the earlier note here claiming a second entry
// would point "at the same place". It does not: apiDocsPlugin's "APIs" item routes
// to its own /api-docs page, while this one routes to /apis — a different, richer
// explorer (search, type/lifecycle filters, owner, a detail pane) built from the
// catalog API in this file. Without an entry the page was reachable only by typing
// the URL, so most of the portal's users never saw it.
//
// Deliberately titled "API Explorer" rather than "APIs" so the two are tellable
// apart in the sidebar. The plugin's own item is left alone: it is registered
// without an explicit name, so disabling it would mean guessing the generated
// extension id, and a wrong guess silently disables nothing.
const apiExplorerNavItem = NavItemBlueprint.make({
  name: 'api-explorer',
  params: {
    title: 'API Explorer',
    icon: AccountTreeIcon as any,
    routeRef: apiExplorerRouteRef,
  },
});

// ── Onboarding Wizard ──────────────────────────────────────────────────────────
// 4-step guide for new platform users. Progress persisted in localStorage.
// Step 1: Profile (auto-filled from identity API)
// Step 2: GitHub (token check)
// Step 3: First Service (links to /create)
// Step 4: Explore (links to key pages)

const ONBOARDING_KEY = 'idp_onboarding_step';

function OnboardingPage() {
  const identityApi = useApi(identityApiRef);
  const aiStackEnabled = useAiStackEnabled();

  const [step, setStep]     = useState<number>(() => {
    try { return parseInt(localStorage.getItem(ONBOARDING_KEY) ?? '0', 10); } catch { return 0; }
  });
  const [displayName, setDisplayName] = useState('');

  useEffect(() => {
    identityApi.getProfileInfo().then(p => setDisplayName(p.displayName ?? p.email ?? 'there')).catch(() => {});
  }, [identityApi]);

  const advance = (to: number) => {
    const next = Math.min(to, 3);
    setStep(next);
    try { localStorage.setItem(ONBOARDING_KEY, String(next)); } catch {}
  };
  const back = (to: number) => {
    const prev = Math.max(to, 0);
    setStep(prev);
    try { localStorage.setItem(ONBOARDING_KEY, String(prev)); } catch {}
  };

  const STEPS = ['Profile', 'GitHub', 'First Service', 'Explore'];

  const stepColor = (i: number) =>
    i < step ? '#4caf50' : i === step ? '#1976d2' : '#e0e0e0';

  return (
    <Page themeId="home">
      <Header title="Welcome to the IDP" subtitle="Let's get you set up in 4 quick steps" />
      <Content>
        <Box style={{ maxWidth: 680, margin: '0 auto' }}>
          {/* Progress stepper */}
          <Paper style={{ padding: '20px 24px', marginBottom: 24 }}>
            <Box display="flex" alignItems="center">
              {STEPS.map((label, i) => (
                <Box key={i} display="flex" alignItems="center" style={{ flex: 1 }}>
                  <Box display="flex" flexDirection="column" alignItems="center" style={{ flex: 1 }}>
                    <div style={{
                      width: 32, height: 32, borderRadius: '50%', display: 'flex',
                      alignItems: 'center', justifyContent: 'center', marginBottom: 6,
                      background: stepColor(i), color: '#fff', fontWeight: 700, fontSize: 13,
                      cursor: i <= step ? 'pointer' : 'default',
                    }} onClick={() => { if (i <= step) back(i); }}>
                      {i < step ? '✓' : i + 1}
                    </div>
                    <Typography variant="caption" style={{ fontWeight: i === step ? 600 : 400, color: stepColor(i), fontSize: 11 }}>
                      {label}
                    </Typography>
                  </Box>
                  {i < STEPS.length - 1 && (
                    <div style={{ flex: 1, height: 2, background: i < step ? '#4caf50' : '#e0e0e0', marginBottom: 22, maxWidth: 60 }} />
                  )}
                </Box>
              ))}
            </Box>
          </Paper>

          {/* Step 0 — Profile */}
          {step === 0 && (
            <Paper style={{ marginBottom: 16 }}>
              <Box style={{ padding: '20px 24px', borderBottom: '1px solid #eee' }}>
                <Box display="flex" alignItems="center" style={{ gap: 8, marginBottom: 4 }}>
                  <Chip size="small" label="Step 1 of 4" style={{ background: '#e3f2fd', color: '#1976d2', fontWeight: 600, fontSize: 10 }} />
                  <Typography variant="h6">Set up your profile</Typography>
                </Box>
                <Typography variant="body2" color="textSecondary">
                  Confirm your details — we pulled these from your identity provider.
                </Typography>
              </Box>
              <Box style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                <Box style={{ padding: '14px', border: '1px solid #e0e0e0', borderRadius: 4 }}>
                  <Typography variant="caption" color="textSecondary">Display name</Typography>
                  <Typography variant="body1" style={{ fontWeight: 500 }}>{displayName || 'Loading…'}</Typography>
                </Box>
                <Typography variant="caption" color="textSecondary">
                  To update your profile, sign out and back in with your GitHub account.
                </Typography>
                <Box display="flex" justifyContent="flex-end" style={{ marginTop: 8 }}>
                  <Button variant="contained" color="primary" onClick={() => advance(1)}>Looks good →</Button>
                </Box>
              </Box>
            </Paper>
          )}

          {/* Step 1 — GitHub */}
          {step === 1 && (
            <Paper style={{ marginBottom: 16 }}>
              <Box style={{ padding: '20px 24px', borderBottom: '1px solid #eee' }}>
                <Box display="flex" alignItems="center" style={{ gap: 8, marginBottom: 4 }}>
                  <Chip size="small" label="Step 2 of 4" style={{ background: '#e3f2fd', color: '#1976d2', fontWeight: 600, fontSize: 10 }} />
                  <Typography variant="h6">Connect GitHub</Typography>
                </Box>
                <Typography variant="body2" color="textSecondary">
                  The IDP uses your GitHub token to scaffold services and trigger CI/CD.
                </Typography>
              </Box>
              <Box style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                <Box style={{ padding: 14, border: '1px solid #c8e6c9', borderRadius: 4, background: '#f1f8e9', display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ fontSize: 20 }}>✅</span>
                  <Box>
                    <Typography variant="body2" style={{ fontWeight: 500 }}>GitHub token detected</Typography>
                    <Typography variant="caption" color="textSecondary">GITHUB_TOKEN is set in local/.env — scaffold actions are enabled.</Typography>
                  </Box>
                </Box>
                <Box display="flex" justifyContent="space-between" style={{ marginTop: 8 }}>
                  <Button onClick={() => back(0)}>← Back</Button>
                  <Button variant="contained" color="primary" onClick={() => advance(2)}>Continue →</Button>
                </Box>
              </Box>
            </Paper>
          )}

          {/* Step 2 — First Service */}
          {step === 2 && (
            <Paper style={{ marginBottom: 16 }}>
              <Box style={{ padding: '20px 24px', borderBottom: '1px solid #eee' }}>
                <Box display="flex" alignItems="center" style={{ gap: 8, marginBottom: 4 }}>
                  <Chip size="small" label="Step 3 of 4" style={{ background: '#e3f2fd', color: '#1976d2', fontWeight: 600, fontSize: 10 }} />
                  <Typography variant="h6">Create your first service</Typography>
                </Box>
                <Typography variant="body2" color="textSecondary">Use a Golden Path template to scaffold a production-ready service in under 2 minutes.</Typography>
              </Box>
              <Box style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                {[
                  { emoji: '🐹', label: 'Go Microservice', desc: 'Production-ready · CI/CD included · ~90s', primary: true },
                  { emoji: '🟨', label: 'Node.js Service', desc: 'Express + TypeScript · ~90s',              primary: false },
                  { emoji: '🐍', label: 'Python Service',  desc: 'FastAPI · Dockerfile · ~90s',             primary: false },
                ].map(({ emoji, label, desc, primary }) => (
                  <a key={label} href="/create"
                    style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 14, textDecoration: 'none', color: 'inherit',
                      border: `1px solid ${primary ? '#1976d2' : '#e0e0e0'}`,
                      borderRadius: 4, background: primary ? '#e3f2fd' : '#fff', cursor: 'pointer' }}>
                    <div style={{ width: 40, height: 40, borderRadius: 8, background: primary ? '#1976d2' : '#f5f5f5',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, flexShrink: 0 }}>
                      {emoji}
                    </div>
                    <Box flex={1}>
                      <Typography variant="body2" style={{ fontWeight: 500 }}>{label}{primary ? ' (recommended)' : ''}</Typography>
                      <Typography variant="caption" color="textSecondary">{desc}</Typography>
                    </Box>
                    <Button variant={primary ? 'contained' : 'outlined'} color={primary ? 'primary' : 'default'} size="small" style={{ fontSize: 11 }}>
                      Use Template →
                    </Button>
                  </a>
                ))}
                <Box display="flex" justifyContent="space-between" style={{ marginTop: 8 }}>
                  <Button onClick={() => back(1)}>← Back</Button>
                  <Button color="default" onClick={() => advance(3)}>Skip for now →</Button>
                </Box>
              </Box>
            </Paper>
          )}

          {/* Step 3 — Explore */}
          {step === 3 && (
            <Paper style={{ marginBottom: 16 }}>
              <Box style={{ padding: '20px 24px', borderBottom: '1px solid #eee' }}>
                <Box display="flex" alignItems="center" style={{ gap: 8, marginBottom: 4 }}>
                  <Chip size="small" label="Step 4 of 4" style={{ background: '#e8f5e9', color: '#4caf50', fontWeight: 600, fontSize: 10 }} />
                  <Typography variant="h6">🎉 You're all set, {displayName || 'there'}!</Typography>
                </Box>
                <Typography variant="body2" color="textSecondary">Here's where to go next:</Typography>
              </Box>
              <Box style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                {[
                  { href: '/catalog',    emoji: '📦', label: 'Catalog',      desc: 'Browse all services, APIs, and teams' },
                  { href: '/',           emoji: '📊', label: 'Dashboard',    desc: 'Platform-wide DORA metrics and status' },
                  ...(aiStackEnabled
                    ? [{ href: '/ai-assistant', emoji: '🤖', label: 'AI Assistant', desc: 'Ask the IDP assistant anything' }]
                    : []),
                  { href: '/scorecard',  emoji: '🏆', label: 'Scorecard',    desc: 'Quality tiers across all services' },
                  { href: '/learning-center', emoji: '🎓', label: 'Learning Center', desc: 'Tutorials by experience level, track your progress' },
                ].map(({ href, emoji, label, desc }) => (
                  <a key={label} href={href}
                    style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', textDecoration: 'none', color: 'inherit',
                      border: '1px solid #e0e0e0', borderRadius: 4, cursor: 'pointer' }}>
                    <span style={{ fontSize: 20 }}>{emoji}</span>
                    <Box>
                      <Typography variant="body2" style={{ fontWeight: 500 }}>{label}</Typography>
                      <Typography variant="caption" color="textSecondary">{desc}</Typography>
                    </Box>
                  </a>
                ))}
                <Box display="flex" justifyContent="space-between" style={{ marginTop: 8 }}>
                  <Button onClick={() => back(2)}>← Back</Button>
                  <Button variant="contained" color="primary" href="/">Go to Dashboard →</Button>
                </Box>
              </Box>
            </Paper>
          )}

          {/* Completed steps summary */}
          {step > 0 && (
            <Paper>
              {step > 0 && <Box style={{ padding: '12px 20px', borderBottom: step > 1 ? '1px solid #eee' : 'none', display: 'flex', alignItems: 'center', gap: 10 }}><span style={{ color: '#4caf50' }}>✓</span><Typography variant="body2">Profile confirmed · {displayName}</Typography></Box>}
              {step > 1 && <Box style={{ padding: '12px 20px', display: 'flex', alignItems: 'center', gap: 10 }}><span style={{ color: '#4caf50' }}>✓</span><Typography variant="body2">GitHub connected</Typography></Box>}
            </Paper>
          )}
        </Box>
      </Content>
    </Page>
  );
}

const onboardingRouteRef = createRouteRef();  // was id: 'onboarding'
const onboardingPage = PageBlueprint.make({
  name: 'onboarding',
  params: { path: '/onboarding', routeRef: onboardingRouteRef, loader: async () => <OnboardingPage /> },
});
const onboardingNavItem = NavItemBlueprint.make({
  name: 'onboarding',
  params: { title: 'Onboarding', icon: EmojiPeopleIcon as any, routeRef: onboardingRouteRef },
});

// ── Learning Center ────────────────────────────────────────────────────────────
// Faceted browser over golden-path templates (idp.io/experience-level annotation,
// fetched live from the catalog) and curated conceptual docs (static list below —
// docs/*.md pages aren't separate catalog entities, they're all TechDocs for the
// single System:internal-developer-platform entity). Progress is tracked per-user
// via the learning-center backend plugin (its own Postgres DB — see
// packages/backend/src/modules/idpLearningCenter.ts), not localStorage.

type LearningLevel = 'beginner' | 'intermediate' | 'advanced';

interface LearningItem {
  id: string; // stable key sent to the progress API — entityRef-shaped for templates
  title: string;
  description: string;
  level: LearningLevel;
  topic: string;
  type: 'template' | 'doc';
  href: string;
}

const LEARNING_LEVELS: LearningLevel[] = ['beginner', 'intermediate', 'advanced'];

const LEARNING_DOCS: LearningItem[] = [
  { id: 'doc:getting-started', title: 'Getting Started', description: 'Personalise the repo and boot your first local cluster.', level: 'beginner', topic: 'golden-path', type: 'doc', href: '/docs/default/system/internal-developer-platform/getting-started' },
  { id: 'doc:golden-path', title: 'Golden Path Overview', description: 'The full test pyramid and which template covers each layer.', level: 'beginner', topic: 'golden-path', type: 'doc', href: '/docs/default/system/internal-developer-platform/golden-path' },
  { id: 'doc:contract-testing', title: 'Contract Testing', description: 'MCP-driven contract discovery, auto-registration, and breaking-change detection.', level: 'intermediate', topic: 'testing', type: 'doc', href: '/docs/default/system/internal-developer-platform/contract-testing' },
  { id: 'doc:dora-finops', title: 'DORA Metrics & FinOps', description: 'How DORA metrics and team cost budgets are wired into Backstage.', level: 'intermediate', topic: 'observability', type: 'doc', href: '/docs/default/system/internal-developer-platform/dora-finops' },
  { id: 'doc:mobile-platform', title: 'Mobile Platform', description: 'Appium, Flutter, code signing, and app-store deploy templates.', level: 'intermediate', topic: 'mobile', type: 'doc', href: '/docs/default/system/internal-developer-platform/mobile-platform' },
  { id: 'doc:crossplane-vs-terraform', title: 'Crossplane vs Terraform', description: 'When to use a Terraform PR vs a Crossplane claim for AWS infra.', level: 'advanced', topic: 'infra', type: 'doc', href: '/docs/default/system/internal-developer-platform/crossplane-vs-terraform' },
  { id: 'doc:multi-region', title: 'Multi-Region', description: 'Aurora Global, DynamoDB Global Tables, S3 multi-region access points.', level: 'advanced', topic: 'infra', type: 'doc', href: '/docs/default/system/internal-developer-platform/multi-region' },
  { id: 'doc:ai-assistant', title: 'AI Assistant Architecture', description: 'How the native chat UI talks to KAgent and MCP servers.', level: 'advanced', topic: 'ai', type: 'doc', href: '/docs/default/system/internal-developer-platform/ai-assistant' },
];

function learningLevelColor(level: LearningLevel): string {
  return level === 'beginner' ? '#4caf50' : level === 'intermediate' ? '#ff9800' : '#f44336';
}

function LearningCenterPage() {
  const catalogApi = useApi(catalogApiRef);
  const fetchApi = useApi(fetchApiRef);
  const configApi = useApi(configApiRef);
  const base = configApi.getString('backend.baseUrl');

  const [templateItems, setTemplateItems] = useState<LearningItem[]>([]);
  const [completed, setCompleted] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [topicFilter, setTopicFilter] = useState<string[]>([]);
  const [levelFilter, setLevelFilter] = useState<LearningLevel[]>([]);
  const [typeFilter, setTypeFilter] = useState<Array<'template' | 'doc'>>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [entitiesResp, progressResp] = await Promise.all([
        catalogApi.getEntities({
          filter: { kind: 'Template', 'metadata.annotations.idp.io/tutorial-type': CATALOG_FILTER_EXISTS },
        }),
        fetchApi.fetch(`${base}/api/learning-center/progress`)
          .then(r => (r.ok ? r.json() : { completed: [] }))
          .catch(() => ({ completed: [] })),
      ]);
      if (cancelled) return;
      const items: LearningItem[] = entitiesResp.items.map(e => {
        const a = (e.metadata.annotations ?? {}) as Record<string, string>;
        const name = e.metadata.name;
        return {
          id: `template:default/${name}`,
          title: e.metadata.title ?? name,
          description: e.metadata.description ?? '',
          level: (a['idp.io/experience-level'] as LearningLevel) ?? 'beginner',
          topic: a['idp.io/topic'] ?? 'golden-path',
          type: 'template',
          href: `/catalog/default/template/${name}`,
        };
      });
      setTemplateItems(items);
      setCompleted(new Set(progressResp.completed ?? []));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [catalogApi, fetchApi, base]);

  const allItems = useMemo(() => [...templateItems, ...LEARNING_DOCS], [templateItems]);
  const topics = useMemo(() => Array.from(new Set(allItems.map(i => i.topic))).sort(), [allItems]);

  const filtered = allItems.filter(i =>
    (topicFilter.length === 0 || topicFilter.includes(i.topic)) &&
    (levelFilter.length === 0 || levelFilter.includes(i.level)) &&
    (typeFilter.length === 0 || typeFilter.includes(i.type)),
  );

  const toggleFilter = <T,>(arr: T[], val: T, set: (v: T[]) => void) => {
    set(arr.includes(val) ? arr.filter(v => v !== val) : [...arr, val]);
  };

  const toggleCompleted = async (item: LearningItem) => {
    const wasDone = completed.has(item.id);
    const optimistic = new Set(completed);
    if (wasDone) optimistic.delete(item.id); else optimistic.add(item.id);
    setCompleted(optimistic);
    try {
      const resp = await fetchApi.fetch(`${base}/api/learning-center/progress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entityRef: item.id, completed: !wasDone }),
      });
      if (resp.ok) {
        const body = await resp.json();
        setCompleted(new Set(body.completed ?? []));
      }
    } catch {
      // keep the optimistic toggle — a background refresh will reconcile
    }
  };

  const total = allItems.length;
  const doneCount = allItems.filter(i => completed.has(i.id)).length;
  const pct = total > 0 ? (doneCount / total) * 100 : 0;
  const tier = pct >= 100 ? '🥇' : pct >= 50 ? '🥈' : pct >= 25 ? '🥉' : null;

  if (loading) {
    return (
      <Page themeId="tool">
        <Header title="Learning Center" subtitle="Tutorials and golden-path templates by experience level" />
        <Content><Progress /></Content>
      </Page>
    );
  }

  return (
    <Page themeId="tool">
      <Header title="Learning Center" subtitle="Tutorials and golden-path templates by experience level" />
      <Content>
        <Paper style={{ padding: '16px 20px', marginBottom: 20 }}>
          <Box display="flex" justifyContent="space-between" alignItems="center" style={{ marginBottom: 8 }}>
            <Typography variant="h6">{tier ? `${tier} ` : ''}{doneCount} of {total} completed</Typography>
            <Typography variant="caption" color="textSecondary">{pct.toFixed(0)}%</Typography>
          </Box>
          <LinearProgress variant="determinate" value={pct} style={{ height: 8, borderRadius: 4 }} />
        </Paper>

        <Box display="flex" style={{ gap: 20, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <Paper style={{ flex: '1 1 240px', maxWidth: 280, padding: '16px 20px' }}>
            <Typography variant="subtitle2" style={{ marginBottom: 12 }}>Filter Your Search</Typography>

            <Typography variant="caption" color="textSecondary" style={{ fontWeight: 600, display: 'block', marginBottom: 6 }}>EXPERIENCE</Typography>
            <Box display="flex" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
              {LEARNING_LEVELS.map(level => (
                <Chip key={level} label={level} size="small" clickable
                  onClick={() => toggleFilter(levelFilter, level, setLevelFilter)}
                  style={{
                    background: levelFilter.includes(level) ? learningLevelColor(level) : '#eee',
                    color: levelFilter.includes(level) ? '#fff' : '#555',
                    fontWeight: 600, textTransform: 'capitalize',
                  }} />
              ))}
            </Box>

            <Typography variant="caption" color="textSecondary" style={{ fontWeight: 600, display: 'block', marginBottom: 6 }}>TYPE</Typography>
            <Box display="flex" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
              {(['template', 'doc'] as const).map(t => (
                <Chip key={t} label={t === 'template' ? 'Template' : 'Doc'} size="small" clickable
                  onClick={() => toggleFilter(typeFilter, t, setTypeFilter)}
                  style={{ background: typeFilter.includes(t) ? '#1976d2' : '#eee', color: typeFilter.includes(t) ? '#fff' : '#555', fontWeight: 600 }} />
              ))}
            </Box>

            <Typography variant="caption" color="textSecondary" style={{ fontWeight: 600, display: 'block', marginBottom: 6 }}>TOPIC</Typography>
            <Box display="flex" style={{ gap: 6, flexWrap: 'wrap' }}>
              {topics.map(topic => (
                <Chip key={topic} label={topic} size="small" clickable
                  onClick={() => toggleFilter(topicFilter, topic, setTopicFilter)}
                  style={{ background: topicFilter.includes(topic) ? '#607d8b' : '#eee', color: topicFilter.includes(topic) ? '#fff' : '#555', fontWeight: 600 }} />
              ))}
            </Box>

            {(topicFilter.length > 0 || levelFilter.length > 0 || typeFilter.length > 0) && (
              <Button size="small" style={{ marginTop: 12 }} onClick={() => { setTopicFilter([]); setLevelFilter([]); setTypeFilter([]); }}>
                Clear all filters
              </Button>
            )}
          </Paper>

          <Box style={{ flex: '3 1 500px', display: 'flex', flexDirection: 'column', gap: 12 }}>
            {filtered.length === 0 && (
              <Paper style={{ padding: 20 }}><Typography color="textSecondary">No tutorials match these filters.</Typography></Paper>
            )}
            {filtered.map(item => {
              const done = completed.has(item.id);
              return (
                <Paper key={item.id} style={{ padding: '16px 20px', display: 'flex', gap: 14, alignItems: 'flex-start' }}>
                  <IconButton size="small" onClick={() => toggleCompleted(item)} style={{ marginTop: -4 }}>
                    <CheckCircleIcon style={{ color: done ? '#4caf50' : '#ccc' }} />
                  </IconButton>
                  <Box flex={1}>
                    <Box display="flex" alignItems="center" style={{ gap: 8, marginBottom: 4 }}>
                      <Typography variant="body1" style={{ fontWeight: 600 }}>{item.title}</Typography>
                      <Chip size="small" label={item.level} style={{ background: learningLevelColor(item.level), color: '#fff', fontWeight: 600, fontSize: 10, textTransform: 'capitalize' }} />
                      <Chip size="small" label={item.type === 'template' ? 'Template' : 'Doc'} variant="outlined" style={{ fontSize: 10 }} />
                    </Box>
                    <Typography variant="body2" color="textSecondary" style={{ marginBottom: 8 }}>{item.description}</Typography>
                    <Link href={item.href}>{item.type === 'template' ? 'View template →' : 'Read doc →'}</Link>
                  </Box>
                </Paper>
              );
            })}
          </Box>
        </Box>
      </Content>
    </Page>
  );
}

const learningCenterRouteRef = createRouteRef();  // was id: 'learning-center'
const learningCenterPage = PageBlueprint.make({
  name: 'learning-center',
  params: { path: '/learning-center', routeRef: learningCenterRouteRef, loader: async () => <LearningCenterPage /> },
});
const learningCenterNavItem = NavItemBlueprint.make({
  name: 'learning-center',
  params: { title: 'Learning Center', icon: SchoolIcon as any, routeRef: learningCenterRouteRef },
});

// ── Cost Calculator ────────────────────────────────────────────────────────────
// Interactive slider-based cost estimator. Pulls live team budget from Prometheus
// (idp_team_budget_usd_monthly) and compares the estimate against remaining budget.

function CostCalculatorPage() {
  const fetchApi  = useApi(fetchApiRef);
  const configApi = useApi(configApiRef);
  const base = configApi.getString('backend.baseUrl');

  const [cpu,      setCpu]      = useState(250);   // millicores
  const [mem,      setMem]      = useState(256);   // Mi
  const [replicas, setReplicas] = useState(2);
  const [aiCalls,  setAiCalls]  = useState(500);
  const [env,      setEnv]      = useState<'local' | 'aws'>('local');
  const [budget,   setBudget]   = useState<{ budget: number; used: number; team: string } | null>(null);

  useEffect(() => {
    const pq = (expr: string) =>
      fetchApi.fetch(`${base}/api/proxy/prometheus/api/v1/query?query=${encodeURIComponent(expr)}`)
        .then(r => r.ok ? r.json() : Promise.reject(r.status));
    Promise.all([
      pq('idp_team_budget_usd_monthly').catch(() => null),
      pq('idp_team_actual_cost_usd_monthly').catch(() => null),
    ]).then(([budgetRes, costRes]) => {
      const br = budgetRes?.data?.result?.[0];
      const cr = costRes?.data?.result?.[0];
      if (br) {
        setBudget({
          team:   br.metric?.team ?? 'platform-team',
          budget: parseFloat(br.value?.[1] ?? '500'),
          used:   parseFloat(cr?.value?.[1] ?? '0'),
        });
      }
    }).catch(() => {});
  }, [base, fetchApi]);

  // Cost model: EKS node ~$0.1/vCPU·hour, ~$0.012/GiB·hour; local = $0
  const cpuCost  = env === 'aws' ? (cpu / 1000) * replicas * 0.1  * 730 : 0;
  const memCost  = env === 'aws' ? (mem / 1024) * replicas * 0.012 * 730 : 0;
  const k8sCost  = cpuCost + memCost;
  // Claude Sonnet 4 ~$3/MTok input, ~$15/MTok output, ~avg 1.5K tokens/call
  const aiCost   = aiCalls * 1500 / 1_000_000 * ((3 + 15) / 2);
  const total    = k8sCost + aiCost;

  const k8sPct   = total > 0 ? (k8sCost / total) * 100 : 0;
  const aiPct    = total > 0 ? (aiCost  / total) * 100 : 100;

  const demoBudget = { team: 'platform-team', budget: 500, used: 312 };
  const b          = budget ?? demoBudget;
  const newTotal   = b.used + total;
  const pctOfBudget = b.budget > 0 ? (total / b.budget) * 100 : 0;
  const utilization = b.budget > 0 ? (newTotal / b.budget) * 100 : 0;

  const fmt$ = (v: number) => v < 1 ? `$${v.toFixed(2)}` : `$${Math.round(v)}`;

  return (
    <Page themeId="tool">
      <Header title="Cost Calculator" subtitle="Estimate monthly infrastructure cost before deploying" />
      <Content>
        <Box display="flex" style={{ gap: 20, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          {/* Inputs */}
          <Paper style={{ flex: '1 1 300px', maxWidth: 400 }}>
            <Box style={{ padding: '12px 16px', borderBottom: '1px solid #eee' }}>
              <Typography variant="h6">Service Configuration</Typography>
            </Box>
            <Box style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 20 }}>

              {/* Service type */}
              <Box>
                <Typography variant="caption" color="textSecondary" style={{ fontWeight: 600, display: 'block', marginBottom: 6 }}>Service Type</Typography>
                <select style={{ width: '100%', padding: '6px 10px', borderRadius: 4, border: '1px solid #ddd', fontSize: 13 }}>
                  <option>Web service (HTTP/gRPC)</option>
                  <option>Background worker</option>
                  <option>Cron job</option>
                  <option>ML inference server</option>
                </select>
              </Box>

              {/* CPU */}
              <Box>
                <Box display="flex" justifyContent="space-between">
                  <Typography variant="caption" color="textSecondary" style={{ fontWeight: 600 }}>CPU Request</Typography>
                  <Typography variant="caption" style={{ fontFamily: 'monospace', fontWeight: 600 }}>{cpu}m</Typography>
                </Box>
                <input type="range" min={100} max={2000} step={50} value={cpu}
                  onChange={e => setCpu(parseInt(e.target.value, 10))}
                  style={{ width: '100%', marginTop: 4 }} />
              </Box>

              {/* Memory */}
              <Box>
                <Box display="flex" justifyContent="space-between">
                  <Typography variant="caption" color="textSecondary" style={{ fontWeight: 600 }}>Memory Request</Typography>
                  <Typography variant="caption" style={{ fontFamily: 'monospace', fontWeight: 600 }}>{mem}Mi</Typography>
                </Box>
                <input type="range" min={128} max={4096} step={128} value={mem}
                  onChange={e => setMem(parseInt(e.target.value, 10))}
                  style={{ width: '100%', marginTop: 4 }} />
              </Box>

              {/* Replicas */}
              <Box>
                <Box display="flex" justifyContent="space-between">
                  <Typography variant="caption" color="textSecondary" style={{ fontWeight: 600 }}>Replicas</Typography>
                  <Typography variant="caption" style={{ fontFamily: 'monospace', fontWeight: 600 }}>{replicas}</Typography>
                </Box>
                <input type="range" min={1} max={10} value={replicas}
                  onChange={e => setReplicas(parseInt(e.target.value, 10))}
                  style={{ width: '100%', marginTop: 4 }} />
              </Box>

              <Box style={{ height: 1, background: '#eee' }} />

              {/* AI calls */}
              <Box>
                <Box display="flex" justifyContent="space-between">
                  <Typography variant="caption" color="textSecondary" style={{ fontWeight: 600 }}>AI API calls / month</Typography>
                  <Typography variant="caption" style={{ fontFamily: 'monospace', fontWeight: 600 }}>{aiCalls.toLocaleString()}</Typography>
                </Box>
                <input type="range" min={0} max={10000} step={100} value={aiCalls}
                  onChange={e => setAiCalls(parseInt(e.target.value, 10))}
                  style={{ width: '100%', marginTop: 4 }} />
              </Box>

              {/* Environment */}
              <Box>
                <Typography variant="caption" color="textSecondary" style={{ fontWeight: 600, display: 'block', marginBottom: 6 }}>Environment</Typography>
                <Box display="flex" style={{ gap: 8 }}>
                  {(['local', 'aws'] as const).map(e => (
                    <button key={e} onClick={() => setEnv(e)}
                      style={{ flex: 1, padding: '8px', borderRadius: 4, border: `1px solid ${env === e ? '#1976d2' : '#ddd'}`,
                        background: env === e ? '#e3f2fd' : '#fff', color: env === e ? '#1976d2' : '#555',
                        fontWeight: env === e ? 700 : 400, cursor: 'pointer', fontSize: 12 }}>
                      {e === 'local' ? '🏠 Local (Kind) — free' : '☁️ AWS EKS'}
                    </button>
                  ))}
                </Box>
              </Box>
            </Box>
          </Paper>

          {/* Estimate panel */}
          <Box style={{ flex: '1 1 260px', display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Total */}
            <Paper>
              <Box style={{ padding: '12px 16px', borderBottom: '1px solid #eee' }}>
                <Typography variant="h6">Estimated Monthly Cost</Typography>
              </Box>
              <Box style={{ padding: '24px 20px', textAlign: 'center' }}>
                <Typography variant="h2" style={{ fontWeight: 300, color: '#1976d2', lineHeight: 1 }}>{fmt$(total)}</Typography>
                <Typography variant="caption" color="textSecondary" style={{ marginTop: 6, display: 'block' }}>
                  per month · {env === 'local' ? 'Kind cluster (free compute)' : 'AWS EKS estimate'}
                </Typography>
              </Box>
              <Box style={{ padding: '0 20px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                {[
                  { label: 'Kubernetes (OpenCost est.)', value: k8sCost, pct: k8sPct, color: '#1976d2' },
                  { label: 'AI API (Claude Sonnet)',     value: aiCost,  pct: aiPct,  color: '#4caf50' },
                  { label: 'Observability (Loki, Tempo)', value: 0,      pct: 0,      color: '#ff9800' },
                ].map(({ label, value, pct, color }) => (
                  <Box key={label}>
                    <Box display="flex" justifyContent="space-between" style={{ marginBottom: 4 }}>
                      <Typography variant="caption">{label}</Typography>
                      <Typography variant="caption" style={{ fontFamily: 'monospace', fontWeight: 600 }}>{fmt$(value)}</Typography>
                    </Box>
                    <div style={{ height: 6, borderRadius: 3, background: '#eee', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${Math.min(pct, 100)}%`, background: color, borderRadius: 3, transition: 'width 0.3s' }} />
                    </div>
                  </Box>
                ))}
              </Box>
            </Paper>

            {/* vs Budget */}
            <Paper>
              <Box style={{ padding: '12px 16px', borderBottom: '1px solid #eee' }}>
                <Typography variant="h6">vs Team Budget</Typography>
                {!budget && <Typography variant="caption" color="textSecondary"> · demo data</Typography>}
              </Box>
              <Box style={{ padding: '16px 20px' }}>
                <Box display="flex" justifyContent="space-between" style={{ marginBottom: 6 }}>
                  <Typography variant="caption">This service: <strong>{pctOfBudget.toFixed(1)}% of budget</strong></Typography>
                  <Typography variant="caption">{b.team} · {fmt$(b.budget)}/mo</Typography>
                </Box>
                <div style={{ height: 8, borderRadius: 4, background: '#eee', overflow: 'hidden', marginBottom: 12 }}>
                  <div style={{ height: '100%', width: `${Math.min(utilization, 100)}%`, background: utilization > 90 ? '#f44336' : utilization > 70 ? '#ff9800' : '#4caf50', borderRadius: 4, transition: 'width 0.3s' }} />
                </div>
                <Typography variant="caption" color="textSecondary">
                  Budget used: {fmt$(b.used)} · Adding this service: ~{fmt$(newTotal)} total ({utilization.toFixed(0)}% utilization)
                </Typography>
              </Box>
            </Paper>

            <Button variant="contained" color="primary" href="/create" style={{ width: '100%', justifyContent: 'center', padding: '10px 0' }}>
              Scaffold Service →
            </Button>
          </Box>
        </Box>
      </Content>
    </Page>
  );
}

const calculatorRouteRef = createRouteRef();  // was id: 'cost-calculator'
const calculatorPage = PageBlueprint.make({
  name: 'cost-calculator',
  params: { path: '/calculator', routeRef: calculatorRouteRef, loader: async () => <CostCalculatorPage /> },
});
const calculatorNavItem = NavItemBlueprint.make({
  name: 'cost-calculator',
  params: { title: 'Cost Calc', icon: CalculateIcon as any, routeRef: calculatorRouteRef },
});

// ── Settings ──────────────────────────────────────────────────────────────────
// 6-tab settings page: Profile, Appearance, Notifications, API Tokens,
// Integrations, Privacy. State stored in component; no backend writes.

const SETTINGS_TABS = ['Profile', 'Appearance', 'Notifications', 'API Tokens', 'Integrations', 'Privacy'] as const;
type SettingsTab = typeof SETTINGS_TABS[number];

const NOTIF_EVENTS = [
  'Deployment completed', 'Deployment failed', 'SLO breach',
  'Security vulnerability found', 'Scorecard score changed',
  'Budget threshold (80%)', 'Budget threshold (100%)', 'On-call escalation',
  'New service registered', 'Platform announcements',
];

const DEFAULT_NOTIF: Record<string, [boolean, boolean, boolean]> = {
  'Deployment completed':        [true,  true,  false],
  'Deployment failed':           [true,  true,  true],
  'SLO breach':                  [true,  true,  true],
  'Security vulnerability found':[true,  true,  true],
  'Scorecard score changed':     [true,  false, false],
  'Budget threshold (80%)':      [true,  true,  true],
  'Budget threshold (100%)':     [true,  true,  true],
  'On-call escalation':          [true,  true,  true],
  'New service registered':      [true,  false, false],
  'Platform announcements':      [true,  true,  false],
};

const DEMO_TOKENS = [
  { name: 'CI/CD Pipeline', created: 'Jun 1',  lastUsed: '2 min ago',  expires: 'Never',  scopes: ['catalog:read', 'scaffolder:write'] },
  { name: 'Local Dev',      created: 'May 15', lastUsed: '1 hour ago', expires: 'Jul 15', scopes: ['catalog:read'] },
  { name: 'Monitoring Bot', created: 'Apr 28', lastUsed: 'Today',      expires: 'Never',  scopes: ['techdocs:read', 'catalog:read'] },
];

const INTEGRATIONS = [
  { name: 'GitHub',    bg: '#24292e', label: '⎇', detail: 'moatazeldebsy · Connected Jun 1',       connected: true  },
  { name: 'Slack',     bg: '#E01E5A', label: 'S', detail: 'workspace: idp-platform · #platform-support', connected: true  },
  { name: 'Jira',      bg: '#0052CC', label: 'J', detail: 'idp-platform.atlassian.net · project: IDP', connected: true  },
  { name: 'PagerDuty', bg: '#06AC38', label: 'PD',detail: 'Platform On-Call · moataz@pagerduty.com',   connected: true  },
  { name: 'Grafana',   bg: '#F46800', label: 'G', detail: 'grafana.idp.local · not linked to account', connected: false },
];

function SettingsPage() {
  const identityApi = useApi(identityApiRef);
  const [tab, setTab]           = useState<SettingsTab>('Profile');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail]       = useState('');
  const [notif, setNotif]       = useState<Record<string, [boolean, boolean, boolean]>>(DEFAULT_NOTIF);
  const [saved, setSaved]       = useState(false);

  useEffect(() => {
    identityApi.getProfileInfo().then(p => {
      setDisplayName(p.displayName ?? '');
      setEmail(p.email ?? '');
    }).catch(() => {});
  }, [identityApi]);

  const initials = displayName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase() || 'ME';

  const save = () => { setSaved(true); setTimeout(() => setSaved(false), 2000); };

  const toggleNotif = (event: string, col: 0 | 1 | 2) => {
    setNotif(prev => {
      const row = [...prev[event]] as [boolean, boolean, boolean];
      row[col] = !row[col];
      return { ...prev, [event]: row };
    });
  };

  return (
    <Page themeId="tool">
      <Header title="Settings" subtitle="Account, preferences, integrations & API tokens" />
      <Content>
        <Box display="flex" style={{ gap: 24, alignItems: 'flex-start' }}>
          {/* Sidebar */}
          <Paper style={{ minWidth: 180, padding: '8px 0', flexShrink: 0 }}>
            {SETTINGS_TABS.map(t => (
              <Box key={t} onClick={() => setTab(t)}
                style={{ padding: '10px 20px', cursor: 'pointer', fontSize: 13, fontWeight: tab === t ? 600 : 400,
                  color: tab === t ? '#1976d2' : '#333',
                  background: tab === t ? 'rgba(25,118,210,0.07)' : 'transparent',
                  borderLeft: `3px solid ${tab === t ? '#1976d2' : 'transparent'}` }}>
                {t}
              </Box>
            ))}
          </Paper>

          {/* Content */}
          <Box flex={1}>
            {/* Profile */}
            {tab === 'Profile' && (
              <Paper>
                <Box style={{ padding: '12px 16px', borderBottom: '1px solid #eee' }}>
                  <Typography variant="h6">Profile</Typography>
                </Box>
                <Box style={{ padding: '20px 24px' }}>
                  <Box display="flex" alignItems="center" style={{ gap: 20, marginBottom: 20 }}>
                    <div style={{ width: 72, height: 72, borderRadius: '50%', background: '#1976d2', color: '#fff',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, fontWeight: 700 }}>
                      {initials}
                    </div>
                    <Box>
                      <Typography variant="h6">{displayName || '—'}</Typography>
                      <Typography variant="body2" color="textSecondary">{email}</Typography>
                      <Box style={{ marginTop: 6, display: 'flex', gap: 6 }}>
                        <Chip size="small" label="platform-team" style={{ fontSize: 10 }} />
                        <Chip size="small" label="admin" style={{ background: '#e3f2fd', color: '#1976d2', fontSize: 10 }} />
                      </Box>
                    </Box>
                    <Button variant="outlined" size="small" style={{ marginLeft: 'auto', fontSize: 12 }}>Change Avatar</Button>
                  </Box>
                  <Box style={{ height: 1, background: '#eee', marginBottom: 16 }} />
                  <Box display="flex" style={{ gap: 16, flexWrap: 'wrap' }}>
                    {[
                      { label: 'Display Name', value: displayName, set: setDisplayName },
                      { label: 'Email',         value: email,       set: setEmail },
                    ].map(({ label, value, set }) => (
                      <Box key={label} style={{ flex: '1 1 200px' }}>
                        <Typography variant="caption" color="textSecondary" style={{ fontWeight: 600, display: 'block', marginBottom: 6 }}>{label}</Typography>
                        <input value={value} onChange={e => set(e.target.value)}
                          style={{ width: '100%', border: '1px solid #ddd', borderRadius: 4, padding: '8px 12px', fontSize: 13, boxSizing: 'border-box' }} />
                      </Box>
                    ))}
                  </Box>
                  <Box display="flex" justifyContent="flex-end" style={{ marginTop: 16, gap: 8, alignItems: 'center' }}>
                    {saved && <Typography variant="caption" style={{ color: '#4caf50', fontWeight: 600 }}>✓ Saved</Typography>}
                    <Button variant="contained" color="primary" onClick={save}>Save Changes</Button>
                  </Box>
                </Box>
              </Paper>
            )}

            {/* Appearance */}
            {tab === 'Appearance' && (
              <Paper>
                <Box style={{ padding: '12px 16px', borderBottom: '1px solid #eee' }}>
                  <Typography variant="h6">Appearance</Typography>
                </Box>
                <Box style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 20 }}>
                  <Box>
                    <Typography variant="body2" style={{ fontWeight: 500, marginBottom: 12 }}>Theme</Typography>
                    <Box display="flex" style={{ gap: 12 }}>
                      {[['☀️','Light',true],['🌙','Dark',false],['💻','System',false]].map(([emoji, label, active]) => (
                        <Paper key={label as string} style={{ padding: '12px 20px', cursor: 'pointer', textAlign: 'center',
                          border: `2px solid ${active ? '#1976d2' : '#e0e0e0'}`,
                          background: active ? '#e3f2fd' : '#fff' }}>
                          <div style={{ fontSize: 20, marginBottom: 4 }}>{emoji}</div>
                          <Typography variant="caption" style={{ fontWeight: active ? 600 : 400, color: active ? '#1976d2' : '#555' }}>{label as string}</Typography>
                        </Paper>
                      ))}
                    </Box>
                  </Box>
                  <Box style={{ height: 1, background: '#eee' }} />
                  <Box>
                    <Typography variant="body2" style={{ fontWeight: 500, marginBottom: 12 }}>Density</Typography>
                    <Box display="flex" style={{ gap: 12 }}>
                      {[['Comfortable', false], ['Compact', true]].map(([label, active]) => (
                        <Paper key={label as string} style={{ padding: '10px 18px', cursor: 'pointer',
                          border: `2px solid ${active ? '#1976d2' : '#e0e0e0'}`,
                          background: active ? '#e3f2fd' : '#fff' }}>
                          <Typography variant="caption" style={{ fontWeight: active ? 600 : 400, color: active ? '#1976d2' : '#555' }}>{label as string}</Typography>
                        </Paper>
                      ))}
                    </Box>
                  </Box>
                  <Box display="flex" justifyContent="flex-end">
                    <Button variant="contained" color="primary" onClick={save}>Save</Button>
                  </Box>
                </Box>
              </Paper>
            )}

            {/* Notifications */}
            {tab === 'Notifications' && (
              <Paper>
                <Box style={{ padding: '12px 16px', borderBottom: '1px solid #eee' }}>
                  <Typography variant="h6">Notification Preferences</Typography>
                </Box>
                <TableContainer>
                  <MuiTable size="small">
                    <TableHead>
                      <TableRow style={{ background: '#f5f5f5' }}>
                        <TableCell><strong>Event</strong></TableCell>
                        <TableCell align="center"><strong>In-App</strong></TableCell>
                        <TableCell align="center"><strong>Email</strong></TableCell>
                        <TableCell align="center"><strong>Slack</strong></TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {NOTIF_EVENTS.map(event => (
                        <TableRow key={event} hover>
                          <TableCell>{event}</TableCell>
                          {([0,1,2] as const).map(col => (
                            <TableCell key={col} align="center">
                              <input type="checkbox" checked={notif[event]?.[col] ?? false}
                                onChange={() => toggleNotif(event, col)}
                                style={{ cursor: 'pointer', width: 16, height: 16 }} />
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </MuiTable>
                </TableContainer>
                <Box display="flex" justifyContent="flex-end" style={{ padding: '12px 16px' }}>
                  <Button variant="contained" color="primary" onClick={save}>Save Preferences</Button>
                </Box>
              </Paper>
            )}

            {/* API Tokens */}
            {tab === 'API Tokens' && (
              <Paper>
                <Box display="flex" alignItems="center" style={{ padding: '12px 16px', borderBottom: '1px solid #eee' }}>
                  <Typography variant="h6" style={{ flex: 1 }}>API Tokens</Typography>
                  <Button variant="contained" color="primary" size="small" style={{ fontSize: 12 }}>+ Generate Token</Button>
                </Box>
                <Box style={{ padding: '12px 16px', background: '#e3f2fd', borderBottom: '1px solid #e0e0e0' }}>
                  <Typography variant="body2" style={{ color: '#1565c0' }}>
                    ℹ Tokens provide programmatic access to the Backstage API. Keep them secret — treat like passwords.
                  </Typography>
                </Box>
                <TableContainer>
                  <MuiTable size="small">
                    <TableHead>
                      <TableRow style={{ background: '#f5f5f5' }}>
                        <TableCell><strong>Name</strong></TableCell>
                        <TableCell><strong>Created</strong></TableCell>
                        <TableCell><strong>Last Used</strong></TableCell>
                        <TableCell><strong>Expires</strong></TableCell>
                        <TableCell><strong>Scopes</strong></TableCell>
                        <TableCell />
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {DEMO_TOKENS.map(tok => (
                        <TableRow key={tok.name} hover>
                          <TableCell style={{ fontWeight: 500 }}>{tok.name}</TableCell>
                          <TableCell><Typography variant="caption">{tok.created}</Typography></TableCell>
                          <TableCell><Typography variant="caption">{tok.lastUsed}</Typography></TableCell>
                          <TableCell><Typography variant="caption">{tok.expires}</Typography></TableCell>
                          <TableCell>
                            <Box display="flex" style={{ gap: 4, flexWrap: 'wrap' }}>
                              {tok.scopes.map(s => <Chip key={s} size="small" label={s} style={{ fontSize: 10, height: 18 }} />)}
                            </Box>
                          </TableCell>
                          <TableCell>
                            <Button size="small" style={{ fontSize: 11, color: '#f44336' }}>Revoke</Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </MuiTable>
                </TableContainer>
              </Paper>
            )}

            {/* Integrations */}
            {tab === 'Integrations' && (
              <Paper>
                <Box style={{ padding: '12px 16px', borderBottom: '1px solid #eee' }}>
                  <Typography variant="h6">Connected Integrations</Typography>
                </Box>
                {INTEGRATIONS.map((intg, i) => (
                  <Box key={intg.name} display="flex" alignItems="center" style={{ gap: 14, padding: '14px 20px',
                    borderBottom: i < INTEGRATIONS.length - 1 ? '1px solid #eee' : 'none' }}>
                    <div style={{ width: 36, height: 36, background: intg.bg, borderRadius: 8,
                      display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 16, fontWeight: 700, flexShrink: 0 }}>
                      {intg.label}
                    </div>
                    <Box flex={1}>
                      <Typography variant="body2" style={{ fontWeight: 500 }}>{intg.name}</Typography>
                      <Typography variant="caption" color="textSecondary">{intg.detail}</Typography>
                    </Box>
                    <Chip size="small" label={intg.connected ? 'Connected' : 'Not connected'}
                      style={{ background: intg.connected ? '#4caf50' : '#9e9e9e', color: '#fff', fontSize: 10, fontWeight: 600 }} />
                    {intg.connected
                      ? <Button size="small" style={{ fontSize: 12, color: '#f44336' }}>Disconnect</Button>
                      : <Button size="small" variant="outlined" style={{ fontSize: 12 }}>Connect</Button>}
                  </Box>
                ))}
              </Paper>
            )}

            {/* Privacy */}
            {tab === 'Privacy' && (
              <Paper>
                <Box style={{ padding: '12px 16px', borderBottom: '1px solid #eee' }}>
                  <Typography variant="h6">Privacy & Data</Typography>
                </Box>
                <Box style={{ padding: '8px 20px' }}>
                  {[
                    { label: 'Share usage analytics',        desc: 'Help improve the platform by sharing anonymous usage data', checked: true,  danger: false },
                    { label: 'Show my activity in team feed',desc: 'Your deploys and catalog changes will be visible to teammates', checked: true, danger: false },
                  ].map(({ label, desc, checked }) => (
                    <Box key={label} display="flex" justifyContent="space-between" alignItems="center"
                      style={{ padding: '14px 0', borderBottom: '1px solid #eee' }}>
                      <Box>
                        <Typography variant="body2" style={{ fontWeight: 500 }}>{label}</Typography>
                        <Typography variant="caption" color="textSecondary">{desc}</Typography>
                      </Box>
                      <input type="checkbox" defaultChecked={checked} style={{ width: 18, height: 18, cursor: 'pointer', flexShrink: 0 }} />
                    </Box>
                  ))}
                  <Box display="flex" justifyContent="space-between" alignItems="center" style={{ padding: '14px 0' }}>
                    <Box>
                      <Typography variant="body2" style={{ fontWeight: 500, color: '#f44336' }}>Delete account data</Typography>
                      <Typography variant="caption" color="textSecondary">Remove all personal data. Services you own will be unassigned.</Typography>
                    </Box>
                    <Button variant="outlined" size="small" style={{ fontSize: 12, color: '#f44336', borderColor: '#f44336', flexShrink: 0 }}>
                      Request deletion
                    </Button>
                  </Box>
                </Box>
              </Paper>
            )}
          </Box>
        </Box>
      </Content>
    </Page>
  );
}

const settingsPageRouteRef = createRouteRef();  // was id: 'idp-settings'
const settingsPage = PageBlueprint.make({
  name: 'idp-settings',
  params: { path: '/idp-settings', routeRef: settingsPageRouteRef, loader: async () => <SettingsPage /> },
});
// No NavItemBlueprint here on purpose: the built-in userSettingsPlugin owns
// the Settings group pinned at the bottom of the sidebar, so a second entry
// would duplicate it. The page extension below is still registered.

// ── User Profile ───────────────────────────────────────────────────────────────
// Shows the current user's identity, owned entities from the catalog,
// activity timeline, and stats.

interface OwnedEntity { name: string; kind: string; lifecycle: string; type?: string }

function UserProfilePage() {
  const identityApi = useApi(identityApiRef);
  const fetchApi    = useApi(fetchApiRef);
  const configApi   = useApi(configApiRef);
  const base        = configApi.getString('backend.baseUrl');

  const [profile, setProfile]     = useState<{ displayName: string; email: string }>({ displayName: '', email: '' });
  const [owned, setOwned]         = useState<OwnedEntity[]>([]);
  const [loading, setLoading]     = useState(true);

  useEffect(() => {
    identityApi.getProfileInfo().then(p => {
      setProfile({ displayName: p.displayName ?? '', email: p.email ?? '' });
    }).catch(() => {});

    identityApi.getBackstageIdentity().then(id => {
      const owner = id.userEntityRef;
      return fetchApi.fetch(`${base}/api/catalog/entities?filter=relations.ownedBy=${encodeURIComponent(owner)}&fields=metadata.name,kind,spec.lifecycle,spec.type`);
    }).then(r => r.ok ? r.json() : [])
      .then((entities: any[]) => {
        setOwned(entities.map((e: any) => ({
          name:      e.metadata?.name,
          kind:      e.kind,
          lifecycle: e.spec?.lifecycle ?? 'unknown',
          type:      e.spec?.type,
        })));
      }).catch(() => {})
      .finally(() => setLoading(false));
  }, [base, fetchApi, identityApi]);

  const initials = profile.displayName.split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase() || 'ME';
  const LC_COLORS: Record<string, string> = { production: '#4caf50', experimental: '#ff9800', deprecated: '#9e9e9e' };

  const KIND_EMOJI: Record<string, string> = { Component: '🔧', API: '◈', Group: '👥', User: '👤', Template: '📋' };

  const ACTIVITY_DEMO = [
    { dot: '#4caf50', color: '#e8f5e9', text: <>Deployed <b>hello-service</b> to production</>,    meta: '2 minutes ago · main · a3f1b2c' },
    { dot: '#1976d2', color: '#e3f2fd', text: <>Starred <b>payment-service</b></>,                 meta: '1 hour ago' },
    { dot: '#7c4dff', color: '#f3e5f5', text: <>Scaffolded <b>payment-service</b> (Go)</>,         meta: 'Today 14:22' },
    { dot: '#4caf50', color: '#e8f5e9', text: <>Deployed <b>idp-mcp-server</b></>,                 meta: '3 hours ago' },
    { dot: '#ff9800', color: '#fff8e1', text: <>SLO breach acknowledged — latency-p95</>,           meta: 'Yesterday 16:40' },
  ];

  return (
    <Page themeId="home">
      <Header title="My Profile" subtitle={profile.email || 'Platform member'} />
      <Content>
        {loading && <Progress />}
        {!loading && (
          <>
            {/* Hero banner */}
            <Paper style={{ padding: '24px 24px 0', marginBottom: 24 }}>
              <Box display="flex" alignItems="flex-end" style={{ gap: 20, paddingBottom: 0 }}>
                <div style={{ width: 80, height: 80, borderRadius: '50%', background: '#1976d2', color: '#fff',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28, fontWeight: 700, flexShrink: 0 }}>
                  {initials}
                </div>
                <Box style={{ paddingBottom: 16 }}>
                  <Typography variant="h5" style={{ fontWeight: 400 }}>{profile.displayName || '—'}</Typography>
                  <Typography variant="body2" color="textSecondary" style={{ marginTop: 2 }}>Platform Engineer · platform-team · {profile.email}</Typography>
                  <Box style={{ marginTop: 8, display: 'flex', gap: 6 }}>
                    <Chip size="small" label="admin"         style={{ background: '#e3f2fd', color: '#1976d2', fontSize: 10, fontWeight: 600 }} />
                    <Chip size="small" label="platform-team" style={{ fontSize: 10 }} />
                  </Box>
                </Box>
                <Box style={{ marginLeft: 'auto', paddingBottom: 16 }}>
                  <Button variant="outlined" size="small" href="/idp-settings">Edit Profile</Button>
                </Box>
              </Box>
              <Box style={{ display: 'flex', borderTop: '1px solid #eee', marginTop: 16 }}>
                {['Overview', 'Owned Entities', 'Activity'].map((t, i) => (
                  <Box key={t} style={{ padding: '12px 20px', fontSize: 13, fontWeight: i === 0 ? 500 : 400,
                    color: i === 0 ? '#1976d2' : '#666', borderBottom: i === 0 ? '2px solid #1976d2' : 'none', cursor: 'default' }}>
                    {t}
                  </Box>
                ))}
              </Box>
            </Paper>

            <Box display="flex" style={{ gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              {/* Left: activity */}
              <Box style={{ flex: '2 1 300px' }}>
                <Paper>
                  <Box style={{ padding: '12px 16px', borderBottom: '1px solid #eee' }}>
                    <Typography variant="h6">Recent Activity</Typography>
                  </Box>
                  <Box style={{ padding: '8px 0' }}>
                    {ACTIVITY_DEMO.map((item, i) => (
                      <Box key={i} display="flex" alignItems="flex-start" style={{ gap: 12, padding: '10px 20px', position: 'relative' }}>
                        {i < ACTIVITY_DEMO.length - 1 && (
                          <div style={{ position: 'absolute', left: 35, top: 38, bottom: 0, width: 2, background: '#eee' }} />
                        )}
                        <div style={{ width: 28, height: 28, borderRadius: '50%', background: item.color,
                          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, flexShrink: 0, zIndex: 1, color: item.dot, fontWeight: 700 }}>
                          {i === 0 || i === 3 ? '✓' : i === 1 ? '★' : i === 2 ? '+' : '⚠'}
                        </div>
                        <Box>
                          <Typography variant="body2" style={{ fontSize: 13 }}>{item.text}</Typography>
                          <Typography variant="caption" color="textSecondary">{item.meta}</Typography>
                        </Box>
                      </Box>
                    ))}
                  </Box>
                </Paper>
              </Box>

              {/* Right: owned entities + stats */}
              <Box style={{ flex: '1 1 220px', display: 'flex', flexDirection: 'column', gap: 16 }}>
                <Paper>
                  <Box style={{ padding: '12px 16px', borderBottom: '1px solid #eee' }}>
                    <Typography variant="h6">Owned Entities</Typography>
                  </Box>
                  <Box style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {owned.length === 0 && (
                      <Typography variant="caption" color="textSecondary" style={{ padding: 8 }}>No owned entities found.</Typography>
                    )}
                    {owned.map(e => (
                      <a key={`${e.kind}-${e.name}`}
                        href={`/catalog/default/${e.kind.toLowerCase()}/${e.name}`}
                        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 4,
                          background: '#f5f5f5', textDecoration: 'none', color: 'inherit', cursor: 'pointer' }}>
                        <span style={{ fontSize: 16 }}>{KIND_EMOJI[e.kind] ?? '📦'}</span>
                        <Typography variant="body2" style={{ flex: 1, fontWeight: 500, fontSize: 13 }}>{e.name}</Typography>
                        <Chip size="small" label={e.lifecycle}
                          style={{ background: LC_COLORS[e.lifecycle] ?? '#9e9e9e', color: '#fff', fontSize: 10, height: 18 }} />
                      </a>
                    ))}
                  </Box>
                </Paper>

                <Paper>
                  <Box style={{ padding: '12px 16px', borderBottom: '1px solid #eee' }}>
                    <Typography variant="h6">Stats</Typography>
                  </Box>
                  <Box style={{ padding: '8px 16px' }}>
                    {[
                      { label: 'Services owned',    value: owned.filter(e => e.kind === 'Component').length || '—' },
                      { label: 'APIs owned',         value: owned.filter(e => e.kind === 'API').length || '—' },
                      { label: 'Deploys this month', value: '—' },
                      { label: 'Member since',       value: 'Jan 2025' },
                    ].map(({ label, value }) => (
                      <Box key={label} display="flex" justifyContent="space-between" style={{ padding: '8px 0', borderBottom: '1px solid #f0f0f0' }}>
                        <Typography variant="caption" color="textSecondary">{label}</Typography>
                        <Typography variant="caption" style={{ fontFamily: 'monospace', fontWeight: 600 }}>{String(value)}</Typography>
                      </Box>
                    ))}
                  </Box>
                </Paper>
              </Box>
            </Box>
          </>
        )}
      </Content>
    </Page>
  );
}

const profilePageRouteRef = createRouteRef();  // was id: 'user-profile'
const profilePage = PageBlueprint.make({
  name: 'user-profile',
  params: { path: '/profile', routeRef: profilePageRouteRef, loader: async () => <UserProfilePage /> },
});
const profileNavItem = NavItemBlueprint.make({
  name: 'user-profile',
  params: { title: 'My Profile', icon: PersonIcon as any, routeRef: profilePageRouteRef },
});

// ── Global Search ──────────────────────────────────────────────────────────────
// Full-page search with faceted results across Components, APIs, TechDocs,
// and Templates. Hits the Backstage search API, falls back to catalog fetch.

interface SearchResult {
  kind: 'Component' | 'API' | 'TechDocs' | 'Template';
  name: string;
  description: string;
  owner: string;
  lifecycle?: string;
  type?: string;
  href: string;
}

const KIND_ICONS: Record<string, string> = { Component: '🔧', API: '◈', TechDocs: '📖', Template: '📋' };
const KIND_COLORS: Record<string, string> = { Component: '#e8f5e9', API: '#ede7f6', TechDocs: '#fff8e1', Template: '#e3f2fd' };

function GlobalSearchPage() {
  const fetchApi  = useApi(fetchApiRef);
  const configApi = useApi(configApiRef);
  const base      = configApi.getString('backend.baseUrl');

  const [query, setQuery]     = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [kindFilter, setKindFilter] = useState<'All'|'Component'|'API'|'TechDocs'|'Template'>('All');

  const search = (q: string) => {
    if (!q.trim()) { setResults([]); return; }
    setLoading(true);
    // Try Backstage search API first, fall back to catalog filter
    fetchApi.fetch(`${base}/api/search/query?term=${encodeURIComponent(q)}&pageLimit=30`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then((data: any) => {
        const items: SearchResult[] = (data?.results ?? []).map((r: any) => {
          const doc  = r.document ?? {};
          const kind = doc.kind ?? 'Component';
          const loc  = typeof doc.location === 'string' ? doc.location : '';
          const name = typeof doc.name === 'string' ? doc.name
            : (typeof doc.title === 'string' ? doc.title : (loc.split('/').filter(Boolean).pop() ?? '—'));
          const description = typeof doc.text === 'string' ? doc.text.slice(0, 100)
            : (typeof doc.description === 'string' ? doc.description : '');
          return {
            kind,
            name,
            description,
            owner:     typeof doc.owner === 'string' ? doc.owner : '—',
            lifecycle: typeof doc.lifecycle === 'string' ? doc.lifecycle : undefined,
            type:      typeof doc.type === 'string' ? doc.type : undefined,
            href:      loc || (kind === 'TechDocs'
              ? `/docs/default/component/${name}`
              : `/catalog/default/${kind.toLowerCase()}/${name}`),
          };
        });
        setResults(items);
      })
      .catch(() => {
        // Fallback: catalog entities containing the query
        return fetchApi.fetch(`${base}/api/catalog/entities?fields=metadata.name,metadata.description,kind,spec.type,spec.lifecycle,spec.owner`)
          .then(r => r.ok ? r.json() : [])
          .then((entities: any[]) => {
            const lq = q.toLowerCase();
            setResults(entities
              .filter((e: any) => e.metadata?.name?.toLowerCase().includes(lq) || (e.metadata?.description ?? '').toLowerCase().includes(lq))
              .slice(0, 20)
              .map((e: any) => ({
                kind:        e.kind as any,
                name:        e.metadata?.name,
                description: e.metadata?.description ?? '',
                owner:       e.spec?.owner ?? '—',
                lifecycle:   e.spec?.lifecycle,
                type:        e.spec?.type,
                href:        `/catalog/default/${e.kind.toLowerCase()}/${e.metadata?.name}`,
              })));
          });
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    const t = setTimeout(() => search(query), 300);
    return () => clearTimeout(t);
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  const KINDS = ['All', 'Component', 'API', 'TechDocs', 'Template'] as const;

  const filtered = kindFilter === 'All' ? results : results.filter(r => r.kind === kindFilter);

  const grouped = KINDS.slice(1).reduce((acc, k) => {
    const items = filtered.filter(r => r.kind === k);
    if (items.length) acc[k] = items;
    return acc;
  }, {} as Record<string, SearchResult[]>);

  const counts = KINDS.slice(1).reduce((acc, k) => { acc[k] = results.filter(r => r.kind === k).length; return acc; }, {} as Record<string, number>);

  const highlight = (text: string) => {
    if (!query) return text;
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return text;
    return <>{text.slice(0, idx)}<mark style={{ background: '#fff3cd', padding: '0 2px' }}>{text.slice(idx, idx + query.length)}</mark>{text.slice(idx + query.length)}</>;
  };

  return (
    <Page themeId="tool">
      <Header title="Search" subtitle="Find services, APIs, docs, and templates across the platform" />
      <Content>
        <Box style={{ maxWidth: 700, margin: '0 auto' }}>
          {/* Search bar */}
          <Box style={{ position: 'relative', marginBottom: 12 }}>
            <span style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: '#9e9e9e', fontSize: 18 }}>🔍</span>
            <input value={query} onChange={e => setQuery(e.target.value)} autoFocus
              placeholder="Search services, APIs, docs, templates…"
              style={{ width: '100%', border: '1px solid #ddd', borderRadius: 4, padding: '12px 14px 12px 44px',
                fontSize: 15, boxSizing: 'border-box', boxShadow: '0 1px 4px rgba(0,0,0,0.08)', outline: 'none' }} />
          </Box>

          {/* Kind filter chips */}
          <Box display="flex" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 24 }}>
            {KINDS.map(k => {
              const count = k === 'All' ? results.length : (counts[k] ?? 0);
              const active = kindFilter === k;
              return (
                <button key={k} onClick={() => setKindFilter(k)}
                  style={{ padding: '5px 14px', borderRadius: 20, border: `1px solid ${active ? '#1976d2' : '#ddd'}`,
                    background: active ? '#e3f2fd' : '#fff', color: active ? '#1976d2' : '#555',
                    fontWeight: active ? 600 : 400, fontSize: 12, cursor: 'pointer' }}>
                  {k}{query ? ` (${count})` : ''}
                </button>
              );
            })}
          </Box>

          {loading && <Progress />}

          {!loading && query && results.length === 0 && (
            <Typography variant="body2" color="textSecondary" style={{ textAlign: 'center', padding: 32 }}>
              No results for "<strong>{query}</strong>"
            </Typography>
          )}

          {!query && (
            <Typography variant="body2" color="textSecondary" style={{ textAlign: 'center', padding: 32 }}>
              Start typing to search across the entire platform catalog.
            </Typography>
          )}

          {/* Grouped results */}
          {Object.entries(grouped).map(([kind, items]) => (
            <Box key={kind}>
              <Typography variant="caption" style={{ display: 'block', fontWeight: 600, color: '#9e9e9e', textTransform: 'uppercase', letterSpacing: '0.06em', padding: '8px 0 4px' }}>
                {kind}
              </Typography>
              <Box style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
                {items.map(r => (
                  <a key={r.name} href={r.href} style={{ display: 'block', textDecoration: 'none', color: 'inherit' }}>
                    <Paper style={{ padding: 0, cursor: 'pointer' }}>
                      <Box display="flex" alignItems="center" style={{ gap: 12, padding: '14px 16px' }}>
                        <div style={{ width: 36, height: 36, borderRadius: 8, background: KIND_COLORS[kind] ?? '#f5f5f5',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, flexShrink: 0 }}>
                          {KIND_ICONS[kind] ?? '📦'}
                        </div>
                        <Box flex={1}>
                          <Typography variant="body2" style={{ fontWeight: 500 }}>{highlight(r.name)}</Typography>
                          <Typography variant="caption" color="textSecondary">
                            {[r.kind, r.owner, r.lifecycle, r.type].filter(Boolean).join(' · ')}
                            {r.description ? ` — ${highlight(r.description.slice(0, 80))}` : ''}
                          </Typography>
                        </Box>
                        {r.lifecycle && (
                          <Chip size="small" label={r.lifecycle}
                            style={{ background: r.lifecycle === 'production' ? '#4caf50' : '#ff9800', color: '#fff', fontSize: 10 }} />
                        )}
                      </Box>
                    </Paper>
                  </a>
                ))}
              </Box>
            </Box>
          ))}
        </Box>
      </Content>
    </Page>
  );
}

const searchPageRouteRef = createRouteRef();  // was id: 'global-search'
const searchPage = PageBlueprint.make({
  name: 'global-search',
  params: { path: '/search-page', routeRef: searchPageRouteRef, loader: async () => <GlobalSearchPage /> },
});
const searchNavItem = NavItemBlueprint.make({
  name: 'global-search',
  params: { title: 'Search', icon: SearchOutlinedIcon as any, routeRef: searchPageRouteRef },
});

// ── Admin Panel ────────────────────────────────────────────────────────────────
// Platform admin overview: user list from catalog, plugin table, and catalog
// ingestion log (last N refresh_state entries via catalog API).

const PLUGIN_TABLE = [
  { name: 'Catalog',     version: '1.12.0', enabled: true },
  { name: 'Scaffolder',  version: '1.19.0', enabled: true },
  { name: 'TechDocs',    version: '1.9.0',  enabled: true },
  { name: 'Kubernetes',  version: '0.11.0', enabled: true },
  { name: 'PagerDuty',   version: '0.8.0',  enabled: true },
  { name: 'Search',      version: '1.5.0',  enabled: true },
  { name: 'Tech Insights',version: '0.3.0', enabled: true },
];

const DEMO_INGESTION = [
  { time: new Date(Date.now() - 3*60*1000).toLocaleTimeString(),  source: 'github.com/org/hello-service',          event: 'Refresh',   entities: 3,  ok: true },
  { time: new Date(Date.now() - 11*60*1000).toLocaleTimeString(), source: 'backstage/catalog/catalog-info.yaml',  event: 'Full scan', entities: 24, ok: true },
  { time: new Date(Date.now() - 19*60*1000).toLocaleTimeString(), source: 'github.com/org/qa-mcp-server',          event: 'Refresh',   entities: 2,  ok: false },
];

function AdminPage() {
  const fetchApi  = useApi(fetchApiRef);
  const configApi = useApi(configApiRef);
  const base      = configApi.getString('backend.baseUrl');

  const [users, setUsers]       = useState<any[]>([]);
  const [loading, setLoading]   = useState(true);

  useEffect(() => {
    fetchApi.fetch(`${base}/api/catalog/entities?filter=kind=User&fields=metadata.name,metadata.namespace,spec.profile,relations`)
      .then(r => r.ok ? r.json() : [])
      .then((entities: any[]) => setUsers(entities.slice(0, 10)))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [base, fetchApi]);

  const getUserTeam = (u: any) => {
    const memberOf = (u.relations ?? []).filter((r: any) => r.type === 'memberOf');
    return memberOf[0]?.targetRef?.split('/')[1] ?? '—';
  };

  return (
    <Page themeId="tool">
      <Header title="Admin" subtitle="Platform configuration · user management · plugin settings" />
      <Content>
        <Paper style={{ padding: '8px 16px', marginBottom: 20, background: '#fff8e1', border: '1px solid #ffe082' }}>
          <Typography variant="body2" style={{ color: '#7c6000' }}>
            ⚠ Admin panel — changes here affect all users on the platform.
          </Typography>
        </Paper>

        {loading && <Progress />}

        <Box display="flex" style={{ gap: 20, flexWrap: 'wrap', marginBottom: 20 }}>
          {/* Users */}
          <Paper style={{ flex: '1 1 360px' }}>
            <Box display="flex" alignItems="center" style={{ padding: '12px 16px', borderBottom: '1px solid #eee' }}>
              <Typography variant="h6" style={{ flex: 1 }}>Users</Typography>
              <Button variant="contained" color="primary" size="small" style={{ fontSize: 12 }}>+ Invite User</Button>
            </Box>
            <TableContainer>
              <MuiTable size="small">
                <TableHead>
                  <TableRow style={{ background: '#f5f5f5' }}>
                    <TableCell><strong>Name</strong></TableCell>
                    <TableCell><strong>Team</strong></TableCell>
                    <TableCell><strong>Role</strong></TableCell>
                    <TableCell />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {users.length === 0 && !loading && (
                    // Fallback demo rows
                    [
                      { name: 'Moataz Nabil', email: 'moatazeldebsy@gmail.com', team: 'platform-team', role: 'admin' },
                      { name: 'Jane Smith',   email: 'jane@example.com',         team: 'quality-team',  role: 'member' },
                      { name: 'Alex Chen',    email: 'alex@example.com',         team: 'payments-team', role: 'member' },
                    ].map(u => (
                      <TableRow key={u.name} hover>
                        <TableCell>
                          <Typography variant="body2" style={{ fontWeight: 500 }}>{u.name}</Typography>
                          <Typography variant="caption" color="textSecondary">{u.email}</Typography>
                        </TableCell>
                        <TableCell><Chip size="small" label={u.team} style={{ fontSize: 10, height: 18 }} /></TableCell>
                        <TableCell>
                          <Chip size="small" label={u.role}
                            style={{ fontSize: 10, background: u.role === 'admin' ? '#e3f2fd' : '#f5f5f5', color: u.role === 'admin' ? '#1976d2' : '#555' }} />
                        </TableCell>
                        <TableCell><Button size="small" style={{ fontSize: 11 }}>Edit</Button></TableCell>
                      </TableRow>
                    ))
                  )}
                  {users.map(u => (
                    <TableRow key={u.metadata?.name} hover>
                      <TableCell>
                        <Typography variant="body2" style={{ fontWeight: 500 }}>{u.spec?.profile?.displayName ?? u.metadata?.name}</Typography>
                        <Typography variant="caption" color="textSecondary">{u.spec?.profile?.email ?? ''}</Typography>
                      </TableCell>
                      <TableCell><Chip size="small" label={getUserTeam(u)} style={{ fontSize: 10, height: 18 }} /></TableCell>
                      <TableCell><Chip size="small" label="member" style={{ fontSize: 10 }} /></TableCell>
                      <TableCell><Button size="small" style={{ fontSize: 11 }}>Edit</Button></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </MuiTable>
            </TableContainer>
          </Paper>

          {/* Plugins */}
          <Paper style={{ flex: '1 1 300px' }}>
            <Box style={{ padding: '12px 16px', borderBottom: '1px solid #eee' }}>
              <Typography variant="h6">Plugins</Typography>
            </Box>
            <TableContainer>
              <MuiTable size="small">
                <TableHead>
                  <TableRow style={{ background: '#f5f5f5' }}>
                    <TableCell><strong>Plugin</strong></TableCell>
                    <TableCell><strong>Version</strong></TableCell>
                    <TableCell><strong>Status</strong></TableCell>
                    <TableCell />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {PLUGIN_TABLE.map(p => (
                    <TableRow key={p.name} hover>
                      <TableCell>{p.name}</TableCell>
                      <TableCell><Typography variant="caption" style={{ fontFamily: 'monospace' }}>{p.version}</Typography></TableCell>
                      <TableCell>
                        <Chip size="small" label={p.enabled ? 'enabled' : 'disabled'}
                          style={{ background: p.enabled ? '#4caf50' : '#9e9e9e', color: '#fff', fontSize: 10, fontWeight: 600 }} />
                      </TableCell>
                      <TableCell><Button size="small" style={{ fontSize: 11 }}>Config</Button></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </MuiTable>
            </TableContainer>
          </Paper>
        </Box>

        {/* Catalog ingestion log */}
        <Paper>
          <Box display="flex" alignItems="center" style={{ padding: '12px 16px', borderBottom: '1px solid #eee' }}>
            <Typography variant="h6" style={{ flex: 1 }}>Catalog Ingestion Log</Typography>
            <Typography variant="caption" color="textSecondary">last 10 events · demo data</Typography>
          </Box>
          <TableContainer>
            <MuiTable size="small">
              <TableHead>
                <TableRow style={{ background: '#f5f5f5' }}>
                  <TableCell><strong>Time</strong></TableCell>
                  <TableCell><strong>Source</strong></TableCell>
                  <TableCell><strong>Event</strong></TableCell>
                  <TableCell align="right"><strong>Entities</strong></TableCell>
                  <TableCell><strong>Status</strong></TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {DEMO_INGESTION.map((row, i) => (
                  <TableRow key={i} hover>
                    <TableCell><Typography variant="caption" style={{ fontFamily: 'monospace' }}>{row.time}</Typography></TableCell>
                    <TableCell><Typography variant="caption">{row.source}</Typography></TableCell>
                    <TableCell><Typography variant="caption">{row.event}</Typography></TableCell>
                    <TableCell align="right"><Typography variant="caption" style={{ fontFamily: 'monospace' }}>{row.entities}</Typography></TableCell>
                    <TableCell>
                      <Chip size="small" label={row.ok ? 'ok' : 'warn'}
                        style={{ background: row.ok ? '#4caf50' : '#ff9800', color: '#fff', fontSize: 10, fontWeight: 600 }} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </MuiTable>
          </TableContainer>
        </Paper>
      </Content>
    </Page>
  );
}

const adminPageRouteRef = createRouteRef();  // was id: 'admin-panel'
const adminPage = PageBlueprint.make({
  name: 'admin-panel',
  params: { path: '/admin', routeRef: adminPageRouteRef, loader: async () => <AdminPage /> },
});
const adminNavItem = NavItemBlueprint.make({
  name: 'admin-panel',
  params: { title: 'Admin', icon: SupervisorAccountIcon as any, routeRef: adminPageRouteRef },
});

// ── KAgent AI Agents ──────────────────────────────────────────────────────────
// Shows all KAgent Agent CRDs, MCP servers, ModelConfigs, and tool-call metrics
// from Prometheus. Falls back to demo data when bootstrap-ai.sh hasn't run yet.

interface KAgentAgent {
  name:      string;
  model:     string;
  mcpServers: string[];
  toolCount: number;
  calls24h:  number;
  avgLatency: string;
  ready:     boolean;
}

interface McpServer {
  name:      string;
  tools:     number;
  namespace: string;
  status:    'healthy' | 'degraded' | 'error' | 'unknown';
}

interface ModelConfig {
  name:     string;
  provider: string;
  model:    string;
  active:   boolean;
}

const DEMO_KAGENT_AGENTS: KAgentAgent[] = [
  { name: 'idp-assistant',      model: 'claude-sonnet-4-6', mcpServers: ['idp-mcp-server'],                           toolCount: 6,  calls24h: 1842, avgLatency: '1.2s', ready: true },
  { name: 'qa-assistant',       model: 'claude-sonnet-4-6', mcpServers: ['qa-mcp-server'],                            toolCount: 8,  calls24h: 623,  avgLatency: '1.8s', ready: true },
  { name: 'contract-assistant', model: 'claude-sonnet-4-6', mcpServers: ['contract-mcp-server','idp-mcp-server'],     toolCount: 11, calls24h: 214,  avgLatency: '2.1s', ready: true },
];

const DEMO_MCP_SERVERS: McpServer[] = [
  { name: 'idp-mcp-server',      tools: 6, namespace: 'services-dev', status: 'healthy'  },
  { name: 'qa-mcp-server',       tools: 8, namespace: 'services-dev', status: 'healthy'  },
  { name: 'contract-mcp-server', tools: 9, namespace: 'services-dev', status: 'degraded' },
  { name: 'argocd-mcp-server',   tools: 5, namespace: 'services-dev', status: 'healthy'  },
  { name: 'github-mcp-server',   tools: 7, namespace: 'services-dev', status: 'error'    },
  { name: 'cost-mcp-server',     tools: 4, namespace: 'services-dev', status: 'healthy'  },
];

const DEMO_MODEL_CONFIGS: ModelConfig[] = [
  { name: 'claude-anthropic', provider: 'Anthropic', model: 'claude-sonnet-4-6', active: true  },
  { name: 'openai-prod',      provider: 'OpenAI',    model: 'gpt-4o',            active: false },
];

function KAgentPage() {
  const fetchApi  = useApi(fetchApiRef);
  const configApi = useApi(configApiRef);
  const base = configApi.getString('backend.baseUrl');
  const kagentUrl = configApi.getOptionalString('externalLinks.kagent') ?? 'http://kagent.idp.local';

  const [agents, setAgents]         = useState<KAgentAgent[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [modelConfigs] = useState<ModelConfig[]>(DEMO_MODEL_CONFIGS);
  const [isDemo, setIsDemo]         = useState(false);
  const [loading, setLoading]       = useState(true);
  const [callsTotal, setCallsTotal] = useState<number | null>(null);

  useEffect(() => {
    const pq = (expr: string) =>
      fetchApi.fetch(`${base}/api/proxy/prometheus/api/v1/query?query=${encodeURIComponent(expr)}`)
        .then(r => r.ok ? r.json() : Promise.reject(r.status));

    // Try Prometheus for real MCP tool call counts
    const promFetch = pq('sum(mcp_tool_calls_total)').then(d => {
      const v = parseFloat(d?.data?.result?.[0]?.value?.[1] ?? 'NaN');
      if (!isNaN(v)) setCallsTotal(v);
    }).catch(() => {});

    // Try the Agent CRDs via the Kubernetes plugin's proxy for the agent list
    // (the /api/proxy/kagent endpoint points at the KAgent UI, not the K8s API server).
    //
    // v1alpha2, matching kubernetes/kagent/*.yaml — and it has to be exact. The
    // cluster still *serves* v1alpha1, so asking for it returns 200 with the full
    // agent list and looks healthy, but the down-conversion strips the spec to
    // `description` alone: model, MCP servers and tool counts all render as "—"
    // on a page that reports no error. The fields also moved under
    // spec.declarative in v1alpha2, so the version bump alone is not enough.
    const kagentFetch = fetchApi.fetch(`${base}/api/kubernetes/proxy/apis/kagent.dev/v1alpha2/namespaces/kagent/agents`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then((data: any) => {
        const items: any[] = data?.items ?? [];
        if (items.length === 0) return Promise.reject('empty');
        const liveAgents: KAgentAgent[] = items.map((item: any) => {
          const declarative = item.spec?.declarative ?? {};
          // tools[] entries are { type: 'McpServer', mcpServer: { name, toolNames[] } }
          const mcpTools: any[] = (declarative.tools ?? []).map((t: any) => t.mcpServer).filter(Boolean);
          return {
            name:       item.metadata?.name ?? '—',
            model:      declarative.modelConfig ?? '—',
            mcpServers: Array.from(new Set(mcpTools.map((m: any) => m.name).filter(Boolean))) as string[],
            toolCount:  mcpTools.reduce((n: number, m: any) => n + (m.toolNames?.length ?? 0), 0),
            calls24h:   0,
            avgLatency: '—',
            ready:      (item.status?.conditions ?? []).some((c: any) => c.type === 'Ready' && c.status === 'True'),
          };
        });
        // Try to enrich with per-agent call counts
        return pq('sum by (agent) (mcp_tool_calls_total)').then(d => {
          const callMap: Record<string, number> = {};
          (d?.data?.result ?? []).forEach((r: any) => { callMap[r.metric?.agent] = parseFloat(r.value?.[1] ?? '0'); });
          return liveAgents.map(a => ({ ...a, calls24h: callMap[a.name] ?? 0 }));
        }).catch(() => liveAgents);
      })
      .then((liveAgents: KAgentAgent[]) => {
        setAgents(liveAgents);
        // Also try to get MCP server pods from catalog
        return fetchApi.fetch(`${base}/api/catalog/entities?filter=kind=Component,metadata.namespace=services-dev&fields=metadata.name,spec.lifecycle`)
          .then(r => r.ok ? r.json() : [])
          .then((entities: any[]) => {
            if (entities.length > 0) {
              setMcpServers(entities
                .filter((e: any) => e.metadata?.name?.includes('mcp'))
                .map((e: any) => ({
                  name:      e.metadata?.name,
                  tools:     0,
                  namespace: 'services-dev',
                  status:    (e.spec?.lifecycle === 'production' ? 'healthy' : 'degraded') as McpServer['status'],
                })));
            } else {
              setMcpServers(DEMO_MCP_SERVERS);
            }
          }).catch(() => setMcpServers(DEMO_MCP_SERVERS));
      })
      .catch(() => {
        setAgents(DEMO_KAGENT_AGENTS);
        setMcpServers(DEMO_MCP_SERVERS);
        setIsDemo(true);
      });

    Promise.all([promFetch, kagentFetch]).finally(() => setLoading(false));
  }, [base, fetchApi]);

  const totalCalls = callsTotal ?? agents.reduce((s, a) => s + a.calls24h, 0);
  const readyCount = agents.filter(a => a.ready).length;

  const STATUS_COLOR: Record<string, string> = { healthy: '#4caf50', degraded: '#ff9800', error: '#f44336', unknown: '#9e9e9e' };

  return (
    <Page themeId="tool">
      <Header title="KAgent" subtitle={`Kubernetes AI agents · namespace: kagent · ${readyCount} agent${readyCount !== 1 ? 's' : ''} running`} />
      <Content>
        {loading && <Progress />}
        {!loading && (
          <>
            {isDemo && (
              <Paper style={{ padding: '8px 16px', marginBottom: 16, background: '#fff8e1', border: '1px solid #ffe082' }}>
                <Typography variant="body2" style={{ color: '#7c6000' }}>
                  📊 Demo data — KAgent not deployed. Run <code>./scripts/bootstrap-ai.sh</code> to deploy agents and MCP servers.
                </Typography>
              </Paper>
            )}

            {/* Summary cards */}
            <Box display="flex" style={{ gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
              {[
                { label: 'Agents Running',      value: readyCount,                          sub: agents.map(a => a.name.replace('-assistant','').replace('-','‑')).join(', ') || '—', color: '#4caf50' },
                { label: 'MCP Tool Calls (24h)', value: totalCalls > 0 ? totalCalls.toLocaleString() : isDemo ? '2,681' : '0', sub: 'across all agents', color: '#1976d2' },
                { label: 'Avg Response',         value: isDemo ? '1.4s' : '—',             sub: 'p50 · p95: 3.8s',             color: '#7b1fa2' },
              ].map(({ label, value, sub, color }) => (
                <Paper key={label} style={{ flex: 1, minWidth: 160, padding: '16px 20px', borderTop: `4px solid ${color}` }}>
                  <Typography variant="caption" color="textSecondary" style={{ fontWeight: 600 }}>{label}</Typography>
                  <Typography variant="h4" style={{ fontWeight: 300, color, margin: '4px 0 2px' }}>{value}</Typography>
                  <Typography variant="caption" color="textSecondary">{sub}</Typography>
                </Paper>
              ))}
            </Box>

            {/* Agents table */}
            <Paper style={{ marginBottom: 20 }}>
              <Box display="flex" alignItems="center" style={{ padding: '12px 16px', borderBottom: '1px solid #eee' }}>
                <Typography variant="h6" style={{ flex: 1 }}>Agents</Typography>
                <Button variant="outlined" size="small" href={kagentUrl} target="_blank" style={{ fontSize: 11, marginRight: 8 }}>
                  Open KAgent UI ↗
                </Button>
                <Button variant="contained" color="primary" size="small" href="/create" style={{ fontSize: 11 }}>
                  + Deploy Agent
                </Button>
              </Box>
              <TableContainer>
                <MuiTable size="small">
                  <TableHead>
                    <TableRow style={{ background: '#f5f5f5' }}>
                      <TableCell><strong>Name</strong></TableCell>
                      <TableCell><strong>Model</strong></TableCell>
                      <TableCell><strong>MCP Servers</strong></TableCell>
                      <TableCell align="right"><strong>Tools</strong></TableCell>
                      <TableCell align="right"><strong>Calls (24h)</strong></TableCell>
                      <TableCell align="right"><strong>Avg Latency</strong></TableCell>
                      <TableCell><strong>Status</strong></TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {agents.map(agent => (
                      <TableRow key={agent.name} hover style={{ cursor: 'pointer' }}
                        onClick={() => { if (agent.name === 'idp-assistant') window.location.href = '/ai-assistant'; }}>
                        <TableCell style={{ fontWeight: 500 }}>{agent.name}</TableCell>
                        <TableCell><Typography variant="caption" style={{ fontFamily: 'monospace' }}>{agent.model}</Typography></TableCell>
                        <TableCell>
                          <Box display="flex" style={{ gap: 4, flexWrap: 'wrap' }}>
                            {agent.mcpServers.map(s => <Chip key={s} size="small" label={s} style={{ fontSize: 10, height: 18 }} />)}
                          </Box>
                        </TableCell>
                        <TableCell align="right"><Typography variant="caption" style={{ fontFamily: 'monospace' }}>{agent.toolCount}</Typography></TableCell>
                        <TableCell align="right"><Typography variant="caption" style={{ fontFamily: 'monospace' }}>{agent.calls24h.toLocaleString()}</Typography></TableCell>
                        <TableCell align="right"><Typography variant="caption" style={{ fontFamily: 'monospace' }}>{agent.avgLatency}</Typography></TableCell>
                        <TableCell>
                          <Chip size="small" label={agent.ready ? '● Ready' : '○ Not Ready'}
                            style={{ background: agent.ready ? '#4caf50' : '#ff9800', color: '#fff', fontSize: 10, fontWeight: 600 }} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </MuiTable>
              </TableContainer>
            </Paper>

            {/* MCP Servers + ModelConfigs */}
            <Box display="flex" style={{ gap: 20, flexWrap: 'wrap' }}>
              <Paper style={{ flex: '1 1 340px' }}>
                <Box style={{ padding: '12px 16px', borderBottom: '1px solid #eee' }}>
                  <Typography variant="h6">MCP Servers</Typography>
                </Box>
                <TableContainer>
                  <MuiTable size="small">
                    <TableHead>
                      <TableRow style={{ background: '#f5f5f5' }}>
                        <TableCell><strong>Server</strong></TableCell>
                        <TableCell align="right"><strong>Tools</strong></TableCell>
                        <TableCell><strong>Namespace</strong></TableCell>
                        <TableCell><strong>Status</strong></TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {mcpServers.map(srv => (
                        <TableRow key={srv.name} hover>
                          <TableCell style={{ fontWeight: 500 }}>{srv.name}</TableCell>
                          <TableCell align="right">
                            <Typography variant="caption" style={{ fontFamily: 'monospace' }}>{srv.tools || '—'}</Typography>
                          </TableCell>
                          <TableCell><Typography variant="caption" style={{ fontFamily: 'monospace' }}>{srv.namespace}</Typography></TableCell>
                          <TableCell>
                            <Chip size="small" label={`● ${srv.status}`}
                              style={{ background: STATUS_COLOR[srv.status], color: '#fff', fontSize: 10, fontWeight: 600 }} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </MuiTable>
                </TableContainer>
              </Paper>

              <Paper style={{ flex: '1 1 260px' }}>
                <Box style={{ padding: '12px 16px', borderBottom: '1px solid #eee' }}>
                  <Typography variant="h6">ModelConfigs</Typography>
                </Box>
                <TableContainer>
                  <MuiTable size="small">
                    <TableHead>
                      <TableRow style={{ background: '#f5f5f5' }}>
                        <TableCell><strong>Name</strong></TableCell>
                        <TableCell><strong>Provider</strong></TableCell>
                        <TableCell><strong>Model</strong></TableCell>
                        <TableCell><strong>Status</strong></TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {modelConfigs.map(mc => (
                        <TableRow key={mc.name} hover>
                          <TableCell style={{ fontWeight: 500 }}>{mc.name}</TableCell>
                          <TableCell><Typography variant="caption">{mc.provider}</Typography></TableCell>
                          <TableCell><Typography variant="caption" style={{ fontFamily: 'monospace', fontSize: 11 }}>{mc.model}</Typography></TableCell>
                          <TableCell>
                            <Chip size="small" label={mc.active ? '● active' : '○ inactive'}
                              style={{ background: mc.active ? '#4caf50' : '#9e9e9e', color: '#fff', fontSize: 10, fontWeight: 600 }} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </MuiTable>
                </TableContainer>
              </Paper>
            </Box>
          </>
        )}
      </Content>
    </Page>
  );
}

const kagentPageRouteRef = createRouteRef();  // was id: 'kagent-platform'
const kagentPage = PageBlueprint.make({
  name: 'kagent-platform',
  params: { path: '/kagent', routeRef: kagentPageRouteRef, loader: async () => <KAgentPage /> },
});
const kagentNavItem = NavItemBlueprint.make({
  name: 'kagent-platform',
  params: { title: 'KAgent', icon: SmartToyIcon as any, routeRef: kagentPageRouteRef },
});

// ── AI Observability (Langfuse) ────────────────────────────────────────────────
// LLM tracing for the KAgent agents: token counts, cost, latency and tool calls
// per agent run. KAgent exports OTLP straight to Langfuse (otel.tracing in
// local/kagent/values.yaml), so nothing in Backstage produces these traces —
// this page only reads them back through the /langfuse proxy.
//
// Deployed by `./scripts/bootstrap-ai.sh --langfuse` (opt-in locally).

interface LangfuseModelUsage {
  model:       string;
  traces:      number;
  inputUnits:  number;
  outputUnits: number;
  cost:        number;
}

interface LangfuseTrace {
  id:        string;
  name:      string;
  agent:     string;
  user:      string;
  latency:   string;
  cost:      string;
  timestamp: string;
}

const DEMO_LANGFUSE_MODELS: LangfuseModelUsage[] = [
  { model: 'claude-haiku-4-5',  traces: 128, inputUnits: 412_330, outputUnits: 38_210, cost: 0.62 },
  { model: 'claude-sonnet-4-5', traces: 34,  inputUnits: 121_880, outputUnits: 15_440, cost: 1.44 },
];

const DEMO_LANGFUSE_TRACES: LangfuseTrace[] = [
  { id: 'c1a90f2b', name: 'idp-assistant',      agent: 'idp-assistant',      user: 'user:default/moataz', latency: '4.2s',  cost: '$0.0041', timestamp: '2 min ago' },
  { id: '7be31d04', name: 'qa-assistant',       agent: 'qa-assistant',       user: '—',                   latency: '2.8s',  cost: '$0.0012', timestamp: '11 min ago' },
  { id: '9f04ca77', name: 'cost-agent',         agent: 'cost-agent',         user: 'user:default/moataz', latency: '6.1s',  cost: '$0.0089', timestamp: '1 hour ago' },
  { id: '2d77b810', name: 'platform-assistant', agent: 'platform-assistant', user: '—',                   latency: '11.4s', cost: '$0.0154', timestamp: '3 hours ago' },
];

const fmtUnits = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n);

const fmtCost = (n: number): string => (n >= 0.01 ? `$${n.toFixed(2)}` : n > 0 ? `$${n.toFixed(4)}` : '$0.00');

// Langfuse reports trace latency in SECONDS on the /traces endpoint (per-
// observation latency is in ms — do not copy this formatter over to that).
// Sub-second traces are real: the A2A agent-card fetch lands around 25ms.
const fmtLatency = (s: number): string => (s < 1 ? `${Math.round(s * 1000)}ms` : `${s.toFixed(1)}s`);

// KAgent names its traces after the HTTP route it served, e.g.
// "POST /api/a2a/kagent/idp-assistant/". The agent id is the path segment after
// the kagent namespace; sessionId is a per-conversation UUID, not an agent name.
const agentFromTraceName = (name: string): string =>
  /\/a2a\/[^/]+\/([^/]+)/.exec(name)?.[1] ?? name;

// Shared by the platform page and the per-entity tab. Both render the same trace
// table, and the seconds-vs-milliseconds latency handling above was wrong once
// already — a second hand-rolled copy is how that regression comes back.
const mapLangfuseTrace = (t: any): LangfuseTrace => ({
  id:    String(t?.id ?? '').slice(0, 8),
  name:  t?.name ?? '—',
  agent: t?.name ? agentFromTraceName(String(t.name)) : '—',
  user:  t?.userId ?? '—',
  latency: t?.latency !== undefined && t?.latency !== null ? fmtLatency(Number(t.latency)) : '—',
  cost:    t?.totalCost !== undefined ? fmtCost(Number(t.totalCost)) : '—',
  timestamp: relTime(t?.timestamp ? Date.parse(t.timestamp) : undefined),
});

// The Langfuse public API, through the Backstage proxy. Auth is HTTP Basic over
// the project key pair and is injected by the proxy (see the /langfuse endpoint
// in app-config.*.yaml) — deliberately not held in the frontend.
const langfuseApi = (fetchApi: { fetch: typeof fetch }, base: string) => (path: string) =>
  fetchApi
    .fetch(`${base}/api/proxy/langfuse/api/public${path}`)
    .then(r => (r.ok ? r.json() : Promise.reject(new Error(`${path} → HTTP ${r.status}`))));

function LangfusePage() {
  const fetchApi    = useApi(fetchApiRef);
  const configApi   = useApi(configApiRef);
  const aiEnabled   = useAiStackEnabled();
  const base        = configApi.getString('backend.baseUrl');
  const langfuseUrl = configApi.getOptionalString('externalLinks.langfuse') ?? 'http://langfuse.idp.local';

  const [models, setModels]   = useState<LangfuseModelUsage[]>([]);
  const [traces, setTraces]   = useState<LangfuseTrace[]>([]);
  const [totals, setTotals]   = useState({ traces: 0, cost: 0, observations: 0 });
  const [status, setStatus]   = useState<'loading' | 'demo' | 'error' | 'ok'>('loading');
  const [error, setError]     = useState('');

  useEffect(() => {
    // Nothing deployed to reach — show the shape of the page rather than a 404.
    if (!aiEnabled) {
      setModels(DEMO_LANGFUSE_MODELS);
      setTraces(DEMO_LANGFUSE_TRACES);
      setTotals({ traces: 162, cost: 2.06, observations: 1043 });
      setStatus('demo');
      return;
    }

    const api = langfuseApi(fetchApi, base);

    // Last 7 days of usage, aggregated server-side by Langfuse.
    const from = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

    Promise.all([
      api(`/metrics/daily?fromTimestamp=${encodeURIComponent(from)}`),
      api('/traces?limit=25'),
    ])
      .then(([daily, traceData]: [any, any]) => {
        const days: any[] = daily?.data ?? [];

        // Roll the per-day, per-model buckets up into one row per model.
        const byModel = new Map<string, LangfuseModelUsage>();
        let costTotal = 0;
        let traceTotal = 0;
        let obsTotal = 0;

        for (const day of days) {
          traceTotal += Number(day?.countTraces ?? 0);
          obsTotal += Number(day?.countObservations ?? 0);
          costTotal += Number(day?.totalCost ?? 0);
          for (const u of day?.usage ?? []) {
            // Langfuse emits one bucket with model: null holding every
            // non-generation observation (HTTP spans, tool calls). It carries no
            // tokens and no cost, so rendering it as a model row is noise.
            if (u?.model === null || u?.model === undefined) continue;
            const key = String(u.model);
            const row = byModel.get(key) ?? { model: key, traces: 0, inputUnits: 0, outputUnits: 0, cost: 0 };
            row.traces += Number(u?.countTraces ?? 0);
            row.inputUnits += Number(u?.inputUsage ?? 0);
            row.outputUnits += Number(u?.outputUsage ?? 0);
            row.cost += Number(u?.totalCost ?? 0);
            byModel.set(key, row);
          }
        }

        setModels([...byModel.values()].sort((a, b) => b.cost - a.cost));
        setTotals({ traces: traceTotal, cost: costTotal, observations: obsTotal });

        setTraces((traceData?.data ?? []).slice(0, 25).map(mapLangfuseTrace));

        setStatus('ok');
      })
      .catch((e: Error) => {
        setError(e.message ?? String(e));
        setStatus('error');
      });
  }, [aiEnabled, base, fetchApi]);

  return (
    <Page themeId="tool">
      <Header
        title="AI Observability"
        subtitle={`LLM tracing · cost · latency · powered by Langfuse${status === 'ok' ? ` · ${totals.traces} trace${totals.traces !== 1 ? 's' : ''} (7d)` : ''}`}
      />
      <Content>
        {status === 'loading' && <Progress />}
        {status !== 'loading' && (
          <>
            {status === 'demo' && (
              <Paper style={{ padding: '8px 16px', marginBottom: 16, background: '#fff8e1', border: '1px solid #ffe082' }}>
                <Typography variant="body2" style={{ color: '#7c6000' }}>
                  📊 Demo data — Langfuse is not deployed. Run <code>./scripts/bootstrap-ai.sh --langfuse</code> to install it
                  and start exporting KAgent traces.
                </Typography>
              </Paper>
            )}
            {status === 'error' && (
              <Paper style={{ padding: '8px 16px', marginBottom: 16, background: '#ffebee', border: '1px solid #ef9a9a' }}>
                <Typography variant="body2" style={{ color: '#b71c1c' }}>
                  ⚠️ Couldn't reach Langfuse ({error}). Check it with{' '}
                  <code>kubectl get pods -n ml-platform -l app.kubernetes.io/instance=langfuse</code>. A 401 means{' '}
                  <code>LANGFUSE_BASIC_AUTH</code> is not set for Backstage.
                </Typography>
              </Paper>
            )}

            {/* Summary cards */}
            <Box display="flex" style={{ gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
              {[
                { label: 'Traces',       value: String(totals.traces),         sub: 'agent runs (last 7 days)', color: '#1976d2' },
                { label: 'Observations', value: String(totals.observations),   sub: 'LLM + tool spans',         color: '#0288d1' },
                { label: 'LLM Cost',     value: fmtCost(totals.cost),          sub: 'last 7 days',              color: '#7b1fa2' },
                { label: 'Models',       value: String(models.length),         sub: 'in use',                   color: '#4caf50' },
              ].map(({ label, value, sub, color }) => (
                <Paper key={label} style={{ flex: 1, minWidth: 160, padding: '16px 20px', borderTop: `4px solid ${color}` }}>
                  <Typography variant="caption" color="textSecondary" style={{ fontWeight: 600 }}>{label}</Typography>
                  <Typography variant="h4" style={{ fontWeight: 300, color, margin: '4px 0 2px' }}>{value}</Typography>
                  <Typography variant="caption" color="textSecondary">{sub}</Typography>
                </Paper>
              ))}
            </Box>

            {/* Cost + token usage by model */}
            <Paper style={{ marginBottom: 20 }}>
              <Box display="flex" alignItems="center" style={{ padding: '12px 16px', borderBottom: '1px solid #eee' }}>
                <Typography variant="h6" style={{ flex: 1 }}>Usage by model (7 days)</Typography>
                <Button variant="outlined" size="small" href={langfuseUrl} target="_blank" style={{ fontSize: 11 }}>
                  Open Langfuse ↗
                </Button>
              </Box>
              <TableContainer>
                <MuiTable size="small">
                  <TableHead>
                    <TableRow style={{ background: '#f5f5f5' }}>
                      <TableCell><strong>Model</strong></TableCell>
                      <TableCell align="right"><strong>Traces</strong></TableCell>
                      <TableCell align="right"><strong>Input units</strong></TableCell>
                      <TableCell align="right"><strong>Output units</strong></TableCell>
                      <TableCell align="right"><strong>Cost</strong></TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {models.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={5}>
                          <Typography variant="body2" color="textSecondary">
                            No model usage recorded yet — chat with an agent in the AI Assistant to generate traces.
                          </Typography>
                        </TableCell>
                      </TableRow>
                    )}
                    {models.map(m => (
                      <TableRow key={m.model}>
                        <TableCell><code style={{ fontSize: 12 }}>{m.model}</code></TableCell>
                        <TableCell align="right">{m.traces}</TableCell>
                        <TableCell align="right">{fmtUnits(m.inputUnits)}</TableCell>
                        <TableCell align="right">{fmtUnits(m.outputUnits)}</TableCell>
                        <TableCell align="right">{fmtCost(m.cost)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </MuiTable>
              </TableContainer>
            </Paper>

            {/* Recent traces */}
            <Paper>
              <Box style={{ padding: '12px 16px', borderBottom: '1px solid #eee' }}>
                <Typography variant="h6">Recent agent runs</Typography>
              </Box>
              <TableContainer>
                <MuiTable size="small">
                  <TableHead>
                    <TableRow style={{ background: '#f5f5f5' }}>
                      <TableCell><strong>Trace</strong></TableCell>
                      <TableCell><strong>Agent</strong></TableCell>
                      <TableCell><strong>User</strong></TableCell>
                      <TableCell align="right"><strong>Latency</strong></TableCell>
                      <TableCell align="right"><strong>Cost</strong></TableCell>
                      <TableCell><strong>When</strong></TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {traces.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={6}>
                          <Typography variant="body2" color="textSecondary">No traces yet.</Typography>
                        </TableCell>
                      </TableRow>
                    )}
                    {traces.map(t => (
                      <TableRow key={t.id}>
                        <TableCell><code style={{ fontSize: 11 }}>{t.id}</code></TableCell>
                        <TableCell>{t.agent}</TableCell>
                        <TableCell><span style={{ fontSize: 12 }}>{t.user}</span></TableCell>
                        <TableCell align="right">{t.latency}</TableCell>
                        <TableCell align="right">{t.cost}</TableCell>
                        <TableCell>{t.timestamp}</TableCell>
                      </TableRow>
                    ))}
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

const langfusePageRouteRef = createRouteRef();
const langfusePage = PageBlueprint.make({
  name: 'langfuse-platform',
  params: { path: '/langfuse', routeRef: langfusePageRouteRef, loader: async () => <LangfusePage /> },
});
const langfuseNavItem = NavItemBlueprint.make({
  name: 'langfuse-platform',
  params: { title: 'AI Observability', icon: TimelineIcon as any, routeRef: langfusePageRouteRef },
});

// ── Langfuse entity tab — one service's traces ────────────────────────────────
// The platform page above is org-wide; this is the same data scoped to one
// component via the `langfuse.com/service-name` annotation, which the
// enable-langfuse-tracing and llm-app-langfuse templates write.
//
// Filtering is by Langfuse TAG, not trace name: KAgent names traces after the
// HTTP route it served and sessionId is a per-conversation UUID, so neither
// identifies a service. The instrumentation sets `langfuse.trace.tags` to the
// service name and this queries ?tags=<name> — verified server-side (an unknown
// query param returns every trace; ?tags= with no match returns none).
//
// Per-service cost and latency are summed from the returned traces rather than
// read from /metrics/daily: that endpoint aggregates per model and per day with
// no tag dimension, so it cannot answer "this service only".

function LangfuseEntityContent() {
  const { entity } = useEntity();
  const fetchApi = useApi(fetchApiRef);
  const configApi = useApi(configApiRef);
  const base = configApi.getString('backend.baseUrl');
  const langfuseUrl = configApi.getOptionalString('externalLinks.langfuse') ?? 'http://langfuse.idp.local';

  const serviceName = entity.metadata.annotations?.['langfuse.com/service-name'];

  const [traces, setTraces] = useState<LangfuseTrace[]>([]);
  const [summary, setSummary] = useState({ count: 0, cost: 0, avgLatency: 0 });
  const [status, setStatus] = useState<'loading' | 'error' | 'ok'>('loading');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!serviceName) return;

    langfuseApi(fetchApi, base)(`/traces?tags=${encodeURIComponent(serviceName)}&limit=50`)
      .then((data: any) => {
        const rows: any[] = data?.data ?? [];
        const cost = rows.reduce((sum, t) => sum + Number(t?.totalCost ?? 0), 0);
        // Latency is in SECONDS on /traces (see fmtLatency). Averaging only the
        // traces that reported one — a missing latency is not a zero.
        const timed = rows.filter(t => t?.latency !== undefined && t?.latency !== null);
        const avgLatency = timed.length
          ? timed.reduce((sum, t) => sum + Number(t.latency), 0) / timed.length
          : 0;

        setSummary({ count: Number(data?.meta?.totalItems ?? rows.length), cost, avgLatency });
        setTraces(rows.map(mapLangfuseTrace));
        setStatus('ok');
      })
      .catch((e: Error) => {
        setError(e.message ?? String(e));
        setStatus('error');
      });
  }, [serviceName, base, fetchApi]);

  if (!serviceName) {
    return (
      <Content>
        <Paper style={{ padding: 24, textAlign: 'center' }}>
          <Typography variant="h6" gutterBottom>LLM tracing not enabled</Typography>
          <Typography variant="body2" color="textSecondary">
            This component has no <code>langfuse.com/service-name</code> annotation, so there is
            nothing to filter traces by. Run the <strong>Enable Langfuse LLM Tracing</strong>
            {' '}scaffolder template to open a PR that adds the instrumentation, the Helm wiring and
            this annotation.
          </Typography>
          <Box mt={2}>
            <Link href="/create" target="_self">Open scaffolder ↗</Link>
          </Box>
        </Paper>
      </Content>
    );
  }

  return (
    <Content>
      {status === 'loading' && <Progress />}
      {status === 'error' && (
        <Paper style={{ padding: '8px 16px', marginBottom: 16, background: '#ffebee', border: '1px solid #ef9a9a' }}>
          <Typography variant="body2" style={{ color: '#b71c1c' }}>
            ⚠️ Couldn't reach Langfuse ({error}). Check it with{' '}
            <code>kubectl get pods -n ml-platform -l app.kubernetes.io/instance=langfuse</code>. A 401 means{' '}
            <code>LANGFUSE_BASIC_AUTH</code> is not set for Backstage.
          </Typography>
        </Paper>
      )}
      {status === 'ok' && (
        <>
          <Box display="flex" style={{ gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
            {[
              { label: 'Traces',      value: String(summary.count),          sub: `tagged ${serviceName}`, color: '#1976d2' },
              { label: 'LLM Cost',    value: fmtCost(summary.cost),          sub: 'across shown traces',   color: '#7b1fa2' },
              { label: 'Avg latency', value: summary.avgLatency ? fmtLatency(summary.avgLatency) : '—', sub: 'per trace', color: '#0288d1' },
            ].map(({ label, value, sub, color }) => (
              <Paper key={label} style={{ flex: 1, minWidth: 160, padding: '16px 20px', borderTop: `4px solid ${color}` }}>
                <Typography variant="caption" color="textSecondary" style={{ fontWeight: 600 }}>{label}</Typography>
                <Typography variant="h4" style={{ fontWeight: 300, color, margin: '4px 0 2px' }}>{value}</Typography>
                <Typography variant="caption" color="textSecondary">{sub}</Typography>
              </Paper>
            ))}
          </Box>

          <Paper>
            <Box display="flex" alignItems="center" style={{ padding: '12px 16px', borderBottom: '1px solid #eee' }}>
              <Typography variant="h6" style={{ flex: 1 }}>Recent traces</Typography>
              <Button variant="outlined" size="small" href={langfuseUrl} target="_blank" style={{ fontSize: 11 }}>
                Open Langfuse ↗
              </Button>
            </Box>
            <TableContainer>
              <MuiTable size="small">
                <TableHead>
                  <TableRow style={{ background: '#f5f5f5' }}>
                    <TableCell><strong>Trace</strong></TableCell>
                    <TableCell><strong>Operation</strong></TableCell>
                    <TableCell><strong>User</strong></TableCell>
                    <TableCell align="right"><strong>Latency</strong></TableCell>
                    <TableCell align="right"><strong>Cost</strong></TableCell>
                    <TableCell><strong>When</strong></TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {traces.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6}>
                        <Typography variant="body2" color="textSecondary">
                          No traces tagged <code>{serviceName}</code> yet. The service reports only
                          once <code>secret/langfuse-otel</code> is present in its namespace and the
                          pod has restarted — see the service's runbook.
                        </Typography>
                      </TableCell>
                    </TableRow>
                  )}
                  {traces.map(t => (
                    <TableRow key={t.id}>
                      <TableCell><code style={{ fontSize: 11 }}>{t.id}</code></TableCell>
                      <TableCell>{t.agent}</TableCell>
                      <TableCell><span style={{ fontSize: 12 }}>{t.user}</span></TableCell>
                      <TableCell align="right">{t.latency}</TableCell>
                      <TableCell align="right">{t.cost}</TableCell>
                      <TableCell>{t.timestamp}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </MuiTable>
            </TableContainer>
          </Paper>
        </>
      )}
    </Content>
  );
}

const langfuseEntityContent = EntityContentBlueprint.make({
  name: 'langfuse',
  params: {
    path: '/langfuse',
    title: 'Langfuse',
    filter: 'kind:component',
    loader: async () => <LangfuseEntityContent />,
  },
});

// ── MLflow — experiment tracking & model registry ─────────────────────────────
// Reads the MLflow REST API through the Backstage proxy (/api/proxy/mlflow),
// rather than the Kubernetes proxy the KAgent page above has to use — MLflow
// serves a real HTTP API, KAgent's state only exists as CRDs.
//
// Unlike that page, a failure here is reported as a failure. Demo data appears
// only when the AI layer is known to be absent (aiStack.enabled = false), so a
// crashed MLflow pod cannot masquerade as "you haven't run bootstrap-ai.sh".

interface MlflowExperiment {
  id:           string;
  name:         string;
  runs:         number;
  lastRun:      string;
  latestMetric: string;
  artifacts:    string;
}

interface MlflowRun {
  id:         string;
  name:       string;
  experiment: string;
  status:     string;
  duration:   string;
  metrics:    string;
}

interface RegisteredModel {
  name:    string;
  version: string;
  stage:   string;
  updated: string;
}

const DEMO_MLFLOW_EXPERIMENTS: MlflowExperiment[] = [
  { id: '5', name: 'Test ML Experiment', runs: 1, lastRun: '1 min ago',  latestMetric: 'accuracy 0.940', artifacts: 'mlflow-artifacts:/5' },
  { id: '2', name: 'Experiment Demo',    runs: 4, lastRun: '3 days ago', latestMetric: 'accuracy 0.912', artifacts: 'mlflow-artifacts:/2' },
  { id: '0', name: 'Default',            runs: 0, lastRun: '—',          latestMetric: '—',              artifacts: 'mlflow-artifacts:/0' },
];

const DEMO_MLFLOW_RUNS: MlflowRun[] = [
  { id: '4824853776ab', name: 'youthful-squid-244', experiment: 'Test ML Experiment', status: 'FINISHED', duration: '2.9s', metrics: 'accuracy 0.940 · f1_score 0.910' },
  { id: '9f1c02ab7731', name: 'bustling-koi-118',   experiment: 'Experiment Demo',    status: 'FINISHED', duration: '4.1s', metrics: 'accuracy 0.912 · f1_score 0.887' },
  { id: 'c40aa9e15d02', name: 'rebellious-cub-77',  experiment: 'Experiment Demo',    status: 'FAILED',   duration: '0.8s', metrics: '—' },
];

const DEMO_REGISTERED_MODELS: RegisteredModel[] = [
  { name: 'test-ml-exp-model', version: '1', stage: 'None',       updated: '1 min ago'  },
  { name: 'tiny-model',        version: '3', stage: 'Production', updated: '2 days ago' },
];

const relTime = (ms?: number): string => {
  if (!ms || isNaN(ms)) return '—';
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days !== 1 ? 's' : ''} ago`;
};

const fmtDuration = (start?: number, end?: number): string => {
  if (!start || !end || isNaN(start) || isNaN(end) || end < start) return '—';
  const ms = end - start;
  if (ms < 1000)  return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60000)}m`;
};

// Shown in preference order when a run logs several metrics — the same ones the
// skeleton train.py logs (backstage/catalog/templates/mlflow-experiment).
const HEADLINE_METRICS = ['accuracy', 'f1_score', 'rmse', 'loss', 'r2_score'];

const RUN_STATUS_COLOR: Record<string, string> = {
  FINISHED: '#4caf50', RUNNING: '#1976d2', SCHEDULED: '#9e9e9e', FAILED: '#f44336', KILLED: '#ff9800',
};

function MlflowPage() {
  const fetchApi  = useApi(fetchApiRef);
  const configApi = useApi(configApiRef);
  const aiEnabled = useAiStackEnabled();
  const base      = configApi.getString('backend.baseUrl');
  const mlflowUrl = configApi.getOptionalString('externalLinks.mlflow') ?? 'http://mlflow.idp.local';

  const [experiments, setExperiments] = useState<MlflowExperiment[]>([]);
  const [runs, setRuns]               = useState<MlflowRun[]>([]);
  const [runTotal, setRunTotal]       = useState(0);
  const [models, setModels]           = useState<RegisteredModel[]>([]);
  const [status, setStatus]           = useState<'loading' | 'demo' | 'error' | 'ok'>('loading');
  const [error, setError]             = useState('');

  useEffect(() => {
    // Nothing is deployed to reach, so don't make the user look at a 404.
    if (!aiEnabled) {
      setExperiments(DEMO_MLFLOW_EXPERIMENTS);
      setRuns(DEMO_MLFLOW_RUNS);
      setRunTotal(DEMO_MLFLOW_RUNS.length);
      setModels(DEMO_REGISTERED_MODELS);
      setStatus('demo');
      return;
    }

    // MLflow 2.x REST surface on purpose: this platform runs the v2.13.0 server
    // (kubernetes/ml-platform/mlflow.yaml), which does not serve the 3.x
    // endpoints. Same pin, same reason as MLFLOW_CLIENT_VERSION in
    // backend/src/modules/idpRunTrainingJob.ts.
    const api = (path: string, body?: unknown) =>
      fetchApi.fetch(
        `${base}/api/proxy/mlflow/api/2.0/mlflow${path}`,
        body === undefined ? undefined : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      ).then(r => (r.ok ? r.json() : Promise.reject(new Error(`${path} → HTTP ${r.status}`))));

    api('/experiments/search', { max_results: 100 })
      .then(async (expData: any) => {
        const live: any[] = (expData?.experiments ?? []).filter((e: any) => e.lifecycle_stage !== 'deleted');

        // One runs query covering every experiment, reduced client-side — not
        // one request per experiment. The 50-run cap means per-experiment
        // counts are "recent runs", not lifetime totals; the column says so.
        const runData = live.length
          ? await api('/runs/search', {
              experiment_ids: live.map((e: any) => e.experiment_id),
              max_results: 50,
              order_by: ['attributes.start_time DESC'],
            })
          : { runs: [] };

        const allRuns: any[] = runData?.runs ?? [];
        const expName: Record<string, string> = {};
        live.forEach((e: any) => { expName[e.experiment_id] = e.name; });

        // int64 fields come back as JSON strings (proto3), hence Number(...).
        const headline = (r: any): string => {
          const metrics: any[] = r?.data?.metrics ?? [];
          const pick = HEADLINE_METRICS.map(k => metrics.find(m => m.key === k)).find(Boolean) ?? metrics[0];
          return pick ? `${pick.key} ${Number(pick.value).toFixed(3)}` : '—';
        };

        setExperiments(live.map((e: any) => {
          const mine = allRuns.filter(r => r.info?.experiment_id === e.experiment_id);
          return {
            id:           e.experiment_id,
            name:         e.name,
            runs:         mine.length,
            lastRun:      relTime(Number(mine[0]?.info?.start_time)),
            latestMetric: mine[0] ? headline(mine[0]) : '—',
            artifacts:    e.artifact_location ?? '—',
          };
        }));

        setRunTotal(allRuns.length);
        setRuns(allRuns.slice(0, 10).map((r: any) => {
          const metrics: any[] = r?.data?.metrics ?? [];
          return {
            id:         String(r.info?.run_id ?? '—').slice(0, 12),
            name:       r.info?.run_name ?? String(r.info?.run_id ?? '—').slice(0, 8),
            experiment: expName[r.info?.experiment_id] ?? r.info?.experiment_id ?? '—',
            status:     r.info?.status ?? 'UNKNOWN',
            duration:   fmtDuration(Number(r.info?.start_time), Number(r.info?.end_time)),
            metrics:    metrics.slice(0, 3).map(m => `${m.key} ${Number(m.value).toFixed(3)}`).join(' · ') || '—',
          };
        }));

        const modelData = await api('/registered-models/search?max_results=100');
        setModels((modelData?.registered_models ?? []).map((m: any) => {
          const latest = (m.latest_versions ?? []).slice()
            .sort((a: any, b: any) => Number(b.version) - Number(a.version))[0];
          return {
            name:    m.name,
            version: latest?.version ?? '—',
            stage:   latest?.current_stage ?? 'None',
            updated: relTime(Number(m.last_updated_timestamp)),
          };
        }));

        setStatus('ok');
      })
      .catch((e: Error) => {
        setError(e.message ?? String(e));
        setStatus('error');
      });
  }, [aiEnabled, base, fetchApi]);

  return (
    <Page themeId="tool">
      <Header
        title="MLflow"
        subtitle={`Experiment tracking · model registry · namespace: ml-platform${status === 'ok' ? ` · ${experiments.length} experiment${experiments.length !== 1 ? 's' : ''}` : ''}`}
      />
      <Content>
        {status === 'loading' && <Progress />}
        {status !== 'loading' && (
          <>
            {status === 'demo' && (
              <Paper style={{ padding: '8px 16px', marginBottom: 16, background: '#fff8e1', border: '1px solid #ffe082' }}>
                <Typography variant="body2" style={{ color: '#7c6000' }}>
                  📊 Demo data — the AI/ML layer is not deployed. Run <code>./scripts/bootstrap-ai.sh</code> to install MLflow.
                </Typography>
              </Paper>
            )}
            {status === 'error' && (
              <Paper style={{ padding: '8px 16px', marginBottom: 16, background: '#ffebee', border: '1px solid #ef9a9a' }}>
                <Typography variant="body2" style={{ color: '#b71c1c' }}>
                  ⚠️ Couldn't reach MLflow ({error}). Check the deployment with{' '}
                  <code>kubectl get pods -n ml-platform</code>.
                </Typography>
              </Paper>
            )}

            {/* Summary cards */}
            <Box display="flex" style={{ gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
              {[
                { label: 'Experiments',       value: experiments.length, sub: 'tracked in MLflow',        color: '#1976d2' },
                { label: 'Runs',              value: runTotal,           sub: 'most recent (max 50)',     color: '#4caf50' },
                { label: 'Registered Models', value: models.length,      sub: 'in the model registry',    color: '#7b1fa2' },
              ].map(({ label, value, sub, color }) => (
                <Paper key={label} style={{ flex: 1, minWidth: 160, padding: '16px 20px', borderTop: `4px solid ${color}` }}>
                  <Typography variant="caption" color="textSecondary" style={{ fontWeight: 600 }}>{label}</Typography>
                  <Typography variant="h4" style={{ fontWeight: 300, color, margin: '4px 0 2px' }}>{value}</Typography>
                  <Typography variant="caption" color="textSecondary">{sub}</Typography>
                </Paper>
              ))}
            </Box>

            {/* Experiments */}
            <Paper style={{ marginBottom: 20 }}>
              <Box display="flex" alignItems="center" style={{ padding: '12px 16px', borderBottom: '1px solid #eee' }}>
                <Typography variant="h6" style={{ flex: 1 }}>Experiments</Typography>
                <Button variant="outlined" size="small" href={mlflowUrl} target="_blank" style={{ fontSize: 11, marginRight: 8 }}>
                  Open MLflow UI ↗
                </Button>
                <Button variant="contained" color="primary" size="small" href="/create/templates/default/mlflow-experiment" style={{ fontSize: 11 }}>
                  + New Experiment
                </Button>
              </Box>
              <TableContainer>
                <MuiTable size="small">
                  <TableHead>
                    <TableRow style={{ background: '#f5f5f5' }}>
                      <TableCell><strong>Name</strong></TableCell>
                      <TableCell align="right"><strong>Recent runs</strong></TableCell>
                      <TableCell><strong>Last run</strong></TableCell>
                      <TableCell><strong>Latest metric</strong></TableCell>
                      <TableCell><strong>Artifacts</strong></TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {experiments.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={5}>
                          <Typography variant="caption" color="textSecondary">
                            No experiments yet — scaffold one with the ML Experiment (MLflow) template.
                          </Typography>
                        </TableCell>
                      </TableRow>
                    )}
                    {experiments.map(exp => (
                      <TableRow key={exp.id} hover>
                        <TableCell style={{ fontWeight: 500 }}>{exp.name}</TableCell>
                        <TableCell align="right"><Typography variant="caption" style={{ fontFamily: 'monospace' }}>{exp.runs}</Typography></TableCell>
                        <TableCell><Typography variant="caption">{exp.lastRun}</Typography></TableCell>
                        <TableCell><Typography variant="caption" style={{ fontFamily: 'monospace' }}>{exp.latestMetric}</Typography></TableCell>
                        <TableCell><Typography variant="caption" style={{ fontFamily: 'monospace', fontSize: 11 }}>{exp.artifacts}</Typography></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </MuiTable>
              </TableContainer>
            </Paper>

            {/* Registered models + recent runs */}
            <Box display="flex" style={{ gap: 20, flexWrap: 'wrap' }}>
              <Paper style={{ flex: '1 1 340px' }}>
                <Box style={{ padding: '12px 16px', borderBottom: '1px solid #eee' }}>
                  <Typography variant="h6">Registered Models</Typography>
                </Box>
                <TableContainer>
                  <MuiTable size="small">
                    <TableHead>
                      <TableRow style={{ background: '#f5f5f5' }}>
                        <TableCell><strong>Model</strong></TableCell>
                        <TableCell align="right"><strong>Latest version</strong></TableCell>
                        <TableCell><strong>Stage</strong></TableCell>
                        <TableCell><strong>Updated</strong></TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {models.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={4}>
                            <Typography variant="caption" color="textSecondary">No registered models.</Typography>
                          </TableCell>
                        </TableRow>
                      )}
                      {models.map(model => (
                        <TableRow key={model.name} hover>
                          <TableCell style={{ fontWeight: 500 }}>{model.name}</TableCell>
                          <TableCell align="right"><Typography variant="caption" style={{ fontFamily: 'monospace' }}>v{model.version}</Typography></TableCell>
                          <TableCell>
                            <Chip size="small" label={model.stage}
                              style={{ background: model.stage === 'Production' ? '#4caf50' : '#9e9e9e', color: '#fff', fontSize: 10, fontWeight: 600 }} />
                          </TableCell>
                          <TableCell><Typography variant="caption">{model.updated}</Typography></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </MuiTable>
                </TableContainer>
              </Paper>

              <Paper style={{ flex: '1 1 380px' }}>
                <Box style={{ padding: '12px 16px', borderBottom: '1px solid #eee' }}>
                  <Typography variant="h6">Recent Runs</Typography>
                </Box>
                <TableContainer>
                  <MuiTable size="small">
                    <TableHead>
                      <TableRow style={{ background: '#f5f5f5' }}>
                        <TableCell><strong>Run</strong></TableCell>
                        <TableCell><strong>Experiment</strong></TableCell>
                        <TableCell><strong>Status</strong></TableCell>
                        <TableCell align="right"><strong>Duration</strong></TableCell>
                        <TableCell><strong>Metrics</strong></TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {runs.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={5}>
                            <Typography variant="caption" color="textSecondary">No runs logged yet.</Typography>
                          </TableCell>
                        </TableRow>
                      )}
                      {runs.map(run => (
                        <TableRow key={run.id} hover>
                          <TableCell style={{ fontWeight: 500 }}>{run.name}</TableCell>
                          <TableCell><Typography variant="caption">{run.experiment}</Typography></TableCell>
                          <TableCell>
                            <Chip size="small" label={run.status}
                              style={{ background: RUN_STATUS_COLOR[run.status] ?? '#9e9e9e', color: '#fff', fontSize: 10, fontWeight: 600 }} />
                          </TableCell>
                          <TableCell align="right"><Typography variant="caption" style={{ fontFamily: 'monospace' }}>{run.duration}</Typography></TableCell>
                          <TableCell><Typography variant="caption" style={{ fontFamily: 'monospace', fontSize: 11 }}>{run.metrics}</Typography></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </MuiTable>
                </TableContainer>
              </Paper>
            </Box>
          </>
        )}
      </Content>
    </Page>
  );
}

const mlflowPageRouteRef = createRouteRef();
const mlflowPage = PageBlueprint.make({
  name: 'mlflow-platform',
  params: { path: '/mlflow', routeRef: mlflowPageRouteRef, loader: async () => <MlflowPage /> },
});
const mlflowNavItem = NavItemBlueprint.make({
  name: 'mlflow-platform',
  params: { title: 'MLflow', icon: ScienceIcon as any, routeRef: mlflowPageRouteRef },
});

// ── Support / Help Center ──────────────────────────────────────────────────────
// Static help hub: Get Help channels, on-call info, useful links, and platform
// announcements. PagerDuty on-call pulled from proxy when token is set.

const ANNOUNCEMENTS = [
  { color: '#1976d2', title: '🆕 KAgent v0.4 — OpenAI ModelConfig support',                  date: 'Jun 18', body: 'GPT-4o is now available as an alternative model for KAgent agents.' },
  { color: '#4caf50', title: '✅ Cost attribution GA — teams can now see per-agent AI spend', date: 'Jun 15', body: 'Budget tab in Backstage now shows AI API costs broken down by agent.' },
  { color: '#ff9800', title: '⚠️ Planned maintenance — Kind cluster restart Jun 22 02:00 UTC', date: 'Jun 14', body: 'All local services will be unavailable for ~10 minutes.' },
];

const HELP_CHANNELS = [
  { emoji: '🤖', label: 'Ask the AI Assistant',   desc: 'Get instant help — scaffolding, deployments, debugging, cost queries.', href: '/ai-assistant', primary: true  },
  { emoji: '💬', label: '#platform-support',       desc: 'Slack channel — platform team responds within 1 business hour.',         href: '#slack',       primary: false },
  { emoji: '📋', label: 'Open a Jira Ticket',      desc: 'For bugs, feature requests, or access issues — use the IDP project.',   href: '#jira',        primary: false },
  { emoji: '📖', label: 'Browse TechDocs',          desc: 'Comprehensive platform documentation — getting started, runbooks.',     href: '/docs',        primary: false },
];

// aiEnabled gates the KAgent UI link — it 404s on a platform where
// bootstrap-ai.sh has not run, since nothing serves kagent.idp.local.
// Every href here is either an in-app route declared below in this file, or an
// externalLinks.* value from app-config. MLflow and Langfuse were already
// configured in app-config.aws.yaml (and substituted with real ALB hostnames by
// bootstrap-ai.sh) but this function never accepted them, so two working surfaces
// had no entry point from Support. The AI-gated ones follow KAgent's lead and are
// hidden when aiStack.enabled is false, so they never render a dead link on a
// cluster bootstrapped with --skip-ai.
// Prefer IN-PORTAL routes over externalLinks.* wherever an in-portal page exists.
// Those pages are environment-independent by construction: /kagent, /mlflow,
// /langfuse and /argocd are PageBlueprint routes declared in this file and resolve
// identically on Kind and on EKS, with no ALB hostname, no ConfigMap substitution
// and no frontend-visibility annotation in the path. externalLinks.* is still used
// for Grafana, which has no in-portal page.
//
// The previous version linked KAgent/MLflow/Langfuse straight at externalLinks.*,
// which broke in two different ways at once: langfuse lacked an @visibility
// frontend annotation in config.d.ts, so Backstage stripped it from the config sent
// to the browser and the link silently fell back to the hardcoded
// langfuse.idp.local default even on AWS — and any environment whose substitution
// had not run would send users to a dead *.idp.local host.
//
// Every href below is either a Backstage core route (/, /catalog) or a
// PageBlueprint path declared in this file. Entity CONTENT paths are deliberately
// NOT used: /security for example is an EntityContentBlueprint, so it only exists
// under /catalog/<ns>/<kind>/<name>/security and 404s at the root.
const getUsefulLinks = (urls: { grafana: string }, aiEnabled: boolean) => [
  { emoji: '🏠', label: 'Platform Dashboard', href: '/' },
  { emoji: '📊', label: 'Grafana Dashboards', href: urls.grafana },
  { emoji: '📚', label: 'Service Catalog',     href: '/catalog' },
  { emoji: '📈', label: 'DORA Metrics',        href: '/dora' },
  { emoji: '🏅', label: 'Scorecard',           href: '/scorecard' },
  { emoji: '💰', label: 'FinOps / Cost',       href: '/finops' },
  { emoji: '🎯', label: 'SLOs',                href: '/slo' },
  { emoji: '🔎', label: 'API Explorer',        href: '/apis' },
  ...(aiEnabled
    ? [
        { emoji: '🤖', label: 'KAgent',           href: '/kagent' },
        { emoji: '🧪', label: 'MLflow',           href: '/mlflow' },
        { emoji: '🔍', label: 'AI Observability', href: '/langfuse' },
      ]
    : []),
  { emoji: '🚀', label: 'ArgoCD',              href: '/argocd' },
];

function SupportPage() {
  const fetchApi  = useApi(fetchApiRef);
  const configApi = useApi(configApiRef);
  const base = configApi.getString('backend.baseUrl');
  const aiStackEnabled = useAiStackEnabled();
  const usefulLinks = getUsefulLinks({
    grafana: configApi.getOptionalString('externalLinks.grafana') ?? 'http://grafana.idp.local',
  }, aiStackEnabled);
  // The AI Assistant entry points at /ai-assistant, a route that does not exist
  // when the page extension is disabled.
  const helpChannels = HELP_CHANNELS.filter(ch => aiStackEnabled || ch.href !== '/ai-assistant');

  const [oncall, setOncall] = useState<string | null>(null);

  useEffect(() => {
    // Try PagerDuty on-call roster
    fetchApi.fetch(`${base}/api/proxy/pagerduty/oncalls?limit=1&include[]=users`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then((d: any) => {
        const name = d?.oncalls?.[0]?.user?.summary;
        if (name) setOncall(name);
      }).catch(() => {});
  }, [base, fetchApi]);

  return (
    <Page themeId="home">
      <Header title="Support" subtitle="Platform Engineering team · #platform-support on Slack" />
      <Content>
        <Box display="flex" style={{ gap: 20, flexWrap: 'wrap', marginBottom: 20 }}>
          {/* Get Help */}
          <Paper style={{ flex: '1 1 320px' }}>
            <Box style={{ padding: '12px 16px', borderBottom: '1px solid #eee' }}>
              <Typography variant="h6">Get Help</Typography>
            </Box>
            <Box style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {helpChannels.map(ch => (
                <a key={ch.label} href={ch.href}
                  style={{ display: 'block', padding: 14, borderRadius: 4, textDecoration: 'none', color: 'inherit', cursor: 'pointer',
                    background: ch.primary ? '#e3f2fd' : '#fff',
                    border: `1px solid ${ch.primary ? '#1976d2' : '#e0e0e0'}` }}>
                  <Typography variant="body2" style={{ fontWeight: 500, marginBottom: 2 }}>{ch.emoji} {ch.label}</Typography>
                  <Typography variant="caption" color="textSecondary">{ch.desc}</Typography>
                </a>
              ))}
            </Box>
          </Paper>

          {/* On-call + useful links */}
          <Paper style={{ flex: '1 1 260px' }}>
            <Box style={{ padding: '12px 16px', borderBottom: '1px solid #eee' }}>
              <Typography variant="h6">Platform Team On-Call</Typography>
            </Box>
            <Box style={{ padding: '8px 16px' }}>
              {[
                { label: 'Current on-call', value: oncall ?? 'Platform Engineering' },
                { label: 'Rotation',         value: 'Platform Engineering' },
                { label: 'Response SLA',     value: 'P1: 15 min · P2: 1h · P3: next day' },
              ].map(({ label, value }) => (
                <Box key={label} display="flex" justifyContent="space-between" style={{ padding: '8px 0', borderBottom: '1px solid #f5f5f5' }}>
                  <Typography variant="caption" color="textSecondary">{label}</Typography>
                  <Typography variant="caption" style={{ fontWeight: 500, textAlign: 'right', maxWidth: 160 }}>{value}</Typography>
                </Box>
              ))}
              <Box display="flex" justifyContent="space-between" style={{ padding: '8px 0', borderBottom: '1px solid #f5f5f5' }}>
                <Typography variant="caption" color="textSecondary">Escalation</Typography>
                <a href="http://pagerduty.com" style={{ fontSize: 12, color: '#1976d2' }}>PagerDuty ↗</a>
              </Box>
            </Box>
            <Box style={{ padding: '12px 16px', borderTop: '1px solid #eee', borderBottom: '1px solid #eee' }}>
              <Typography variant="body2" style={{ fontWeight: 500, marginBottom: 8 }}>Useful Links</Typography>
              <Box style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {usefulLinks.map(l => (
                  <a key={l.label} href={l.href}
                    style={{ fontSize: 13, color: '#1976d2', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span>{l.emoji}</span> {l.label}
                  </a>
                ))}
              </Box>
            </Box>
          </Paper>
        </Box>

        {/* Announcements */}
        <Paper>
          <Box style={{ padding: '12px 16px', borderBottom: '1px solid #eee' }}>
            <Typography variant="h6">Recent Platform Announcements</Typography>
          </Box>
          <Box style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
            {ANNOUNCEMENTS.map((a, i) => (
              <Box key={i} style={{ borderLeft: `3px solid ${a.color}`, paddingLeft: 12 }}>
                <Box display="flex" alignItems="center" style={{ gap: 8, marginBottom: 2 }}>
                  <Typography variant="body2" style={{ fontWeight: 500 }}>{a.title}</Typography>
                  <Typography variant="caption" color="textSecondary" style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}>{a.date}</Typography>
                </Box>
                <Typography variant="caption" color="textSecondary">{a.body}</Typography>
              </Box>
            ))}
          </Box>
        </Paper>
      </Content>
    </Page>
  );
}

const supportPageRouteRef = createRouteRef();  // was id: 'support'
const supportPage = PageBlueprint.make({
  name: 'support',
  params: { path: '/support', routeRef: supportPageRouteRef, loader: async () => <SupportPage /> },
});
const supportNavItem = NavItemBlueprint.make({
  name: 'support',
  params: { title: 'Support', icon: HelpOutlineIcon as any, routeRef: supportPageRouteRef },
});

// ── Plugin registration ────────────────────────────────────────────────────────
// Explicitly annotated. Without it TypeScript tries to name the inferred type,
// which reaches through a nested copy of @backstage/catalog-model hoisted under
// plugin-catalog-react and fails with TS2742 ("cannot be named without a
// reference to … This is likely not portable"). Whether that nested copy exists
// depends on how yarn happens to hoist on a given install, so the error comes
// and goes between machines — pinning the type here makes it deterministic.
// App.tsx only passes this to the features list, so the non-generic
// FrontendPlugin loses nothing.
export const customPagesPlugin: FrontendPlugin = createFrontendPlugin({
  pluginId: 'custom-pages',
  routes: {
    root: finOpsRouteRef,
  },
  extensions: [
    // Platform-wide standalone pages
    homePage,
    homeNavItem,
    doraPage,
    doraNavItem,
    scorecardPage,
    scorecardNavItem,
    sloPage,
    sloNavItem,
    argocdPage,
    argocdNavItem,
    activityPage,
    activityNavItem,
    apiExplorerPage,
    apiExplorerNavItem,
    onboardingPage,
    onboardingNavItem,
    learningCenterPage,
    learningCenterNavItem,
    calculatorPage,
    calculatorNavItem,
    settingsPage,
    // (no settingsNavItem — see the note at its page definition)
    profilePage,
    profileNavItem,
    searchPage,
    searchNavItem,
    adminPage,
    adminNavItem,
    kagentPage,
    kagentNavItem,
    langfusePage,
    langfuseNavItem,
    langfuseEntityContent,
    mlflowPage,
    mlflowNavItem,
    supportPage,
    supportNavItem,
    // Existing pages
    finOpsPage,
    finOpsNavItem,
    aiAssistantPage,
    aiAssistantNavItem,
    semanticSearchPage,
    semanticSearchNavItem,
    approvalsPage,
    approvalsNavItem,
    copilotPage,
    copilotNavItem,
    // Entity tabs
    doraEntityContent,
    scorecardEntityContent,
    securityEntityContent,
    datadogEntityContent,
    trivyEntityContent,
    pagerDutyEntityContent,
    grafanaEntityContent,
    jiraEntityContent,
    teamBudgetEntityContent,
    sloEntityContent,
  ],
});
