import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getActorName, setActorName } from "./actor";
import { api, ApiError, setAuthToken } from "./api";
import type { Agent, AgentRun, Message, RunSpan, RunTrace, SystemInfo } from "./types";

const starterPrompts = [
  "Create a small TypeScript CLI that prints a weather summary from sample JSON.",
  "Inspect this workspace and explain what you would improve first.",
  "Build a responsive single-page todo app with tests.",
];

const emptyForm = {
  name: "",
  description: "",
  instructions:
    "Help me build and test software in this workspace. Keep changes small and explain the result.",
};

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function StatusPill({ status }: { status: Agent["status"] }) {
  return (
    <span className={"status status-" + status}>
      <span className="status-dot" />
      {status}
    </span>
  );
}

function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

const spanCategoryLabels: Record<RunSpan["category"], string> = {
  model_call: "Model",
  tool_call: "Tool",
  reasoning: "Reasoning",
  error: "Error",
  policy_decision: "Policy",
  warning: "Warning",
};

function formatTokenCount(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "k" : String(n);
}

function formatUsage(usage: RunTrace["usage"]): string {
  if (!usage) return "";
  const parts: string[] = [];
  if (usage.inputTokens != null) parts.push(formatTokenCount(usage.inputTokens) + " in");
  if (usage.outputTokens != null) parts.push(formatTokenCount(usage.outputTokens) + " out");
  return parts.join(" · ");
}

function spanDuration(span: RunSpan): string {
  if (!span.endedAt) return "…";
  const ms = new Date(span.endedAt).getTime() - new Date(span.startedAt).getTime();
  return ms < 1000 ? ms + "ms" : (ms / 1000).toFixed(1) + "s";
}

// RunSpan.parentId links each span to the turn (or step) it happened inside.
// Reassembling that into a tree — instead of rendering the flat push-order
// array — is what lets the panel show "this tool call happened inside this
// model turn" rather than a bare chronological log.
interface SpanNode {
  span: RunSpan;
  children: SpanNode[];
}

function buildSpanTree(spans: RunSpan[]): SpanNode[] {
  const nodesById = new Map<string, SpanNode>();
  for (const span of spans) nodesById.set(span.id, { span, children: [] });
  const roots: SpanNode[] = [];
  for (const span of spans) {
    const node = nodesById.get(span.id)!;
    const parent = span.parentId ? nodesById.get(span.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

// Keeps a branch when the "failures only" filter is on if it — or any
// descendant — failed, so a denied tool call still shows under the model
// turn it happened in instead of floating without context.
function pruneToFailures(nodes: SpanNode[]): SpanNode[] {
  const kept: SpanNode[] = [];
  for (const node of nodes) {
    const children = pruneToFailures(node.children);
    if (node.span.status === "failed" || children.length > 0) {
      kept.push({ span: node.span, children });
    }
  }
  return kept;
}

function TraceSpanRow({
  span,
  depth,
  highlighted,
}: {
  span: RunSpan;
  depth: number;
  highlighted: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (highlighted) {
      rowRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      setExpanded(true);
    }
  }, [highlighted]);

  return (
    <div
      ref={rowRef}
      className={
        "trace-span trace-span-" +
        span.status +
        (highlighted ? " trace-span-highlighted" : "")
      }
      style={{ marginLeft: depth * 18 }}
    >
      <button
        className="trace-span-row"
        onClick={() => setExpanded((value) => !value)}
        disabled={!span.detail}
      >
        <span className={"trace-span-category trace-category-" + span.category}>
          {spanCategoryLabels[span.category]}
        </span>
        <span className="trace-span-label">{span.label}</span>
        <span className="trace-span-duration">{spanDuration(span)}</span>
        <span className={"trace-span-status trace-status-" + span.status}>{span.status}</span>
      </button>
      {expanded && span.detail && <pre className="trace-span-detail">{span.detail}</pre>}
    </div>
  );
}

function TraceSpanTree({
  nodes,
  depth,
  highlightId,
}: {
  nodes: SpanNode[];
  depth: number;
  highlightId: string | null;
}) {
  return (
    <>
      {nodes.map((node) => (
        <div key={node.span.id} className="trace-span-branch">
          <TraceSpanRow
            span={node.span}
            depth={depth}
            highlighted={node.span.id === highlightId}
          />
          {node.children.length > 0 && (
            <TraceSpanTree nodes={node.children} depth={depth + 1} highlightId={highlightId} />
          )}
        </div>
      ))}
    </>
  );
}

function TracePanel({
  trace,
  loading,
  error,
  onClose,
}: {
  trace: RunTrace | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}) {
  const [failuresOnly, setFailuresOnly] = useState(false);
  const [highlightId, setHighlightId] = useState<string | null>(null);

  const tree = useMemo(() => (trace ? buildSpanTree(trace.spans) : []), [trace]);
  const visibleTree = failuresOnly ? pruneToFailures(tree) : tree;
  const firstFailure = trace?.spans.find((span) => span.status === "failed") ?? null;
  const usageLabel = trace ? formatUsage(trace.usage) : "";

  const jumpToFailure = () => {
    if (!firstFailure) return;
    const id = firstFailure.id;
    setHighlightId(id);
    window.setTimeout(() => {
      setHighlightId((current) => (current === id ? null : current));
    }, 2500);
  };

  return (
    <section className="trace-panel">
      <div className="trace-panel-header">
        <div className="trace-panel-title-row">
          <div className="trace-panel-title">
            <span className="eyebrow">Middleware evidence</span>
            <div className="trace-title-line">
              <h3>Run trace</h3>
              {trace && (
                <span className={"trace-status-chip trace-status-chip-" + trace.status}>
                  <span className="trace-status-dot" />
                  {trace.status}
                </span>
              )}
            </div>
          </div>
          <button className="trace-panel-close" onClick={onClose} aria-label="Close trace">
            ×
          </button>
        </div>
        {trace && (
          <div className="trace-panel-toolbar">
            <div className="trace-meta-tags">
              <span className="trace-meta-tag">
                <span className="trace-meta-icon">by</span>
                {trace.initiatedBy.name}
              </span>
              <span className="trace-meta-tag" title={trace.sessionId ?? undefined}>
                <span className="trace-meta-icon">#</span>
                {trace.sessionId ? trace.sessionId.slice(0, 8) : "new"}
              </span>
              {usageLabel && (
                <span className="trace-meta-tag" title="Token usage for this Run">
                  <span className="trace-meta-icon">tok</span>
                  {usageLabel}
                </span>
              )}
            </div>
            <div className="trace-panel-actions">
              <button
                className="trace-jump-button"
                onClick={jumpToFailure}
                disabled={!firstFailure}
                title={firstFailure ? "Scroll to the first failed step" : "No failed step in this Run"}
              >
                Jump to failure
              </button>
              <label className="trace-toggle-label">
                <input
                  type="checkbox"
                  className="trace-toggle-input"
                  checked={failuresOnly}
                  onChange={(event) => setFailuresOnly(event.target.checked)}
                />
                <span className="trace-toggle-track">
                  <span className="trace-toggle-thumb" />
                </span>
                <span>Failures only</span>
              </label>
            </div>
          </div>
        )}
      </div>
      {loading && (
        <div className="trace-panel-loading">
          <Spinner /> Loading trace…
        </div>
      )}
      {error && <div className="error-banner" role="alert">{error}</div>}
      {trace && !loading && (
        <div className="trace-span-list">
          {visibleTree.length === 0 ? (
            <div className="trace-empty">
              No spans recorded for this Run{trace.status === "failed" ? " — it failed before the Runtime reported any events." : "."}
            </div>
          ) : (
            <TraceSpanTree nodes={visibleTree} depth={0} highlightId={highlightId} />
          )}
        </div>
      )}
    </section>
  );
}

function runDuration(run: AgentRun): string {
  if (!run.startedAt || !run.completedAt) return "…";
  const ms = new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime();
  return ms < 1000 ? ms + "ms" : (ms / 1000).toFixed(1) + "s";
}

function RunsPanel({
  runs,
  loading,
  error,
  activeTraceRunId,
  onViewTrace,
  onClose,
}: {
  runs: AgentRun[];
  loading: boolean;
  error: string | null;
  activeTraceRunId: string | null;
  onViewTrace: (runId: string) => void;
  onClose: () => void;
}) {
  return (
    <section className="runs-panel">
      <div className="runs-panel-header">
        <div>
          <span className="eyebrow">Run history</span>
          <h3>Runs</h3>
        </div>
        <button className="trace-panel-close" onClick={onClose} aria-label="Close run history">
          ×
        </button>
      </div>
      {loading && (
        <div className="trace-panel-loading">
          <Spinner /> Loading runs…
        </div>
      )}
      {error && <div className="error-banner" role="alert">{error}</div>}
      {!loading && !error && (
        <ul className="runs-list">
          {runs.length === 0 ? (
            <li className="trace-empty">No runs yet.</li>
          ) : (
            runs.map((run) => (
              <li key={run.id}>
                <button
                  className={
                    "runs-row" + (run.id === activeTraceRunId ? " runs-row-active" : "")
                  }
                  onClick={() => onViewTrace(run.id)}
                >
                  <span className={"trace-status-chip trace-status-chip-" + run.status}>
                    <span className="trace-status-dot" />
                    {run.status}
                  </span>
                  <span className="runs-row-prompt">{run.prompt}</span>
                  <span className="runs-row-time">{formatTime(run.createdAt)}</span>
                  <span className="runs-row-duration">{runDuration(run)}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </section>
  );
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [prompt, setPrompt] = useState("");
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [authInput, setAuthInput] = useState("");
  const [traceRunId, setTraceRunId] = useState<string | null>(null);
  const [trace, setTrace] = useState<RunTrace | null>(null);
  const [traceLoading, setTraceLoading] = useState(false);
  const [traceError, setTraceError] = useState<string | null>(null);
  const [actorNameInput, setActorNameInput] = useState(() => getActorName());
  // UI-only state — no effect on data flow
  const [theme, setTheme] = useState<"light" | "dark">(
    () => (localStorage.getItem("theme") as "light" | "dark") ?? "light",
  );
  const [pendingDelete, setPendingDelete] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [showRuns, setShowRuns] = useState(false);
  const [runsList, setRunsList] = useState<AgentRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState<string | null>(null);

  const messageEnd = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const traceRunIdRef = useRef<string | null>(null);
  const showRunsRef = useRef(false);
  const mountedRef = useRef(true);
  const pollingRunIds = useRef(new Set<string>());
  const toastTimerRef = useRef<number | null>(null);
  selectedIdRef.current = selectedId;
  traceRunIdRef.current = traceRunId;
  showRunsRef.current = showRuns;

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );

  const showToast = useCallback((msg: string) => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    setToast(msg);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3000);
  }, []);

  const refreshAgents = useCallback(async () => {
    const { agents: next } = await api.listAgents();
    setAgents(next);
    setSelectedId((current) =>
      current && next.some((agent) => agent.id === current)
        ? current
        : (next[0]?.id ?? null),
    );
  }, []);

  const refreshMessages = useCallback(async (agentId: string) => {
    const result = await api.messages(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setMessages(result.messages);
    }
  }, []);

  const refreshRuns = useCallback(async (agentId: string) => {
    const result = await api.runs(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setRunsList(result.runs);
    }
  }, []);

  const bootstrap = useCallback(async () => {
    await Promise.all([refreshAgents(), api.system().then(setSystem)]);
  }, [refreshAgents]);

  // Apply theme to document root whenever it changes
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  useEffect(() => {
    mountedRef.current = true;
    void api
      .auth()
      .then(async ({ required }) => {
        if (!mountedRef.current) return;
        setAuthRequired(required);
        if (!required) await bootstrap();
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      mountedRef.current = false;
    };
  }, [bootstrap]);

  useEffect(() => {
    setActiveRun(null);
    setShowSettings(false);
    setTraceRunId(null);
    setTrace(null);
    setTraceError(null);
    setPendingDelete(false);
    setShowRuns(false);
    setRunsList([]);
    setRunsError(null);
    if (!selectedId) {
      setMessages([]);
      return;
    }
    void Promise.all([refreshMessages(selectedId), api.runs(selectedId)])
      .then(([, result]) => {
        if (selectedIdRef.current !== selectedId) return;
        const latest = result.runs[0] ?? null;
        setActiveRun(latest);
        if (latest && ["queued", "running"].includes(latest.status)) {
          void pollRun(latest.id, selectedId).catch((reason) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          );
        }
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [refreshMessages, selectedId]);

  useEffect(() => {
    if (selected) {
      setForm({
        name: selected.name,
        description: selected.description,
        instructions: selected.instructions,
      });
    }
  }, [selected]);

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeRun]);

  const createAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { agent } = await api.createAgent(form);
      await refreshAgents();
      setSelectedId(agent.id);
      setShowCreate(false);
      setForm(emptyForm);
      showToast("Agent created");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateAgent(selected.id, form);
      await refreshAgents();
      setShowSettings(false);
      showToast("Settings saved");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleAgent = async () => {
    if (!selected) return;
    const wasStopped = selected.status === "stopped";
    setBusy(true);
    setError(null);
    try {
      if (wasStopped) {
        await api.startAgent(selected.id);
      } else {
        await api.stopAgent(selected.id);
      }
      await refreshAgents();
      showToast(wasStopped ? "Agent started" : "Agent stopped");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const deleteAgent = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteAgent(selected.id);
      await refreshAgents();
      showToast("Agent deleted");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
      setPendingDelete(false);
    }
  };

  const pollRun = async (runId: string, agentId: string) => {
    if (pollingRunIds.current.has(runId)) return;
    pollingRunIds.current.add(runId);
    try {
      while (mountedRef.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        if (!mountedRef.current) return;
        const result = await api.run(runId);
        if (selectedIdRef.current === agentId) setActiveRun(result.run);
        if (!["queued", "running"].includes(result.run.status)) {
          await Promise.all([
            refreshMessages(agentId),
            refreshAgents(),
            showRunsRef.current && selectedIdRef.current === agentId
              ? refreshRuns(agentId)
              : Promise.resolve(),
          ]);
          return;
        }
      }
    } finally {
      pollingRunIds.current.delete(runId);
    }
  };

  const toggleRuns = async () => {
    if (!selected) return;
    if (showRuns) {
      setShowRuns(false);
      return;
    }
    setShowRuns(true);
    setRunsError(null);
    setRunsLoading(true);
    const agentId = selected.id;
    try {
      const result = await api.runs(agentId);
      if (selectedIdRef.current === agentId) setRunsList(result.runs);
    } catch (reason) {
      if (selectedIdRef.current === agentId) {
        setRunsError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (selectedIdRef.current === agentId) setRunsLoading(false);
    }
  };

  const viewTrace = async (runId: string) => {
    if (traceRunId === runId) {
      setTraceRunId(null);
      setTrace(null);
      setTraceError(null);
      return;
    }
    setTraceRunId(runId);
    setTrace(null);
    setTraceError(null);
    setTraceLoading(true);
    try {
      const result = await api.trace(runId);
      if (traceRunIdRef.current === runId) setTrace(result);
    } catch (reason) {
      if (traceRunIdRef.current === runId) {
        setTraceError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (traceRunIdRef.current === runId) setTraceLoading(false);
    }
  };

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !prompt.trim()) return;
    const content = prompt.trim();
    setPrompt("");
    setError(null);
    try {
      const result = await api.sendMessage(selected.id, content);
      if (selectedIdRef.current === selected.id) {
        setMessages((current) => [...current, result.message]);
        setActiveRun(result.run);
      }
      setAgents((current) =>
        current.map((agent) =>
          agent.id === selected.id ? { ...agent, status: "busy" } : agent,
        ),
      );
      await pollRun(result.run.id, selected.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setActiveRun(null);
      await refreshAgents();
    }
  };

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setAuthToken(authInput);
    try {
      await bootstrap();
      setAuthRequired(false);
      setAuthInput("");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setError("The access token is not valid.");
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setBusy(false);
    }
  };

  if (authRequired === null) {
    return (
      <main className="auth-screen">
        <section className="auth-card" aria-live="polite">
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Connecting to the control plane</h1>
          {error ? <div className="error-banner" role="alert">{error}</div> : <Spinner />}
        </section>
      </main>
    );
  }

  if (authRequired) {
    return (
      <main className="auth-screen">
        <form className="auth-card" onSubmit={unlock}>
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Enter the access token</h1>
          <p>This shared demo token is configured by the platform operator.</p>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <label>
            Access token
            <input
              autoFocus
              type="password"
              value={authInput}
              onChange={(event) => setAuthInput(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button className="button button-primary" disabled={busy || !authInput.trim()}>
            {busy ? <Spinner /> : "Open Launchpad"}
          </button>
        </form>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">A</div>
          <div>
            <strong>Agent Launchpad</strong>
            <span>
              {system?.runtimeProvider === "container"
                ? "Local container · Codex CLI"
                : "ECS / Docker · Codex CLI"}
            </span>
          </div>
        </div>

        <button
          className="button button-primary create-button"
          onClick={() => {
            setForm(emptyForm);
            setShowCreate(true);
          }}
        >
          <span>+</span> Create Agent
        </button>

        <div className="sidebar-label">
          <span>Your Agents</span>
          <span>{agents.length}</span>
        </div>
        <nav className="agent-list">
          {agents.map((agent) => (
            <button
              className={"agent-card " + (agent.id === selectedId ? "selected" : "")}
              key={agent.id}
              onClick={() => setSelectedId(agent.id)}
            >
              <div className="agent-avatar">{agent.name.slice(0, 1).toUpperCase()}</div>
              <div className="agent-card-copy">
                <strong>{agent.name}</strong>
                <span>{agent.description || "Coding Agent"}</span>
              </div>
              <span className={"mini-dot mini-" + agent.status} />
            </button>
          ))}
          {agents.length === 0 && (
            <div className="empty-sidebar">
              <span>◇</span>
              Create your first coding Agent.
            </div>
          )}
        </nav>

        <button
          className="theme-toggle"
          onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
          title="Toggle theme"
        >
          <span className="theme-toggle-icon">{theme === "dark" ? "☀" : "◑"}</span>
          <span>{theme === "dark" ? "Light mode" : "Dark mode"}</span>
        </button>

        <div className="runtime-card">
          <span className="eyebrow">Runtime</span>
          <strong>{system?.runtime ?? "Checking…"}</strong>
          <span>
            {system?.arkModel ?? "Ark model not configured"}
            {system?.containerEngine ? " · " + system.containerEngine : ""}
          </span>
        </div>
      </aside>

      <main className="main">
        {!system?.arkConfigured || !system?.codexAvailable ? (
          <div className="config-banner">
            <span>!</span>
            <div>
              <strong>Runtime configuration needed</strong>
              <p>
                {!system?.arkConfigured
                  ? "Set ARK_API_KEY and ARK_MODEL in .env before using the Playground."
                  : system.runtimeProvider === "container"
                    ? "The local container engine or Agent Runtime image is unavailable. Rerun npm run poc."
                    : "Codex CLI was not found. Use the Docker image or install @openai/codex."}
              </p>
            </div>
          </div>
        ) : null}

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}

        {selected ? (
          <>
            <header className="agent-header">
              <div>
                <div className="header-title-row">
                  <h1>{selected.name}</h1>
                  <StatusPill status={selected.status} />
                </div>
                <p>{selected.description || "A Codex coding Agent in an isolated workspace."}</p>
              </div>
              <div className="header-actions">
                <button
                  className={"button button-ghost" + (showRuns ? " button-active" : "")}
                  onClick={toggleRuns}
                  disabled={busy}
                >
                  Runs
                </button>
                <button
                  className="button button-ghost"
                  onClick={() => setShowSettings((value) => !value)}
                  disabled={busy || selected.status === "busy"}
                >
                  Settings
                </button>
                <button
                  className="button button-ghost"
                  onClick={toggleAgent}
                  disabled={busy}
                >
                  {selected.status === "stopped" ? "Start" : "Stop"}
                </button>
                {pendingDelete ? (
                  <div className="confirm-inline">
                    <span>Delete {selected.name}?</span>
                    <button
                      className="button button-danger"
                      onClick={deleteAgent}
                      disabled={busy}
                    >
                      {busy ? <Spinner /> : "Confirm"}
                    </button>
                    <button
                      className="button button-ghost"
                      onClick={() => setPendingDelete(false)}
                      disabled={busy}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    className="button button-danger"
                    onClick={() => setPendingDelete(true)}
                    disabled={busy || selected.status === "busy"}
                  >
                    Delete
                  </button>
                )}
              </div>
            </header>

            {showRuns && (
              <RunsPanel
                runs={runsList}
                loading={runsLoading}
                error={runsError}
                activeTraceRunId={traceRunId}
                onViewTrace={viewTrace}
                onClose={() => setShowRuns(false)}
              />
            )}

            {showSettings && (
              <form className="settings-panel" onSubmit={saveAgent}>
                <div className="settings-title">
                  <div>
                    <span className="eyebrow">Agent configuration</span>
                    <h2>Instructions and identity</h2>
                  </div>
                  <button type="button" onClick={() => setShowSettings(false)}>×</button>
                </div>
                <div className="form-grid">
                  <label>
                    Name
                    <input
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                      required
                      maxLength={80}
                    />
                  </label>
                  <label>
                    Description
                    <input
                      value={form.description}
                      onChange={(event) =>
                        setForm({ ...form, description: event.target.value })
                      }
                      maxLength={500}
                    />
                  </label>
                </div>
                <label>
                  System instructions
                  <textarea
                    value={form.instructions}
                    onChange={(event) =>
                      setForm({ ...form, instructions: event.target.value })
                    }
                    rows={5}
                    maxLength={10_000}
                  />
                </label>
                <div className="panel-footer">
                  <code>{selected.workspacePath}</code>
                  <button className="button button-primary" disabled={busy}>
                    {busy ? <Spinner /> : "Save changes"}
                  </button>
                </div>
              </form>
            )}

            <section className="playground">
              <div className="playground-topbar">
                <div>
                  <span className="eyebrow">Playground</span>
                  <h2>Build something with your Agent</h2>
                </div>
                <div className="playground-topbar-right">
                  <label className="actor-field" title="Self-reported identity attached to Runs you start">
                    Acting as
                    <input
                      value={actorNameInput}
                      onChange={(event) => {
                        setActorNameInput(event.target.value);
                        setActorName(event.target.value);
                      }}
                      placeholder="Unnamed operator"
                      maxLength={80}
                    />
                  </label>
                  <div className="session-info">
                    <span className="pulse" />
                    {selected.codexThreadId ? "Session connected" : "New session"}
                  </div>
                </div>
              </div>

              <div className="messages">
                {messages.length === 0 && !activeRun ? (
                  <div className="welcome">
                    <div className="welcome-orbit">
                      <div>⌁</div>
                    </div>
                    <h3>What should {selected.name} build?</h3>
                    <p>
                      The Agent can inspect files, write code, run commands, and continue the
                      same Codex session across messages.
                    </p>
                    <div className="prompt-grid">
                      {starterPrompts.map((item) => (
                        <button key={item} onClick={() => setPrompt(item)}>
                          <span>↗</span>
                          {item}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  messages.map((message) => (
                    <article className={"message message-" + message.role} key={message.id}>
                      <div className="message-meta">
                        <strong>{message.role === "user" ? "You" : selected.name}</strong>
                        <span>{formatTime(message.createdAt)}</span>
                        {message.role === "assistant" && (
                          <button
                            className="trace-trigger"
                            onClick={() => viewTrace(message.runId)}
                          >
                            {traceRunId === message.runId ? "Hide trace" : "View trace"}
                          </button>
                        )}
                      </div>
                      <div className="message-body">{message.content}</div>
                    </article>
                  ))
                )}
                {activeRun && ["queued", "running"].includes(activeRun.status) && (
                  <article className="message message-assistant thinking">
                    <div className="message-meta">
                      <strong>{selected.name}</strong>
                      <span>working in the Agent workspace</span>
                    </div>
                    <div className="thinking-row">
                      <Spinner />
                      Codex is reading, editing, or running commands…
                    </div>
                  </article>
                )}
                {activeRun?.status === "failed" && (
                  <article className="run-error">
                    <strong>Run failed</strong>
                    <span>{activeRun.error}</span>
                    <button className="trace-trigger" onClick={() => viewTrace(activeRun.id)}>
                      {traceRunId === activeRun.id ? "Hide trace" : "View trace"}
                    </button>
                  </article>
                )}
                <div ref={messageEnd} />
              </div>

              {traceRunId && (
                <TracePanel
                  trace={trace}
                  loading={traceLoading}
                  error={traceError}
                  onClose={() => {
                    setTraceRunId(null);
                    setTrace(null);
                    setTraceError(null);
                  }}
                />
              )}

              <form className="composer" onSubmit={sendMessage}>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder={
                    selected.status === "stopped"
                      ? "Start this Agent to continue…"
                      : "Describe what you want the Agent to do…"
                  }
                  disabled={
                    selected.status === "stopped" ||
                    selected.status === "busy" ||
                    activeRun != null && ["queued", "running"].includes(activeRun.status)
                  }
                  rows={3}
                />
                <div className="composer-footer">
                  <span>
                    Enter to send · Shift + Enter for newline · {system?.codexSandboxMode ?? "checking sandbox"}
                  </span>
                  <button
                    className="send-button"
                    disabled={
                      !prompt.trim() ||
                      selected.status === "stopped" ||
                      selected.status === "busy" ||
                      (activeRun != null && ["queued", "running"].includes(activeRun.status))
                    }
                    aria-label="Send message"
                  >
                    ↑
                  </button>
                </div>
              </form>
            </section>
          </>
        ) : (
          <div className="no-agent">
            <div className="no-agent-art">A</div>
            <span className="eyebrow">Agent Launchpad</span>
            <h1>Your runtime is ready for an Agent.</h1>
            <p>Create a workspace, give Codex a job, and continue the conversation here.</p>
            <button
              className="button button-primary"
              onClick={() => {
                setForm(emptyForm);
                setShowCreate(true);
              }}
            >
              Create your first Agent
            </button>
          </div>
        )}
      </main>

      {showCreate && (
        <div className="modal-backdrop" onMouseDown={() => setShowCreate(false)}>
          <form
            className="modal"
            onSubmit={createAgent}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">New workspace</span>
                <h2>Create an Agent</h2>
                <p>Each Agent gets a persistent folder and a resumable Codex session.</p>
              </div>
              <button type="button" onClick={() => setShowCreate(false)}>×</button>
            </div>
            <label>
              Name
              <input
                autoFocus
                placeholder="Frontend Builder"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
                maxLength={80}
              />
            </label>
            <label>
              Description
              <input
                placeholder="Builds polished React prototypes"
                value={form.description}
                onChange={(event) =>
                  setForm({ ...form, description: event.target.value })
                }
                maxLength={500}
              />
            </label>
            <label>
              Instructions
              <textarea
                value={form.instructions}
                onChange={(event) =>
                  setForm({ ...form, instructions: event.target.value })
                }
                rows={6}
                maxLength={10_000}
              />
            </label>
            <div className="modal-footer">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </button>
              <button className="button button-primary" disabled={busy}>
                {busy ? <Spinner /> : "Create Agent"}
              </button>
            </div>
          </form>
        </div>
      )}

      {toast && (
        <div className="toast" role="status">
          <span className="toast-icon">✓</span>
          {toast}
        </div>
      )}
    </div>
  );
}
