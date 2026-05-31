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
      .catch(e => setError(`Grafana alerts unavailable (${e}). Set GRAFANA_TOKEN in local/backstage/.env`))
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

function CopilotMetricsPage() {
  const fetchApi  = useApi(fetchApiRef);
  const configApi = useApi(configApiRef);
  const base = configApi.getString('backend.baseUrl');

  const [days, setDays]       = useState<CopilotDay[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  useEffect(() => {
    fetchApi
      .fetch(`${base}/api/proxy/github-copilot/orgs/moatazeldebsy/copilot/metrics`)
      .then(r => r.ok ? r.json() : Promise.reject(`${r.status} ${r.statusText}`))
      .then(data => setDays(Array.isArray(data) ? data.slice(-28) : []))
      .catch(e => setError(`GitHub Copilot API unavailable: ${e}. Ensure GITHUB_TOKEN is set and your org has a Copilot licence.`))
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
        {error && (
          <Paper style={{ padding: 24, textAlign: 'center' }}>
            <Typography variant="h6" gutterBottom>Copilot data unavailable</Typography>
            <Typography variant="body2" color="textSecondary">{error}</Typography>
          </Paper>
        )}
        {!loading && !error && (
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
    securityEntityContent,
    pagerDutyEntityContent,
    grafanaEntityContent,
    jiraEntityContent,
    copilotPage,
    copilotNavItem,
  ],
});
