import { useEffect, useState } from "react";
import {
  BrowserRouter,
  Link,
  NavLink,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import { studioApi, type HealthResponse, type ToolchainEntry, type ToolchainResponse } from "./api";

const views = [
  { path: "/design", label: "Design", icon: "⌁" },
  { path: "/simulate", label: "Simulate", icon: "⌁" },
  { path: "/pcb", label: "PCB", icon: "▧" },
  { path: "/components", label: "Components", icon: "◈" },
  { path: "/checks", label: "Checks", icon: "✓" },
];

const projectSections = [
  { label: "Requirements", icon: "≡" },
  { label: "Schematic", icon: "⌁" },
  { label: "Source", icon: "〈〉" },
  { label: "Components", icon: "◈" },
  { label: "Simulations", icon: "∿" },
  { label: "PCB", icon: "▧" },
  { label: "Revisions", icon: "◷" },
];

const toolDefinitions = [
  { key: "python", label: "Python" },
  { key: "node", label: "Node.js" },
  { key: "ngspice", label: "ngspice" },
  { key: "kicad_cli", label: "KiCad CLI" },
  { key: "docker", label: "Docker" },
  { key: "tscircuit_worker", label: "tscircuit worker" },
  { key: "tscircuit_sandbox", label: "Pinned sandbox" },
];

type ConnectionState = "loading" | "connected" | "offline";
type PanelTab = "Problems" | "Jobs" | "Waveforms" | "Console" | "Evidence" | "Comparison";

function useLocalToolchain() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthState, setHealthState] = useState<ConnectionState>("loading");
  const [toolchain, setToolchain] = useState<ToolchainResponse | null>(null);
  const [toolchainLoading, setToolchainLoading] = useState(true);
  const [toolchainError, setToolchainError] = useState(false);

  useEffect(() => {
    let current = true;
    studioApi.getHealth().then(value => {
      if (!current) return;
      setHealth(value);
      setHealthState(value.status === "ok" ? "connected" : "offline");
    }).catch(() => {
      if (current) setHealthState("offline");
    });
    studioApi.getToolchain().then(value => {
      if (!current) return;
      setToolchain(value);
      setToolchainError(false);
    }).catch(() => {
      if (current) setToolchainError(true);
    }).finally(() => {
      if (current) setToolchainLoading(false);
    });
    return () => { current = false; };
  }, []);

  return { health, healthState, toolchain, toolchainLoading, toolchainError };
}

function StudioApp() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<StudioShell />}>
          <Route index element={<Navigate to="/design" replace />} />
          <Route path="design" element={<WorkspaceView view="design" />} />
          <Route path="simulate" element={<WorkspaceView view="simulate" />} />
          <Route path="pcb" element={<WorkspaceView view="pcb" />} />
          <Route path="components" element={<WorkspaceView view="components" />} />
          <Route path="checks" element={<WorkspaceView view="checks" />} />
          <Route path="settings" element={<WorkspaceView view="settings" />} />
          <Route path="*" element={<Navigate to="/design" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

function StudioShell() {
  const { health, healthState, toolchain, toolchainLoading, toolchainError } = useLocalToolchain();
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false);
  const [panelTab, setPanelTab] = useState<PanelTab>("Problems");
  const location = useLocation();

  useEffect(() => {
    setMobileNavigationOpen(false);
    setMobileInspectorOpen(false);
  }, [location.pathname]);

  return (
    <div className="studio-shell">
      <header className="topbar">
        <button
          className="mobile-control menu-control"
          aria-label={mobileNavigationOpen ? "Close project navigation" : "Open project navigation"}
          aria-expanded={mobileNavigationOpen}
          onClick={() => setMobileNavigationOpen(open => !open)}
        >
          <span aria-hidden="true">☰</span>
        </button>
        <Link className="brand" to="/design" aria-label="EDA Studio home">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span className="brand-copy"><strong>EDA Studio</strong><small>LOCAL DESIGN WORKSPACE</small></span>
        </Link>
        <div className="project-context">
          <span className="context-label">PROJECT</span>
          <span className="project-name">No project open</span>
          <span className="context-divider" aria-hidden="true" />
          <span className="revision-label"><span className="revision-dot" /> Draft unavailable</span>
        </div>
        <div className="header-actions">
          <span className={`api-indicator api-${healthState}`} role="status" aria-live="polite">
            <span className="status-light" />
            {healthState === "loading" ? "Connecting" : healthState === "connected" ? "Local API connected" : "Local API offline"}
          </span>
          <div className="action-divider" aria-hidden="true" />
          <button className="action-button" disabled title="Open a project to compile it">Compile</button>
          <button className="action-button quiet-action" disabled title="Open a project to verify it">Verify</button>
          <button className="action-button export-action" disabled title="Open a project to export evidence">Export</button>
          <button
            className="mobile-control inspector-control"
            aria-label={mobileInspectorOpen ? "Close toolchain inspector" : "Open toolchain inspector"}
            aria-expanded={mobileInspectorOpen}
            onClick={() => setMobileInspectorOpen(open => !open)}
          >
            <span aria-hidden="true">◉</span>
          </button>
        </div>
      </header>

      {mobileNavigationOpen && <button className="drawer-scrim nav-scrim" tabIndex={-1} aria-label="Close project navigation" onClick={() => setMobileNavigationOpen(false)} />}
      <nav
        className={`project-navigation ${mobileNavigationOpen ? "drawer-open" : ""}`}
        aria-label="Project navigation"
      >
        <div className="navigation-heading"><span>PROJECT EXPLORER</span><button aria-label="Project options" disabled title="Open a project first">···</button></div>
        <div className="no-project-card">
          <span className="folder-icon" aria-hidden="true">▱</span>
          <div><strong>No project open</strong><small>Choose a workspace to begin</small></div>
        </div>
        <div className="section-label">DESIGN FILES</div>
        <ul className="project-tree">
          {projectSections.map(section => (
            <li key={section.label}>
              <button disabled title="Open a project to browse its files">
                <span className="tree-icon" aria-hidden="true">{section.icon}</span>{section.label}
              </button>
            </li>
          ))}
        </ul>
        <div className="navigation-footer">
          <NavLink to="/settings" className={({ isActive }) => `settings-link${isActive ? " active" : ""}`}>
            <span aria-hidden="true">⚙</span> Toolchain & settings
          </NavLink>
          <div className="local-badge"><span className="local-badge-dot" /> Runs on this device</div>
        </div>
      </nav>

      <main className="workspace-area">
        <nav className="workspace-tabs" aria-label="Workspace views">
          {views.map(view => (
            <NavLink key={view.path} to={view.path} className={({ isActive }) => `workspace-tab${isActive ? " active" : ""}`}>
              <span aria-hidden="true">{view.icon}</span>{view.label}
            </NavLink>
          ))}
        </nav>
        <Outlet />
        <section className="bottom-panel" aria-label="Workspace activity">
          <div className="panel-tabs" role="tablist" aria-label="Activity panel">
            {(["Problems", "Jobs", "Waveforms", "Console", "Evidence", "Comparison"] as const).map(tab => (
              <button
                key={tab}
                role="tab"
                aria-selected={panelTab === tab}
                className={panelTab === tab ? "selected" : ""}
                onClick={() => setPanelTab(tab)}
              >{tab}{tab === "Problems" && <span className="panel-count">0</span>}</button>
            ))}
          </div>
          <div className="panel-content" role="tabpanel" aria-label={`${panelTab} panel`}>
            <span className="panel-empty-icon" aria-hidden="true">{panelTab === "Problems" ? "✓" : "⌁"}</span>
            <span>{panelTab === "Problems" ? "No project loaded — nothing to report." : `${panelTab} will appear when a project is open.`}</span>
          </div>
        </section>
      </main>

      {mobileInspectorOpen && <button className="drawer-scrim inspector-scrim" tabIndex={-1} aria-label="Close toolchain inspector" onClick={() => setMobileInspectorOpen(false)} />}
      <aside className={`inspector ${mobileInspectorOpen ? "drawer-open" : ""}`} aria-label="Toolchain inspector">
        <div className="inspector-header">
          <div><span className="eyebrow">LOCAL ENVIRONMENT</span><h2>Toolchain status</h2></div>
          <button className="refresh-button" aria-label="Refresh toolchain status" onClick={() => window.location.reload()}>↻</button>
        </div>
        <p className="inspector-copy">Detected by the local Studio API. Missing tools remain unavailable until installed and discoverable.</p>
        {toolchainLoading ? (
          <div className="toolchain-message" role="status">Checking local tools…</div>
        ) : toolchainError || !toolchain ? (
          <div className="toolchain-message warning" role="status">
            <span className="message-icon" aria-hidden="true">!</span>
            <span>Toolchain status is unknown because the local API could not be reached.</span>
          </div>
        ) : (
          <ul className="tool-list" aria-label="Detected local tools">
            {toolDefinitions.map(tool => <ToolRow key={tool.key} label={tool.label} entry={toolchain.tools[tool.key]} />)}
          </ul>
        )}
        {toolchain && <p className="checked-at">Checked {formatTimestamp(toolchain.checked_at_utc)}</p>}
        <div className="selection-card">
          <div className="selection-card-header"><span className="selection-icon" aria-hidden="true">⌖</span><span>SELECTION</span></div>
          <strong>Nothing selected</strong>
          <p>Open a compiled design to inspect components, nets and linked source.</p>
        </div>
        <div className="inspector-note">
          <span className="note-mark" aria-hidden="true">i</span>
          <p>Tool availability describes this device. It does not imply that a project has passed electrical or manufacturing checks.</p>
        </div>
        <span className="api-build">API {health?.api_version ?? "v1"}{health ? ` · build ${health.build_version}` : ""}</span>
      </aside>
    </div>
  );
}

function ToolRow({ label, entry }: { label: string; entry?: ToolchainEntry }) {
  const statusText = entry?.status === "available" ? "Available" : entry?.status === "unavailable" ? "Unavailable" : entry?.status === "error" ? "Probe error" : "Unknown";
  const statusClass = entry?.status ?? "unknown";
  const detail = entry?.version ?? entry?.reason ?? "The API did not report this tool.";
  return (
    <li className="tool-row" aria-label={`${label}: ${statusText}`}>
      <span className={`tool-status-icon status-${statusClass}`} aria-hidden="true">{entry?.status === "available" ? "✓" : entry?.status === "unavailable" ? "–" : "!"}</span>
      <span className="tool-meta"><strong>{label}</strong><small title={detail}>{detail}</small></span>
      <span className={`tool-pill pill-${statusClass}`}>{statusText}</span>
    </li>
  );
}

type WorkspaceKind = "design" | "simulate" | "pcb" | "components" | "checks" | "settings";

function WorkspaceView({ view }: { view: WorkspaceKind }) {
  const copy: Record<WorkspaceKind, { title: string; eyebrow: string; description: string; emptyTitle: string; emptyDescription: string }> = {
    design: {
      title: "Design workspace", eyebrow: "DESIGN", description: "Your project's source, compiled circuit and review context will meet here.",
      emptyTitle: "Start with a project", emptyDescription: "Connect a local workspace to open a tscircuit project and inspect its source-linked design.",
    },
    simulate: {
      title: "Simulation workspace", eyebrow: "SIMULATE", description: "Run explicit analyses and review measurements against declared requirements.",
      emptyTitle: "No simulation evidence", emptyDescription: "Simulation stays not run until a project, analysis plan and supported simulator are available.",
    },
    pcb: {
      title: "PCB workspace", eyebrow: "PCB", description: "Review board constraints, exported layout and native design-rule evidence.",
      emptyTitle: "No board loaded", emptyDescription: "A board preview will appear after a project is compiled and a PCB artifact is available.",
    },
    components: {
      title: "Components", eyebrow: "LIBRARY", description: "Inspect parts, models, footprints and source metadata for the active revision.",
      emptyTitle: "No component inventory", emptyDescription: "Component details will be tied to a project's locked part and model records.",
    },
    checks: {
      title: "Checks & evidence", eyebrow: "VALIDATION", description: "Follow each check from its source revision to the artifact that supports it.",
      emptyTitle: "No checks have run", emptyDescription: "Checks will be marked not run until their corresponding tool produces evidence.",
    },
    settings: {
      title: "Toolchain & settings", eyebrow: "SETTINGS", description: "Review local tool discovery and configure a workspace for Studio.",
      emptyTitle: "Workspace setup is next", emptyDescription: "The API can report tool availability. Workspace creation and project import are the next implementation slice.",
    },
  };
  const text = copy[view];
  return (
    <section className="view-content" aria-labelledby="workspace-title">
      <div className="view-heading">
        <div><span className="eyebrow">{text.eyebrow} / WORKSPACE</span><h1 id="workspace-title">{text.title}</h1><p>{text.description}</p></div>
        <div className="revision-state"><span className="state-dot" />No revision frozen</div>
      </div>
      <div className={`empty-canvas canvas-${view}`}>
        <div className="canvas-grid" aria-hidden="true" />
        <div className="empty-state">
          <div className="empty-art" aria-hidden="true">
            <span className="art-orbit orbit-one" /><span className="art-orbit orbit-two" />
            <span className="art-node node-a" /><span className="art-node node-b" /><span className="art-node node-c" />
            <span className="art-line line-a" /><span className="art-line line-b" />
            <span className="art-core">{view === "settings" ? "⚙" : view === "checks" ? "✓" : "⌁"}</span>
          </div>
          <span className="empty-kicker">{text.eyebrow} PREVIEW</span>
          <h2>{text.emptyTitle}</h2>
          <p>{text.emptyDescription}</p>
          {view === "design" && <Link className="setup-link" to="/settings">Open workspace setup <span aria-hidden="true">→</span></Link>}
          {view === "settings" && <span className="coming-next">Workspace root configuration · planned next</span>}
        </div>
        <div className="canvas-scale" aria-hidden="true"><span>0</span><i /><span>10 mm</span></div>
      </div>
      <div className="canvas-footer"><span><span className="footer-dot" /> {view === "settings" ? "Local-only mode" : "Source of truth: project TSX and reviewed configuration"}</span><span>{view === "design" ? "Circuit view · awaiting project" : "No project data loaded"}</span></div>
    </section>
  );
}

function formatTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "time unavailable";
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" }).format(date);
}

export default StudioApp;
