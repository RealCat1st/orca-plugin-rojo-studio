// The contract between the panel (src/panel.ts) and the worker (src/worker.ts). Both sides import
// these types; the `declare module 'orca'` block types every `plugin.request`,
// `orca.panels.handle` and `orca.panels.post` call end to end
// (docs/reference/plugin-authoring.md, "Panels, workers and data").

export type Severity = 'error' | 'warning' | 'info'

/** One finding of the project-file linter. */
export type Issue = {
  severity: Severity
  message: string
  /** Where in the project file, e.g. `tree › ReplicatedStorage › Shared`. Empty for the file. */
  where: string
  hint?: string
  /** 1-based line of a JSON syntax error. */
  line?: number
  column?: number
}

export type NodeKind =
  | 'datamodel'
  | 'service'
  | 'folder'
  | 'script'
  | 'localscript'
  | 'module'
  | 'value'
  | 'model'
  | 'project'
  | 'instance'

/** One instance of the Roblox tree a project file describes. */
export type TreeNode = {
  key: string
  name: string
  className: string
  kind: NodeKind
  /** File or folder the node comes from, relative to the project folder. */
  source?: string
  /** True when `source` comes from a `$path` (rather than a file inside a mapped folder). */
  mapped?: boolean
  /** The `$path` does not exist. */
  missing?: boolean
  optional?: boolean
  /** Number of `$properties` / `$attributes`. */
  props?: number
  children?: TreeNode[]
  /** Children were cut off at the depth or size limit. */
  truncated?: boolean
}

export type ProjectKind = 'place' | 'model' | 'unknown'

/** A `*.project.json` file found in the workspace (or opened from recent projects). */
export type ProjectFile = {
  /** Absolute path of the project file. */
  path: string
  /** Path relative to the workspace root, or the absolute path for an outside project. */
  rel: string
  /** The project's `name`, when it parses. */
  name: string | null
  kind: ProjectKind
  servePort: number | null
  /** Parse error, when the file is not valid JSON. */
  error: string | null
}

export type ProjectInspection = {
  path: string
  name: string | null
  kind: ProjectKind
  tree: TreeNode | null
  issues: Issue[]
  /** Counts for the summary line. */
  stats: { instances: number; mapped: number; scripts: number; missing: number }
}

export type FocusedWorkspace = {
  id: string
  name: string
  /** Folder on its host, or null when Orca did not list it. */
  path: string | null
  hostId: string | null
  /** True when the folder is on this machine, so the worker can read it and run Rojo there. */
  local: boolean
}

export type InstallSource = 'managed' | 'custom' | 'path' | 'rokit' | 'aftman' | 'foreman' | 'cargo'

export type RojoInstall = {
  path: string
  version: string | null
  source: InstallSource
  /** Short human label, e.g. "Rokit shim". */
  label: string
  note?: string
}

/** A toolchain file in the workspace that pins Rojo (rokit.toml, aftman.toml, foreman.toml). */
export type ToolchainPin = { file: string; manager: 'rokit' | 'aftman' | 'foreman'; spec: string; version: string | null }

export type ReleaseInfo = {
  tag: string
  version: string
  name: string
  prerelease: boolean
  publishedAt: string
  url: string
  /** The zip for this machine, or null when the release has none. */
  assetName: string | null
  assetSize: number | null
}

export type JobKind = 'serve' | 'build' | 'build-watch' | 'sourcemap' | 'sourcemap-watch' | 'init' | 'plugin'
export type JobStatus = 'starting' | 'running' | 'stopping' | 'stopped' | 'done' | 'error'

/** A Rojo process the plugin started (or a command it typed into an Orca terminal). */
export type Job = {
  id: string
  kind: JobKind
  title: string
  projectPath: string | null
  projectName: string | null
  /** The command line, for display and "copy command". */
  command: string
  runner: 'process' | 'terminal'
  status: JobStatus
  startedAt: number
  endedAt: number | null
  exitCode: number | null
  /** One-line summary: the error Rojo printed, or what was produced. */
  message: string | null
  /** serve only */
  host?: string
  port?: number
  /** serve only: distinct hosts with an open connection to the server (Studio clients). */
  clients?: number
  /** build / sourcemap only: the file written. */
  output?: string
  outputBytes?: number
  /** serve only: the port was taken; a free one to suggest. */
  suggestedPort?: number
  /** serve only: what holds the port, when it is another Rojo server. */
  portHolder?: string
  lineCount: number
}

export type InstallProgress = {
  tag: string
  phase: 'download' | 'verify' | 'extract' | 'done' | 'error'
  received: number
  total: number
  message?: string
}

export type RecentProject = { path: string; name: string | null; workspace: string | null; at: number }

/** Remembered per project file. */
export type ProjectPrefs = {
  host: 'localhost' | '0.0.0.0'
  port: number
  buildOutput: string
  sourcemapOutput: string
  includeNonScripts: boolean
  absolutePaths: boolean
}

export type SettingsSnapshot = {
  defaultHost: 'localhost' | '0.0.0.0'
  defaultPort: number
  runIn: 'auto' | 'process' | 'terminal'
  notifyOnError: boolean
  includePrereleases: boolean
  checkForUpdates: boolean
  sourcemapWithServe: boolean
  rojoPath: string
}

export type PlatformInfo = {
  os: 'windows' | 'macos' | 'linux' | 'other'
  arch: string
  /** `rojo plugin install` works here (Windows, macOS). */
  studioPluginSupported: boolean
  /** Non-internal IPv4 addresses, for 0.0.0.0 servers. */
  lanAddresses: string[]
  dataDir: string
}

export type State = {
  ready: boolean
  workspace: FocusedWorkspace | null
  projects: ProjectFile[]
  selectedProject: string | null
  prefs: ProjectPrefs
  toolchain: ToolchainPin | null
  rojo: {
    active: RojoInstall | null
    installs: RojoInstall[]
    /** Path the person chose in the panel, or null for automatic. */
    chosen: string | null
    detecting: boolean
    latest: ReleaseInfo | null
    updateAvailable: boolean
  }
  install: InstallProgress | null
  jobs: Job[]
  recent: RecentProject[]
  platform: PlatformInfo
  settings: SettingsSnapshot
}

export type ActionResult = { ok: boolean; message: string; jobId?: string }

declare module 'orca' {
  interface PluginRequests {
    'state.get': { input: Record<string, never>; output: State }
    'state.refresh': { input: Record<string, never>; output: State }
    'project.select': { input: { path: string }; output: State }
    'project.inspect': { input: { path: string }; output: ProjectInspection }
    'project.open': { input: { path: string }; output: ActionResult }
    'prefs.set': { input: { path: string; prefs: Partial<ProjectPrefs> }; output: ProjectPrefs }
    'recent.remove': { input: { path: string }; output: State }
    'serve.start': { input: { path: string; host: 'localhost' | '0.0.0.0'; port: number }; output: ActionResult }
    'job.stop': { input: { id: string }; output: ActionResult }
    'job.dismiss': { input: { id: string }; output: State }
    'job.logs': { input: { id: string }; output: { lines: string[] } }
    'port.check': { input: { host: 'localhost' | '0.0.0.0'; port: number }; output: { free: boolean; holder: string | null; suggestion: number | null } }
    'build.run': { input: { path: string; output: string; watch: boolean }; output: ActionResult }
    'sourcemap.run': {
      input: { path: string; output: string; includeNonScripts: boolean; absolute: boolean; watch: boolean }
      output: ActionResult
    }
    'init.run': { input: { folder: string; kind: 'place' | 'model' | 'plugin'; git: boolean }; output: ActionResult }
    'rojo.releases': { input: { force?: boolean }; output: { releases: ReleaseInfo[]; error: string | null } }
    'rojo.install': { input: { tag: string }; output: ActionResult }
    'rojo.choose': { input: { path: string | null }; output: State }
    'rojo.detect': { input: Record<string, never>; output: State }
    'rojo.uninstall': { input: { path: string }; output: State }
    'studio.install': { input: Record<string, never>; output: ActionResult }
    'studio.rbxm': { input: { offset: number }; output: { name: string; total: number; base64: string; error: string | null } }
  }
  interface PluginPanelEvents {
    state: State
    log: { id: string; lines: string[] }
    toast: { tone: 'success' | 'danger' | 'neutral'; message: string }
  }
}
