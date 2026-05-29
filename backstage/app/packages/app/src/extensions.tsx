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

// ── FinOps / Cost Overview page ───────────────────────────────────────────────
// Queries OpenCost via the Backstage proxy (/api/proxy/opencost).
// Falls back gracefully when OpenCost is unreachable.

interface AllocationRow {
  namespace: string;
  totalCost: string;
  cpuCost: string;
  ramCost: string;
}

function FinOpsPage() {
  const fetchApi = useApi(fetchApiRef);
  const configApi = useApi(configApiRef);
  const [rows, setRows] = useState<AllocationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const baseUrl = configApi.getString('backend.baseUrl');
    const url =
      `${baseUrl}/api/proxy/opencost/allocation/compute` +
      `?window=7d&aggregate=namespace&accumulate=true`;

    fetchApi
      .fetch(url)
      .then(r => {
        if (!r.ok) throw new Error(`OpenCost returned ${r.status}`);
        return r.json();
      })
      .then((data: any) => {
        const allocations: Record<string, any> = data?.data?.[0] ?? {};
        setRows(
          Object.entries(allocations).map(([namespace, info]) => ({
            namespace,
            totalCost: ((info as any).totalCost ?? 0).toFixed(4),
            cpuCost: ((info as any).cpuCost ?? 0).toFixed(4),
            ramCost: ((info as any).ramCost ?? 0).toFixed(4),
          })),
        );
        setLoading(false);
      })
      .catch((err: Error) => {
        setError(err.message);
        setLoading(false);
      });
  }, [fetchApi, configApi]);

  return (
    <Page themeId="tool">
      <Header
        title="FinOps — Cost Overview"
        subtitle="7-day spend by namespace · powered by OpenCost"
      />
      <Content>
        {loading && <Progress />}
        {!loading && error && (
          <p>
            Cost data unavailable: <strong>{error}</strong>. Ensure the OpenCost
            pod is running (<code>kubectl get po -n finops</code>) and the
            <code>/opencost</code> proxy is configured in{' '}
            <code>app-config.yaml</code>.
          </p>
        )}
        {!loading && !error && rows.length === 0 && (
          <p>No allocation data returned by OpenCost for the last 7 days.</p>
        )}
        {!loading && !error && rows.length > 0 && (
          <TableContainer component={Paper}>
            <MuiTable size="small">
              <TableHead>
                <TableRow>
                  <TableCell><strong>Namespace</strong></TableCell>
                  <TableCell><strong>Total Cost (USD)</strong></TableCell>
                  <TableCell><strong>CPU Cost (USD)</strong></TableCell>
                  <TableCell><strong>RAM Cost (USD)</strong></TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map(row => (
                  <TableRow key={row.namespace}>
                    <TableCell>{row.namespace}</TableCell>
                    <TableCell>{row.totalCost}</TableCell>
                    <TableCell>{row.cpuCost}</TableCell>
                    <TableCell>{row.ramCost}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </MuiTable>
          </TableContainer>
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
      // Include contextId to continue the same session (agent keeps full history)
      const message: any = {
        messageId: uuidv4(),
        role: 'user',
        parts: [{ kind: 'text', text }],
      };
      if (contextIdRef.current) message.contextId = contextIdRef.current;

      const a2aRes = await fetchApi.fetch(`${proxyBase}/a2a/kagent/idp-assistant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      // exponential backoff + jitter (200ms → 2s, total deadline ~20s) so
      // concurrent chat sessions don't fan out a constant 2 req/s per user.
      if (!sessionId) {
        setStatusText('Waiting for agent…');
        const sentAt = Date.now();
        const sessionDeadline = Date.now() + 20_000;
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
              if (s.agent_id === 'kagent__NS__idp_assistant') {
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
      setStatusText('Agent is thinking…');
      let agentReply: string | null = null;
      const replyDeadline = Date.now() + 300_000; // 5 min
      let rAttempt = 0;
      while (!agentReply && Date.now() < replyDeadline) {
        const base = Math.min(3000, 500 * Math.pow(2, rAttempt));
        const jitter = base * (0.8 + Math.random() * 0.4);
        await new Promise(r => setTimeout(r, jitter));
        rAttempt++;
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
      <Header title="AI Assistant" subtitle="Powered by KAgent · idp-assistant" />
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

          {/* Message list */}
          <Box flex={1} overflow="auto" mb={2} px={1}>
            {messages.length === 0 && !loading && (
              <Typography variant="body2" color="textSecondary" align="center" style={{ marginTop: 40 }}>
                Ask me about services, deployments, metrics, or scaffold a new service.
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
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  <Typography variant="body2">{msg.text}</Typography>
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
  | 'has-ai-observability';

interface CheckDef {
  id: CheckKey;
  label: string;
  group: 'Hygiene' | 'Shift-Left CI' | 'Test Coverage' | 'AI Governance';
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
];

type TierName = 'none' | 'bronze' | 'silver' | 'gold';

const TIER_THRESHOLDS: Record<Exclude<TierName, 'none'>, number> = {
  bronze: 5,   // 36% of 14 checks
  silver: 9,   // 64% of 14 checks
  gold:   12,  // 86% of 14 checks
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
  const isAiService = tags.some(t => t.toLowerCase() === 'ai');

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
    'has-model-card':        Boolean(annotations['backstage.io/model-card-url']),
    'has-eval-suite':        gates.has('llm-eval'),
    'has-ai-observability':  hasKubernetesId && isAiService,
  };

  const passed = Object.values(results).filter(Boolean).length;
  let tier: TierName = 'none';
  if (passed >= TIER_THRESHOLDS.gold)   tier = 'gold';
  else if (passed >= TIER_THRESHOLDS.silver) tier = 'silver';
  else if (passed >= TIER_THRESHOLDS.bronze) tier = 'bronze';
  return { results, passed, total: CHECKS.length, tier };
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

function NextTierHint({ tier, results }: { tier: TierName; results: Record<CheckKey, boolean> }) {
  const passed = Object.values(results).filter(Boolean).length;
  const target = tier === 'gold' ? null
    : tier === 'silver' ? TIER_THRESHOLDS.gold
    : tier === 'bronze' ? TIER_THRESHOLDS.silver
    : TIER_THRESHOLDS.bronze;
  if (target === null) {
    return (
      <Typography variant="body2" color="textSecondary">
        🎉 Gold tier — full shift-left adoption. Consider mutation testing next.
      </Typography>
    );
  }
  const missing = CHECKS.filter(c => !results[c.id]);
  return (
    <Typography variant="body2" color="textSecondary">
      {target - passed} more check{target - passed === 1 ? '' : 's'} to reach{' '}
      {target === TIER_THRESHOLDS.gold ? 'Gold' : target === TIER_THRESHOLDS.silver ? 'Silver' : 'Bronze'}.
      Cheapest unfilled: <strong>{missing[0]?.label ?? '—'}</strong>.
    </Typography>
  );
}

function ScorecardEntityContent() {
  const { entity } = useEntity();
  const score = useMemo(() => computeScorecard(entity), [entity]);
  const grouped = useMemo(() => {
    const groups: Record<string, CheckDef[]> = {};
    for (const c of CHECKS) (groups[c.group] ||= []).push(c);
    return groups;
  }, []);

  return (
    <Content>
      <Box mb={3}>
        <TierBadge tier={score.tier} passed={score.passed} total={score.total} />
        <Box mt={2}>
          <NextTierHint tier={score.tier} results={score.results} />
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
    scorecardEntityContent,
  ],
});
