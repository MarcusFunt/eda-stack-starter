import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  BrowserRouter,
  Link,
  NavLink,
  Navigate,
  Outlet,
  Route,
  Routes,
  useOutletContext,
  useLocation,
} from "react-router-dom";
import {
  studioApi,
  StudioApiError,
  type CompileResponse,
  type HealthResponse,
  type ProjectDetailResponse,
  type ProjectListResponse,
  type ToolchainEntry,
  type ToolchainResponse,
} from "./api";

const views = [
  { path: "/design", label: "Design", icon: "⌁" },
  { path: "/simulate", label: "Simulate", icon: "⌁" },
  { path: "/pcb", label: "PCB", icon: "▧" },
  { path: "/components", label: "Components", icon: "◈" },
  { path: "/checks", label: "Checks", icon: "✓" },
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
type CompileState = "idle" | "running" | "compiled" | "failed";

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
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthState, setHealthState] = useState<ConnectionState>("loading");
  const [healthReload, setHealthReload] = useState(0);
  const [toolchain, setToolchain] = useState<ToolchainResponse | null>(null);
  const [toolchainLoading, setToolchainLoading] = useState(true);
  const [toolchainRefreshing, setToolchainRefreshing] = useState(false);
  const [toolchainError, setToolchainError] = useState<string | null>(null);
  const [toolchainReload, setToolchainReload] = useState(0);
  const [projects, setProjects] = useState<ProjectListResponse | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [projectsReload, setProjectsReload] = useState(0);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [project, setProject] = useState<ProjectDetailResponse | null>(null);
  const [projectLoading, setProjectLoading] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [compileState, setCompileState] = useState<CompileState>("idle");
  const [compileError, setCompileError] = useState<string | null>(null);
  const [build, setBuild] = useState<CompileResponse | null>(null);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false);
  const [panelTab, setPanelTab] = useState<PanelTab>("Problems");
  const navigationTrigger = useRef<HTMLButtonElement>(null);
  const inspectorTrigger = useRef<HTMLButtonElement>(null);
  const selectedProjectRef = useRef<string | null>(selectedProjectId);
  const toolchainRef = useRef<ToolchainResponse | null>(toolchain);
  const location = useLocation();

  selectedProjectRef.current = selectedProjectId;
  toolchainRef.current = toolchain;

  useEffect(() => {
    let current = true;
    setHealthState("loading");
    studioApi.getHealth().then((value) => {
      if (!current) return;
      setHealth(value);
      setHealthState("connected");
    }).catch(() => {
      if (current) setHealthState("offline");
    });
    return () => { current = false; };
  }, [healthReload]);

  useEffect(() => {
    let current = true;
    if (toolchainRef.current) setToolchainRefreshing(true);
    else setToolchainLoading(true);
    studioApi.getToolchain().then((value) => {
      if (!current) return;
      setToolchain(value);
      setToolchainError(null);
    }).catch((error: unknown) => {
      if (!current) return;
      setToolchainError(error instanceof Error ? error.message : "Toolchain status could not be refreshed.");
    }).finally(() => {
      if (!current) return;
      setToolchainLoading(false);
      setToolchainRefreshing(false);
    });
    return () => { current = false; };
  }, [toolchainReload]);

  useEffect(() => {
    let current = true;
    studioApi.getProjects().then((value) => {
      if (!current) return;
      setProjects(value);
      setProjectsError(null);
    }).catch((error: unknown) => {
      if (current) setProjectsError(error instanceof Error ? error.message : "Project discovery failed.");
    });
    return () => { current = false; };
  }, [projectsReload]);

  useEffect(() => {
    setMobileNavigationOpen(false);
    setMobileInspectorOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!mobileNavigationOpen && !mobileInspectorOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (mobileInspectorOpen) {
        setMobileInspectorOpen(false);
        inspectorTrigger.current?.focus();
      } else {
        setMobileNavigationOpen(false);
        navigationTrigger.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobileNavigationOpen, mobileInspectorOpen]);

  useEffect(() => {
    if (!selectedProjectId) {
      setProject(null);
      setProjectLoading(false);
      return;
    }
    let current = true;
    setProject(null);
    setProjectLoading(true);
    setProjectError(null);
    setBuild(null);
    setCompileError(null);
    setCompileState("idle");
    studioApi.getProject(selectedProjectId).then((value) => {
      if (current) setProject(value);
    }).catch((error: unknown) => {
      if (current) setProjectError(error instanceof Error ? error.message : "Project details could not be loaded.");
    }).finally(() => {
      if (current) setProjectLoading(false);
    });
    return () => { current = false; };
  }, [selectedProjectId]);

  const selectedSummary = projects?.projects.find((item) => item.project_id === selectedProjectId) ?? null;
  const projectName = project?.name ?? selectedSummary?.name ?? "No project open";

  async function compileSelectedProject() {
    if (!project || compileState === "running" || healthState !== "connected") return;
    const projectId = project.project_id;
    setCompileState("running");
    setCompileError(null);
    setBuild(null);
    try {
      const token = sessionToken ?? (await studioApi.getSession()).session_token;
      if (!sessionToken) setSessionToken(token);
      const result = await studioApi.compileProject(projectId, token);
      if (selectedProjectRef.current === projectId) {
        setBuild(result);
        setCompileState("compiled");
      }
    } catch (error) {
      if (selectedProjectRef.current === projectId) {
        const message = error instanceof Error ? error.message : "Compilation failed.";
        const details = error instanceof StudioApiError && error.details.length ? ` (${error.details.join(", ")})` : "";
        setCompileError(`${message}${details}`);
        setCompileState("failed");
      }
    }
  }

  function selectProject(projectId: string) {
    setSelectedProjectId(projectId);
    setMobileNavigationOpen(false);
  }

  return (
    <div className="studio-shell">
      <header className="topbar">
        <button
          ref={navigationTrigger}
          className="mobile-control menu-control"
          aria-label={mobileNavigationOpen ? "Close project navigation" : "Open project navigation"}
          aria-expanded={mobileNavigationOpen}
          aria-controls="project-navigation"
          onClick={() => setMobileNavigationOpen((open) => !open)}
        >
          <span aria-hidden="true">☰</span>
        </button>
        <Link className="brand" to="/design" aria-label="EDA Studio home">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span className="brand-copy"><strong>EDA Studio</strong><small>LOCAL DESIGN WORKSPACE</small></span>
        </Link>
        <div className="project-context">
          <span className="context-label">PROJECT</span>
          <span className="project-name">{projectName}</span>
          <span className="context-divider" aria-hidden="true" />
          <span className="revision-label"><span className="revision-dot" />{build ? `Build ${build.build_id.slice(0, 8)}` : project ? "Draft · not compiled" : "Draft unavailable"}</span>
        </div>
        <div className="header-actions">
          <span className={`api-indicator api-${healthState}`} role="status" aria-live="polite">
            <span className="status-light" />
            {healthState === "loading" ? "Connecting" : healthState === "connected" ? "Local API connected" : "Local API offline"}
          </span>
          {healthState === "offline" && <button className="retry-api" onClick={() => setHealthReload((value) => value + 1)}>Retry</button>}
          <div className="action-divider" aria-hidden="true" />
          <button
            className="action-button"
            disabled={!project || compileState === "running" || healthState !== "connected"}
            title={!project ? "Choose a project to compile it" : "Compile through the local sandboxed worker"}
            onClick={compileSelectedProject}
          >{compileState === "running" ? "Compiling…" : "Compile"}</button>
          <button className="action-button quiet-action" disabled title="Verification will be enabled after an analysis plan is configured">Verify</button>
          <button className="action-button export-action" disabled={!build} title={build ? "Evidence export is not part of this slice" : "Compile a project before exporting evidence"}>Export</button>
          <button
            ref={inspectorTrigger}
            className="mobile-control inspector-control"
            aria-label={mobileInspectorOpen ? "Close toolchain inspector" : "Open toolchain inspector"}
            aria-expanded={mobileInspectorOpen}
            aria-controls="toolchain-inspector"
            onClick={() => setMobileInspectorOpen((open) => !open)}
          >
            <span aria-hidden="true">◉</span>
          </button>
        </div>
      </header>

      {mobileNavigationOpen && <button className="drawer-scrim nav-scrim" tabIndex={-1} aria-label="Close project navigation" onClick={() => setMobileNavigationOpen(false)} />}
      <nav
        id="project-navigation"
        className={`project-navigation ${mobileNavigationOpen ? "drawer-open" : ""}`}
        aria-label="Project navigation"
      >
        <div className="navigation-heading">
          <span>PROJECT EXPLORER</span>
          <button aria-label="Refresh projects" onClick={() => setProjectsReload((value) => value + 1)}>↻</button>
        </div>
        {projects?.workspace_status === "not_configured" ? (
          <div className="workspace-message" role="status">
            <strong>Workspace not configured</strong>
            <span>Set EDA_STUDIO_WORKSPACE_ROOT and restart the local API.</span>
            <Link to="/settings">Workspace settings</Link>
          </div>
        ) : projects?.workspace_status === "unavailable" ? (
          <div className="workspace-message warning" role="status">
            <strong>Workspace unavailable</strong><span>Check the configured root, then retry project discovery.</span>
          </div>
        ) : null}
        {projectsError && <div className="workspace-message warning" role="alert">{projectsError}<button onClick={() => setProjectsReload((value) => value + 1)}>Retry discovery</button></div>}
        <div className="project-list" aria-label="Workspace projects">
          {projects?.projects.map((item) => (
            <button
              key={item.project_id}
              className={`project-choice${selectedProjectId === item.project_id ? " selected" : ""}`}
              aria-label={`Open ${item.name} project`}
              aria-pressed={selectedProjectId === item.project_id}
              onClick={() => selectProject(item.project_id)}
            >
              <span className="folder-icon" aria-hidden="true">▱</span>
              <span><strong>{item.name}</strong><small>{item.project_id}</small></span>
            </button>
          ))}
          {projects?.workspace_status === "available" && projects.projects.length === 0 && (
            <div className="no-project-card"><span className="folder-icon" aria-hidden="true">▱</span><div><strong>No supported projects found</strong><small>Projects need an EDA Stack manifest and TSX entrypoint.</small></div></div>
          )}
          {!projects && !projectsError && <div className="navigation-loading" role="status">Discovering workspace projects…</div>}
        </div>
        {project && (
          <>
            <div className="section-label">DESIGN FILES</div>
            <ul className="project-tree">
              <li><span className="tree-file"><span className="tree-icon">〈〉</span>{project.entrypoint}</span></li>
              {project.source_files.filter((source) => source.path !== project.entrypoint).map((source) => (
                <li key={source.path}><span className="tree-file"><span className="tree-icon">〈〉</span>{source.path}</span></li>
              ))}
            </ul>
          </>
        )}
        {projectLoading && <div className="navigation-loading" role="status">Opening project…</div>}
        {projectError && <div className="workspace-message warning" role="alert">{projectError}</div>}
        <div className="navigation-footer">
          <NavLink to="/settings" className={({ isActive }) => `settings-link${isActive ? " active" : ""}`}>
            <span aria-hidden="true">⚙</span> Toolchain &amp; settings
          </NavLink>
          <div className="local-badge"><span className="local-badge-dot" /> Runs on this device</div>
        </div>
      </nav>

      <main className="workspace-area">
        <nav className="workspace-tabs" aria-label="Workspace views">
          {views.map((view) => (
            <NavLink key={view.path} to={view.path} className={({ isActive }) => `workspace-tab${isActive ? " active" : ""}`}>
              <span aria-hidden="true">{view.icon}</span>{view.label}
            </NavLink>
          ))}
        </nav>
        <Outlet context={{
          project, projectLoading, build, compileError, compileState,
          workspaceStatus: projects?.workspace_status ?? "loading",
          workspaceName: projects?.workspace_name ?? null,
          onCompile: compileSelectedProject,
          onRetryProjects: () => setProjectsReload((value) => value + 1),
        }} />
        <ActivityPanel panelTab={panelTab} setPanelTab={setPanelTab} compileState={compileState} compileError={compileError} build={build} />
      </main>

      {mobileInspectorOpen && <button className="drawer-scrim inspector-scrim" tabIndex={-1} aria-label="Close toolchain inspector" onClick={() => setMobileInspectorOpen(false)} />}
      <aside
        id="toolchain-inspector"
        className={`inspector ${mobileInspectorOpen ? "drawer-open" : ""}`}
        aria-label="Toolchain inspector"
      >
        <div className="inspector-header">
          <div><span className="eyebrow">LOCAL ENVIRONMENT</span><h2>Toolchain status</h2></div>
          <button
            className="refresh-button"
            aria-label="Refresh toolchain status"
            disabled={toolchainRefreshing}
            onClick={() => setToolchainReload((value) => value + 1)}
          >{toolchainRefreshing ? "…" : "↻"}</button>
        </div>
        <p className="inspector-copy">Detected by the local Studio API. Tool availability describes this device; it does not certify a project.</p>
        {toolchainLoading ? (
          <div className="toolchain-message" role="status">Checking local tools…</div>
        ) : !toolchain ? (
          <div className="toolchain-message warning" role="status">
            <span className="message-icon" aria-hidden="true">!</span>
            <span>{toolchainError ? `Toolchain status is unknown because the local API could not be reached. ${toolchainError}` : "Toolchain status is unknown because the local API could not be reached."}</span>
          </div>
        ) : (
          <>
            {toolchainError && <div className="toolchain-message warning" role="status">Refresh failed; showing the last successful toolchain check. {toolchainError}</div>}
            <ul className="tool-list" aria-label="Detected local tools">
              {toolDefinitions.map((tool) => <ToolRow key={tool.key} label={tool.label} entry={toolchain.tools[tool.key]} />)}
            </ul>
          </>
        )}
        {toolchain && <p className="checked-at">Checked {formatTimestamp(toolchain.checked_at_utc)}</p>}
        <div className="selection-card">
          <div className="selection-card-header"><span className="selection-icon" aria-hidden="true">⌖</span><span>OPEN PROJECT</span></div>
          {project ? <><strong>{project.name}</strong><p>{project.source_file_count} TypeScript source file{project.source_file_count === 1 ? "" : "s"} · {project.entrypoint}</p></> : <><strong>Nothing selected</strong><p>Choose a workspace project to inspect its source metadata and compile it.</p></>}
        </div>
        <div className="inspector-note">
          <span className="note-mark" aria-hidden="true">i</span>
          <p>A compiled design is not the same as electrical verification or manufacturing review.</p>
        </div>
        <span className="api-build">API {health?.api_version ?? "v1"}{health ? ` · build ${health.build_version}` : ""}</span>
      </aside>
    </div>
  );
}

function ToolRow({ label, entry }: { label: string; entry?: ToolchainEntry }) {
  const statusText = entry?.status === "available" ? "Available" : entry?.status === "unavailable" ? "Unavailable" : entry?.status === "error" ? "Probe error" : "Unknown";
  const statusClass = entry?.status ?? "unknown";
  const details = [entry?.version, entry?.executable, entry?.reason].filter(Boolean);
  const detail = details.join(" · ") || "The API did not report this tool.";
  return (
    <li className="tool-row" aria-label={`${label}: ${statusText}`}>
      <span className={`tool-status-icon status-${statusClass}`} aria-hidden="true">{entry?.status === "available" ? "✓" : entry?.status === "unavailable" ? "–" : "!"}</span>
      <span className="tool-meta"><strong>{label}</strong><small title={detail}>{detail}</small></span>
      <span className={`tool-pill pill-${statusClass}`}>{statusText}</span>
    </li>
  );
}

function ActivityPanel({
  panelTab,
  setPanelTab,
  compileState,
  compileError,
  build,
}: {
  panelTab: PanelTab;
  setPanelTab: (tab: PanelTab) => void;
  compileState: CompileState;
  compileError: string | null;
  build: CompileResponse | null;
}) {
  const tabs: PanelTab[] = ["Problems", "Jobs", "Waveforms", "Console", "Evidence", "Comparison"];
  const selectedIndex = tabs.indexOf(panelTab);
  function handleKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    let index = selectedIndex;
    if (event.key === "ArrowRight") index = (selectedIndex + 1) % tabs.length;
    else if (event.key === "ArrowLeft") index = (selectedIndex - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") index = 0;
    else if (event.key === "End") index = tabs.length - 1;
    else return;
    event.preventDefault();
    setPanelTab(tabs[index]);
    document.getElementById(`activity-tab-${tabs[index].toLowerCase()}`)?.focus();
  }
  let message = "No project loaded — nothing to report.";
  if (panelTab === "Jobs") {
    message = compileState === "running" ? "Compilation is running in the local sandboxed worker." : build ? `Build ${build.build_id} completed for ${build.project_name}.` : compileError ? `Compilation failed: ${compileError}` : "No compile jobs have run.";
  } else if (panelTab === "Problems") {
    message = compileError ? `Compilation failed: ${compileError}` : build ? "Compile completed; electrical verification has not run." : "No project loaded — nothing to report.";
  } else if (panelTab === "Console" && compileError) {
    message = compileError;
  } else if (panelTab === "Evidence" && build) {
    message = `${Object.keys(build.artifacts).length} indexed compile artifacts; parts remain ${build.parts_verification.status}.`;
  } else {
    message = `${panelTab} data will appear when a supported workflow produces it.`;
  }
  return (
    <section className="bottom-panel" aria-label="Workspace activity">
      <div className="panel-tabs" role="tablist" aria-label="Activity panel">
        {tabs.map((tab) => (
          <button
            key={tab}
            id={`activity-tab-${tab.toLowerCase()}`}
            role="tab"
            aria-selected={panelTab === tab}
            aria-controls="activity-panel"
            tabIndex={panelTab === tab ? 0 : -1}
            className={panelTab === tab ? "selected" : ""}
            onClick={() => setPanelTab(tab)}
            onKeyDown={handleKeyDown}
          >{tab}{tab === "Problems" && <span className="panel-count">{compileError ? "1" : "0"}</span>}</button>
        ))}
      </div>
      <div id="activity-panel" className="panel-content" role="tabpanel" aria-labelledby={`activity-tab-${panelTab.toLowerCase()}`} tabIndex={0}>
        <span className="panel-empty-icon" aria-hidden="true">{compileError ? "!" : panelTab === "Problems" ? "✓" : "⌁"}</span>
        <span>{message}</span>
      </div>
    </section>
  );
}

type WorkspaceKind = "design" | "simulate" | "pcb" | "components" | "checks" | "settings";
type WorkspaceOutlet = {
  project: ProjectDetailResponse | null;
  projectLoading: boolean;
  build: CompileResponse | null;
  compileError: string | null;
  compileState: CompileState;
  workspaceStatus: ProjectListResponse["workspace_status"] | "loading";
  workspaceName: string | null;
  onCompile: () => void;
  onRetryProjects: () => void;
};

function WorkspaceView({ view }: { view: WorkspaceKind }) {
  const {
    project, projectLoading, build, compileError, compileState,
    workspaceStatus, workspaceName, onCompile, onRetryProjects,
  } = useOutletContext<WorkspaceOutlet>();
  const copy: Record<WorkspaceKind, { title: string; eyebrow: string; description: string; emptyTitle: string; emptyDescription: string }> = {
    design: {
      title: "Design workspace", eyebrow: "DESIGN", description: "Open an existing tscircuit project and compile it through the local sandboxed worker.",
      emptyTitle: "Choose a project", emptyDescription: "Select a supported project from the explorer to inspect its entrypoint and build artifacts.",
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
      emptyTitle: "No checks have run", emptyDescription: "A successful compile does not imply that electrical or manufacturing checks passed.",
    },
    settings: {
      title: "Toolchain & settings", eyebrow: "SETTINGS", description: "Review local tool discovery and configure the workspace root used by Studio.",
      emptyTitle: "Workspace configuration", emptyDescription: "Set the workspace root in the local API environment, then restart the API and refresh projects.",
    },
  };
  const text = copy[view];
  return (
    <section className="view-content" aria-labelledby="workspace-title">
      <div className="view-heading">
        <div><span className="eyebrow">{text.eyebrow} / WORKSPACE</span><h1 id="workspace-title">{text.title}</h1><p>{text.description}</p></div>
        <div className="revision-state"><span className="state-dot" />{build ? "Compiled · not verified" : project ? "Draft · not compiled" : "No project selected"}</div>
      </div>
      {view === "design" && project ? (
        <DesignProject project={project} build={build} compileError={compileError} compileState={compileState} onCompile={onCompile} />
      ) : view === "settings" ? (
        <div className="settings-card">
          <div className="settings-status"><span className={`state-chip state-${workspaceStatus}`} />
            <strong>{workspaceStatus === "available" ? `Workspace available${workspaceName ? ` · ${workspaceName}` : ""}` : workspaceStatus === "unavailable" ? "Configured workspace unavailable" : workspaceStatus === "not_configured" ? "Workspace not configured" : "Checking workspace"}</strong>
          </div>
          <p>{text.emptyDescription}</p>
          <code>EDA_STUDIO_WORKSPACE_ROOT</code>
          <p className="settings-help">Point this variable to a local directory containing supported EDA Stack project folders. Studio resolves the root on the server and only accepts project IDs within it.</p>
          <button className="setup-link" onClick={onRetryProjects}>Refresh project discovery <span aria-hidden="true">↻</span></button>
        </div>
      ) : projectLoading ? (
        <div className="empty-canvas loading-canvas" role="status">Opening project metadata…</div>
      ) : (
        <div className={`empty-canvas canvas-${view}`}>
          <div className="canvas-grid" aria-hidden="true" />
          <div className="empty-state">
            <div className="empty-art" aria-hidden="true">
              <span className="art-orbit orbit-one" /><span className="art-orbit orbit-two" />
              <span className="art-node node-a" /><span className="art-node node-b" /><span className="art-node node-c" />
              <span className="art-line line-a" /><span className="art-line line-b" />
              <span className="art-core">{view === "checks" ? "✓" : "⌁"}</span>
            </div>
            <span className="empty-kicker">{text.eyebrow} PREVIEW</span>
            <h2>{text.emptyTitle}</h2>
            <p>{text.emptyDescription}</p>
            {view === "design" && <Link className="setup-link" to="/settings">Open workspace settings <span aria-hidden="true">→</span></Link>}
            {view === "design" && <button className="text-action" onClick={onRetryProjects}>Retry project discovery</button>}
          </div>
          <div className="canvas-scale" aria-hidden="true"><span>0</span><i /><span>10 mm</span></div>
        </div>
      )}
      {view === "design" && project && <div className="canvas-footer"><span><span className="footer-dot" /> Source: {project.entrypoint}</span><span>{build ? `Build ${build.build_id}` : "No compiled revision"}</span></div>}
    </section>
  );
}

function DesignProject({
  project,
  build,
  compileError,
  compileState,
  onCompile,
}: {
  project: ProjectDetailResponse;
  build: CompileResponse | null;
  compileError: string | null;
  compileState: CompileState;
  onCompile: () => void;
}) {
  return (
    <div className="design-project">
      <div className="design-source-card">
        <span className="eyebrow">PROJECT SOURCE</span>
        <h2>{project.name}</h2>
        <p>Authoritative entrypoint: <code>{project.entrypoint}</code></p>
        <span>{project.source_file_count} TSX source file{project.source_file_count === 1 ? "" : "s"} · read-only in this workflow</span>
        <button className="setup-link" onClick={onCompile} disabled={compileState === "running"}>
          {compileState === "running" ? "Compiling through sandbox…" : build ? "Compile again" : "Compile project"}
        </button>
      </div>
      {compileError && <div className="compile-error" role="alert"><strong>Compilation failed</strong><span>{compileError}</span></div>}
      {build ? (
        <div className="build-report" aria-label="Compile build result">
          <div className="build-report-heading"><div><span className="eyebrow">COMPILED BUILD · NOT VERIFIED</span><h2>Build {build.build_id}</h2></div><span className="build-status">Compiled</span></div>
          <div className="build-summary"><span>{build.source_graph_counts.components} components · {build.source_graph_counts.ports} ports · {build.source_graph_counts.nets} nets</span><span>Parts {build.parts_verification.status} · {build.parts_verification.unresolved} unresolved</span></div>
          <div className="build-provenance"><strong>Toolchain provenance</strong><span>tscircuit {build.toolchain.tscircuit} · worker {build.toolchain.worker} · runtime {build.toolchain.compiler_runtime}</span><code>Sandbox {build.toolchain.sandbox_image}</code><code>Compiler lock SHA-256 {build.toolchain.compiler_lock_sha256}</code></div>
          <div className="artifact-heading"><strong>Indexed artifacts</strong><span>SHA-256 verified by the local API</span></div>
          <ul className="artifact-list">
            {Object.entries(build.artifacts).map(([path, artifact]) => (
              <li key={path}><code>{path}</code><span>{formatBytes(artifact.bytes)}</span><small title={artifact.sha256}>{artifact.sha256.slice(0, 12)}…</small></li>
            ))}
          </ul>
          <div className="manifest-digest">Manifest SHA-256 <code>{build.manifest_sha256}</code></div>
        </div>
      ) : (
        <div className="build-placeholder" role="status">{compileState === "running" ? "The local sandbox is compiling this project. The build report will appear here when the API verifies its manifest." : "Compile this selected project to inspect its source graph, part status and indexed artifacts."}</div>
      )}
    </div>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "time unavailable";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(date);
}

export default StudioApp;
