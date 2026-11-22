// Rojo Studio worker: owns every Rojo process, finds and installs Rojo, inspects project files and
// keeps the panel, the status bar item and the command palette in sync. It is a `trusted-worker`
// (a Node process, docs/reference/plugin-authoring.md); with a status bar item Orca keeps it
// running while the plugin is enabled, so servers survive the panel being closed.
import type { OrcaWorkerApi } from 'orca/worker'
import { mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type {
  ActionResult,
  FocusedWorkspace,
  Job,
  ProjectFile,
  ProjectPrefs,
  RecentProject,
  RojoInstall,
  SettingsSnapshot,
  State,
  ToolchainPin
} from './protocol'
import { compareVersions, latestInstallable, osName, toInfo, type Release } from './core/releases'
import {
  checkBuildOutput,
  compareProjectPaths,
  defaultBuildOutput,
  inspectProject,
  summarizeProject
} from './core/project'
import {
  dataDir,
  detectInstalls,
  exists,
  fileSize,
  findProjectFiles,
  home,
  nodeFs,
  pickActive,
  readToolchainPin
} from './system'
import { fetchReleases, installRelease, studioPluginFile, uninstallManaged } from './installer'
import { JobManager, isActive, type JobSpec } from './jobs'
import { bindAddress, countClients, findFreePort, isPortFree, lanAddresses, probeRojo, type BindHost } from './net'

const RELEASE_CACHE_MS = 60 * 60 * 1000
const RECENT_LIMIT = 10
const RBXM_CHUNK = 192 * 1024

export const DEFAULT_SETTINGS: SettingsSnapshot = {
  defaultHost: 'localhost',
  defaultPort: 34872,
  runIn: 'auto',
  notifyOnError: true,
  includePrereleases: false,
  checkForUpdates: true,
  sourcemapWithServe: false,
  rojoPath: ''
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function relTo(root: string | null, path: string): string {
  if (!root) return path
  const rel = relative(root, path)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.replace(/\\/g, '/') : path
}

export class RojoStudio {
  private workspace: FocusedWorkspace | null = null
  private projects: ProjectFile[] = []
  private selected: Record<string, string> = {}
  private prefs: Record<string, ProjectPrefs> = {}
  private recent: RecentProject[] = []
  private installs: RojoInstall[] = []
  private chosen: string | null = null
  private detecting = false
  private detectedFor: string | null | undefined = undefined
  private toolchain: ToolchainPin | null = null
  private releases: { at: number; list: Release[] } | null = null
  private install: State['install'] = null
  private settings: SettingsSnapshot = { ...DEFAULT_SETTINGS }
  private ready = false
  readonly jobs: JobManager
  private postTimer: ReturnType<typeof setTimeout> | null = null
  private pendingLogs = new Map<string, string[]>()
  private logTimer: ReturnType<typeof setTimeout> | null = null
  private clientTimer: ReturnType<typeof setInterval> | null = null
  private rbxm: { version: string; name: string; bytes: Uint8Array } | null = null
  private lastStatusText = ''

  constructor(private readonly orca: OrcaWorkerApi) {
    this.jobs = new JobManager(orca, {
      changed: () => this.changed(),
      lines: (id, lines) => this.queueLines(id, lines),
      finished: (job, logs) => this.onFinished(job, logs)
    })
  }

  // -------------------------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------------------------

  async start() {
    await this.loadStored()
    await this.loadSettings()
    this.orca.settings.onDidChange(() => {
      void this.loadSettings().then(() => this.changed())
    })
    this.registerHandlers()
    this.registerCommands()
    this.orca.events.on('workspace.changed', () => {
      void this.refreshContext()
    })
    this.clientTimer = setInterval(() => void this.pollClients(), 3000)
    await this.refreshContext()
    this.ready = true
    this.changed()
    void this.checkForUpdates()
  }

  dispose() {
    if (this.clientTimer) clearInterval(this.clientTimer)
    this.jobs.killAll()
  }

  private async loadStored() {
    const get = async <T>(key: string, fallback: T): Promise<T> => {
      try {
        const value = await this.orca.storage.get(key)
        return (value ?? fallback) as T
      } catch {
        return fallback
      }
    }
    this.selected = await get('selected', {})
    this.prefs = await get('prefs', {})
    this.recent = await get('recent', [])
    this.chosen = await get<string | null>('rojo.chosen', null)
    const cache = await get<{ at: number; list: Release[] } | null>('releases.cache', null)
    if (cache && Array.isArray(cache.list)) this.releases = cache
  }

  private async save(key: string, value: unknown) {
    try {
      await this.orca.storage.set(key, value as never)
    } catch (error) {
      this.orca.log(`storage.set ${key} failed: ${errorText(error)}`)
    }
  }

  private async loadSettings() {
    try {
      const all = (await this.orca.settings.get()) as Record<string, unknown>
      const s = { ...DEFAULT_SETTINGS }
      if (all.defaultHost === '0.0.0.0' || all.defaultHost === 'localhost') s.defaultHost = all.defaultHost
      if (typeof all.defaultPort === 'number' && all.defaultPort >= 1 && all.defaultPort <= 65535) s.defaultPort = all.defaultPort
      if (all.runIn === 'auto' || all.runIn === 'process' || all.runIn === 'terminal') s.runIn = all.runIn
      for (const key of ['notifyOnError', 'includePrereleases', 'checkForUpdates', 'sourcemapWithServe'] as const) {
        if (typeof all[key] === 'boolean') s[key] = all[key] as boolean
      }
      if (typeof all.rojoPath === 'string') s.rojoPath = all.rojoPath
      const pathChanged = s.rojoPath !== this.settings.rojoPath
      this.settings = s
      if (pathChanged && this.ready) void this.detect(true)
    } catch (error) {
      this.orca.log(`settings.get failed: ${errorText(error)}`)
    }
  }

  // -------------------------------------------------------------------------------------------
  // State and posting
  // -------------------------------------------------------------------------------------------

  snapshot(): State {
    const active = pickActive(this.installs, this.chosen, this.toolchain)
    const latest = this.releases ? latestInstallable(this.releases.list, this.settings.includePrereleases) : null
    const selectedProject = this.selectedPath()
    return {
      ready: this.ready,
      workspace: this.workspace,
      projects: this.projects,
      selectedProject,
      prefs: this.prefsFor(selectedProject),
      toolchain: this.toolchain,
      rojo: {
        active,
        installs: this.installs,
        chosen: this.chosen,
        detecting: this.detecting,
        latest: latest ? toInfo(latest) : null,
        updateAvailable: !!(latest && active?.version && compareVersions(latest.version, active.version) > 0)
      },
      install: this.install,
      jobs: this.jobs.list(),
      recent: this.recent,
      platform: {
        os: osName(process.platform),
        arch: process.arch,
        studioPluginSupported: process.platform === 'win32' || process.platform === 'darwin',
        lanAddresses: lanAddresses(),
        dataDir: dataDir()
      },
      settings: this.settings
    }
  }

  private changed() {
    if (this.postTimer) return
    this.postTimer = setTimeout(() => {
      this.postTimer = null
      const state = this.snapshot()
      try {
        this.orca.panels.post('state', state)
      } catch (error) {
        this.orca.log(`post state failed: ${errorText(error)}`)
      }
      void this.updateStatusBar(state)
    }, 60)
  }

  private queueLines(id: string, lines: string[]) {
    const list = this.pendingLogs.get(id) ?? []
    list.push(...lines)
    this.pendingLogs.set(id, list)
    if (this.logTimer) return
    this.logTimer = setTimeout(() => {
      this.logTimer = null
      for (const [jobId, pending] of this.pendingLogs) {
        // Posts are capped at 256 KiB and 200 per 10 s; keep each one small.
        const tail = pending.slice(-400).map((line) => (line.length > 2000 ? `${line.slice(0, 2000)}…` : line))
        try {
          this.orca.panels.post('log', { id: jobId, lines: tail })
        } catch {
          /* no panel open */
        }
      }
      this.pendingLogs.clear()
    }, 200)
  }

  private toast(tone: 'success' | 'danger' | 'neutral', message: string) {
    try {
      this.orca.panels.post('toast', { tone, message })
    } catch {
      /* no panel open */
    }
  }

  private async updateStatusBar(state: State) {
    if (!this.orca.host.has('statusBar.update')) return
    const servers = state.jobs.filter((j) => j.kind === 'serve' && isActive(j))
    const failed = state.jobs.find((j) => j.kind === 'serve' && j.status === 'error' && Date.now() - (j.endedAt ?? 0) < 10 * 60 * 1000)
    let text = 'Rojo'
    let tone: 'neutral' | 'success' | 'warning' | 'danger' | 'accent' = 'neutral'
    let tooltip = 'Rojo Studio: no server running. Click to show the panel.'
    if (servers.length === 1) {
      const s = servers[0]
      const clients = s.clients ? ` · ${s.clients} connected` : ''
      text = s.status === 'running' ? `Rojo :${s.port}${s.clients ? ' ●' : ''}` : 'Rojo …'
      tone = s.status === 'running' ? 'success' : 'warning'
      tooltip = `Rojo Studio: serving ${s.projectName ?? 'project'} on ${s.host}:${s.port}${clients}`
    } else if (servers.length > 1) {
      text = `Rojo ×${servers.length}`
      tone = 'success'
      tooltip = `Rojo Studio: ${servers.map((s) => `${s.projectName ?? 'project'} :${s.port}`).join(', ')}`
    } else if (failed) {
      text = 'Rojo error'
      tone = 'danger'
      tooltip = `Rojo Studio: ${failed.message ?? 'the server stopped with an error'}`
    }
    const key = `${text}|${tone}|${tooltip}`
    if (key === this.lastStatusText) return
    this.lastStatusText = key
    try {
      await this.orca.host.call('statusBar.update', { id: 'rojo', text, tone, tooltip, icon: 'rocket' })
    } catch {
      /* browser client or older Orca */
    }
  }

  // -------------------------------------------------------------------------------------------
  // Workspace and projects
  // -------------------------------------------------------------------------------------------

  async refreshContext() {
    let next: FocusedWorkspace | null = null
    try {
      const context = await this.orca.host.call('workspace.readContext', {})
      if (context?.workspaceId) {
        next = { id: context.workspaceId, name: context.displayName || context.branch, path: null, hostId: null, local: false }
        if (this.orca.host.has('workspace.list')) {
          const listed = await this.orca.host.call('workspace.list', {})
          const row = listed.workspaces.find((w) => w.id === context.workspaceId)
          if (row) {
            next.path = row.path
            next.hostId = row.hostId
            next.name = context.displayName || row.name
            next.local = row.hostId === null || row.hostId === 'local'
          }
        }
      }
    } catch (error) {
      this.orca.log(`workspace context failed: ${errorText(error)}`)
    }
    this.workspace = next
    await this.scanProjects()
    if (this.detectedFor !== (next?.local ? next.path : null)) void this.detect(false)
    this.changed()
  }

  private async scanProjects() {
    const ws = this.workspace
    const found: ProjectFile[] = []
    if (ws?.local && ws.path) {
      const paths = (await findProjectFiles(ws.path)).sort((a, b) => compareProjectPaths(relTo(ws.path, a), relTo(ws.path, b)))
      for (const path of paths) found.push(await this.describeProject(path))
      this.toolchain = await readToolchainPin(ws.path)
    } else this.toolchain = null
    // A project picked from "recent" outside this workspace stays in the list.
    const extra = this.workspace ? this.selected[this.workspace.id] : this.selected['']
    if (extra && !found.some((p) => p.path === extra) && (await exists(extra))) found.push(await this.describeProject(extra))
    this.projects = found
  }

  private async describeProject(path: string): Promise<ProjectFile> {
    const text = await nodeFs.readText(path)
    const info = text === null ? { name: null, kind: 'unknown' as const, servePort: null, error: 'Cannot read the file.' } : summarizeProject(text)
    return { path, rel: relTo(this.workspace?.path ?? null, path), ...info }
  }

  private selectedPath(): string | null {
    const key = this.workspace?.id ?? ''
    const chosen = this.selected[key]
    if (chosen && this.projects.some((p) => p.path === chosen)) return chosen
    return this.projects[0]?.path ?? null
  }

  private project(path: string): ProjectFile | null {
    return this.projects.find((p) => p.path === path) ?? null
  }

  /**
   * The project for a job. On a remote workspace the worker cannot list files, so the panel sends
   * the project file's path as typed, relative to the workspace folder on that host.
   */
  private projectFor(path: string): ProjectFile | null {
    const known = this.project(path)
    if (known) return known
    const ws = this.workspace
    if (!ws || ws.local || !ws.path || !path.trim()) return null
    const clean = path.trim().replace(/\\/g, '/')
    const abs = clean.startsWith('/') ? clean : `${ws.path.replace(/\/+$/, '')}/${clean}`
    return { path: abs, rel: clean, name: null, kind: 'unknown', servePort: null, error: null }
  }

  private prefsFor(path: string | null): ProjectPrefs {
    const project = path ? this.project(path) : null
    const stored = path ? this.prefs[path] : undefined
    return {
      host: this.settings.defaultHost,
      port: project?.servePort ?? this.settings.defaultPort,
      buildOutput: defaultBuildOutput(project?.name ?? null, project?.kind ?? 'unknown'),
      sourcemapOutput: 'sourcemap.json',
      includeNonScripts: false,
      absolutePaths: false,
      ...stored
    }
  }

  private async rememberRecent(path: string) {
    const project = this.project(path)
    this.recent = [
      { path, name: project?.name ?? null, workspace: this.workspace?.name ?? null, at: Date.now() },
      ...this.recent.filter((r) => r.path !== path)
    ].slice(0, RECENT_LIMIT)
    await this.save('recent', this.recent)
  }

  // -------------------------------------------------------------------------------------------
  // Rojo installations and releases
  // -------------------------------------------------------------------------------------------

  async detect(force: boolean) {
    const dir = this.workspace?.local ? this.workspace.path : null
    if (this.detecting && !force) return
    this.detecting = true
    this.changed()
    try {
      this.installs = await detectInstalls({ workspaceDir: dir, customPath: this.settings.rojoPath })
      this.detectedFor = dir
    } catch (error) {
      this.orca.log(`detect failed: ${errorText(error)}`)
    } finally {
      this.detecting = false
      this.changed()
    }
  }

  private activeRojo(): RojoInstall | null {
    return pickActive(this.installs, this.chosen, this.toolchain)
  }

  async getReleases(force: boolean): Promise<Release[]> {
    if (!force && this.releases && Date.now() - this.releases.at < RELEASE_CACHE_MS) return this.releases.list
    const list = await fetchReleases()
    this.releases = { at: Date.now(), list }
    await this.save('releases.cache', this.releases)
    this.changed()
    return list
  }

  private async checkForUpdates() {
    if (!this.settings.checkForUpdates) return
    try {
      await this.getReleases(false)
    } catch (error) {
      this.orca.log(`update check failed: ${errorText(error)}`)
    }
  }

  private async installTag(tag: string): Promise<void> {
    const release = (await this.getReleases(false)).find((r) => r.tag === tag) ?? (await this.getReleases(true)).find((r) => r.tag === tag)
    if (!release) throw new Error(`Release ${tag} not found.`)
    let last = 0
    const path = await installRelease(release, (progress) => {
      this.install = progress
      const now = Date.now()
      if (progress.phase !== 'download' || now - last > 150) {
        last = now
        this.changed()
      }
    })
    this.chosen = path
    await this.save('rojo.chosen', path)
    await this.detect(true)
    this.install = null
    this.changed()
    this.toast('success', `Rojo ${release.version} is installed and selected.`)
  }

  // -------------------------------------------------------------------------------------------
  // Jobs
  // -------------------------------------------------------------------------------------------

  private runnerFor(): 'process' | 'terminal' {
    if (this.settings.runIn === 'process') return 'process'
    if (this.settings.runIn === 'terminal') return 'terminal'
    return this.workspace && !this.workspace.local ? 'terminal' : 'process'
  }

  /** Binary, working folder and runner for a job, or an error. */
  private prepare(projectPath: string | null): { bin: string; runner: 'process' | 'terminal'; cwd: string } | { error: string } {
    const runner = this.runnerFor()
    const cwd = projectPath ? dirname(projectPath) : (this.workspace?.path ?? home())
    if (runner === 'terminal') {
      if (!this.workspace) return { error: 'Focus a workspace first: the command runs in one of its terminals.' }
      // On another host the plugin's own Rojo does not exist; use the host's `rojo`.
      const active = this.workspace.local ? this.activeRojo() : null
      return { bin: active?.path ?? 'rojo', runner, cwd }
    }
    if (this.workspace && !this.workspace.local)
      return { error: 'This workspace is on another host. Set "Run Rojo in" to "Orca terminal" (or Automatic) in the plugin settings.' }
    const active = this.activeRojo()
    if (!active) return { error: 'Rojo is not installed. Open the Setup tab to download it.' }
    return { bin: active.path, runner, cwd }
  }

  private colorArgs(): string[] {
    const version = this.activeRojo()?.version
    return version && compareVersions(version, '7.0.0') >= 0 ? ['--color', 'never'] : []
  }

  private async launch(spec: Omit<JobSpec, 'bin' | 'runner' | 'cwd' | 'workspaceId'> & { cwd?: string }): Promise<ActionResult> {
    const prepared = this.prepare(spec.projectPath)
    if ('error' in prepared) return { ok: false, message: prepared.error }
    const job = await this.jobs.start({
      ...spec,
      cwd: spec.cwd ?? prepared.cwd,
      bin: prepared.bin,
      runner: prepared.runner,
      args: [...spec.args, ...this.colorArgs()],
      ...(this.workspace ? { workspaceId: this.workspace.id } : {})
    })
    return { ok: true, message: `${spec.title} started.`, jobId: job.id }
  }

  async serve(path: string, host: BindHost, port: number): Promise<ActionResult> {
    const project = this.projectFor(path)
    if (!project) return { ok: false, message: 'That project file is not in this workspace any more.' }
    path = project.path
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, message: 'The port must be a whole number from 1 to 65535.' }
    const running = this.jobs.find('serve', path)
    if (running) return { ok: false, message: `${project.name ?? 'This project'} is already being served on port ${running.port}.`, jobId: running.id }
    const mine = this.jobs.list().find((j) => j.kind === 'serve' && isActive(j) && j.port === port)
    const taken = new Set(this.jobs.list().filter((j) => j.kind === 'serve' && isActive(j) && j.port).map((j) => j.port as number))
    await this.setPrefs(path, { host, port })
    const runner = this.runnerFor()
    if (runner === 'process' && (mine || !(await isPortFree(host, port)))) {
      const holder = mine ? `${mine.projectName ?? 'another project'} (served by Rojo Studio)` : await probeRojo(port)
      const suggestion = await findFreePort(host, port, taken)
      // Nothing is started: the busy port is reported on a job so the panel can offer the fix.
      const job = this.jobs.failed(
        {
          kind: 'serve',
          title: `Serve ${project.name ?? project.rel}`,
          projectPath: path,
          projectName: project.name,
          command: `rojo serve --address ${bindAddress(host)} --port ${port}`,
          runner: 'process',
          host,
          port
        },
        {
          message: `Port ${port} is already in use${holder ? ` by ${holder}` : ''}.`,
          ...(suggestion ? { suggestedPort: suggestion } : {}),
          ...(holder ? { portHolder: holder } : {})
        }
      )
      return { ok: false, message: `Port ${port} is in use.`, jobId: job.id }
    }
    const result = await this.launch({
      kind: 'serve',
      title: `Serve ${project.name ?? project.rel}`,
      projectPath: path,
      projectName: project.name,
      args: ['serve', path, '--address', bindAddress(host), '--port', String(port)],
      host,
      port
    })
    if (result.ok) {
      await this.rememberRecent(path)
      if (this.settings.sourcemapWithServe && !this.jobs.find('sourcemap-watch', path)) {
        const prefs = this.prefsFor(path)
        await this.sourcemap(path, prefs.sourcemapOutput, prefs.includeNonScripts, prefs.absolutePaths, true)
      }
    }
    return result
  }

  async build(path: string, output: string, watch: boolean): Promise<ActionResult> {
    const project = this.projectFor(path)
    if (!project) return { ok: false, message: 'That project file is not in this workspace any more.' }
    path = project.path
    const problem = checkBuildOutput(output.trim(), project.kind)
    if (problem) return { ok: false, message: problem }
    const kind = watch ? 'build-watch' : 'build'
    const existing = this.jobs.find('build-watch', path)
    if (watch && existing) return { ok: false, message: 'A watch build is already running for this project.', jobId: existing.id }
    const target = resolve(dirname(path), output.trim())
    if (this.runnerFor() === 'process') await mkdir(dirname(target), { recursive: true }).catch(() => undefined)
    await this.setPrefs(path, { buildOutput: output.trim() })
    const result = await this.launch({
      kind,
      title: `${watch ? 'Watch build' : 'Build'} ${project.name ?? project.rel}`,
      projectPath: path,
      projectName: project.name,
      args: ['build', path, '--output', target, ...(watch ? ['--watch'] : [])],
      output: target
    })
    if (result.ok) await this.rememberRecent(path)
    return result
  }

  async sourcemap(path: string, output: string, includeNonScripts: boolean, absolute: boolean, watch: boolean): Promise<ActionResult> {
    const project = this.projectFor(path)
    if (!project) return { ok: false, message: 'That project file is not in this workspace any more.' }
    path = project.path
    const out = output.trim() || 'sourcemap.json'
    if (!/\.json$/i.test(out)) return { ok: false, message: 'The sourcemap file must end in .json.' }
    const existing = this.jobs.find('sourcemap-watch', path)
    if (watch && existing) return { ok: false, message: 'A sourcemap watcher is already running for this project.', jobId: existing.id }
    const target = resolve(dirname(path), out)
    await this.setPrefs(path, { sourcemapOutput: out, includeNonScripts, absolutePaths: absolute })
    return this.launch({
      kind: watch ? 'sourcemap-watch' : 'sourcemap',
      title: `${watch ? 'Watch sourcemap' : 'Sourcemap'} ${project.name ?? project.rel}`,
      projectPath: path,
      projectName: project.name,
      args: [
        'sourcemap',
        path,
        '--output',
        target,
        ...(includeNonScripts ? ['--include-non-scripts'] : []),
        ...(absolute ? ['--absolute'] : []),
        ...(watch ? ['--watch'] : [])
      ],
      output: target
    })
  }

  async init(folder: string, kind: 'place' | 'model' | 'plugin', git: boolean): Promise<ActionResult> {
    const raw = folder.trim()
    if (!raw) return { ok: false, message: 'Choose a folder for the new project.' }
    const base = this.workspace?.path ?? home()
    const target = isAbsolute(raw) ? raw : resolve(base, raw)
    if (this.runnerFor() === 'process') {
      if (await exists(join(target, 'default.project.json'))) return { ok: false, message: `${target} already has a default.project.json.` }
    }
    return this.launch({
      kind: 'init',
      title: `New ${kind} project`,
      projectPath: null,
      projectName: target.split(/[\\/]/).pop() ?? null,
      args: ['init', target, '--kind', kind, ...(git ? [] : ['--skip-git'])],
      output: join(target, 'default.project.json'),
      cwd: base
    })
  }

  async installStudioPlugin(): Promise<ActionResult> {
    if (process.platform !== 'win32' && process.platform !== 'darwin')
      return {
        ok: false,
        message:
          'Roblox Studio runs only on Windows and macOS, so Rojo cannot install its plugin here. Save Rojo.rbxm and copy it into Studio\'s Plugins folder on that machine, or install "Rojo" from the Creator Store.'
      }
    return this.launch({ kind: 'plugin', title: 'Install the Studio plugin', projectPath: null, projectName: null, args: ['plugin', 'install'] })
  }

  async rbxmChunk(offset: number): Promise<{ name: string; total: number; base64: string; error: string | null }> {
    try {
      const releases = await this.getReleases(false)
      const version = this.activeRojo()?.version
      const release =
        (version && releases.find((r) => r.version === version)) || latestInstallable(releases, this.settings.includePrereleases)
      if (!release) throw new Error('No Rojo release found.')
      if (!this.rbxm || this.rbxm.version !== release.version) {
        const file = await studioPluginFile(release)
        this.rbxm = { version: release.version, ...file }
      }
      const { bytes } = this.rbxm
      const start = Math.max(0, Math.floor(offset))
      return { name: `Rojo-${release.version}.rbxm`, total: bytes.length, base64: toBase64(bytes.subarray(start, start + RBXM_CHUNK)), error: null }
    } catch (error) {
      return { name: 'Rojo.rbxm', total: 0, base64: '', error: errorText(error) }
    }
  }

  private async setPrefs(path: string, prefs: Partial<ProjectPrefs>): Promise<ProjectPrefs> {
    const next = { ...this.prefsFor(path), ...prefs }
    this.prefs[path] = next
    await this.save('prefs', this.prefs)
    this.changed()
    return next
  }

  private async onFinished(job: Job, logs: readonly string[]) {
    if (job.kind === 'serve' && job.status === 'error' && this.jobs.portInUse(job.id) && job.port && job.host) {
      const holder = await probeRojo(job.port)
      const taken = new Set(this.jobs.list().filter((j) => j.kind === 'serve' && isActive(j) && j.port).map((j) => j.port as number))
      const suggestion = await findFreePort(job.host as BindHost, job.port, taken)
      this.jobs.patch(job.id, {
        message: `Port ${job.port} is already in use${holder ? ` by ${holder}` : ''}.`,
        ...(suggestion ? { suggestedPort: suggestion } : {}),
        ...(holder ? { portHolder: holder } : {})
      })
    }
    if ((job.kind === 'build' || job.kind === 'sourcemap') && job.status === 'done' && job.output && job.runner === 'process') {
      const size = await fileSize(job.output)
      const name = job.output.split(/[\\/]/).pop()
      this.jobs.patch(job.id, { ...(size !== null ? { outputBytes: size } : {}), message: `Wrote ${name}${size !== null ? ` (${formatBytes(size)})` : ''}.` })
    }
    if (job.kind === 'init' && job.status === 'done' && job.output) {
      await this.scanProjects()
      if (await exists(job.output)) {
        this.selected[this.workspace?.id ?? ''] = job.output
        await this.save('selected', this.selected)
        await this.scanProjects()
        await this.rememberRecent(job.output)
      }
      this.jobs.patch(job.id, { message: `Created ${job.output}.` })
      this.toast('success', 'Project created.')
    }
    if (job.kind === 'plugin' && job.status === 'done') this.toast('success', 'The Rojo plugin is installed. Restart Roblox Studio to load it.')
    const longRunningFailure = (job.kind === 'serve' || job.kind === 'build-watch' || job.kind === 'sourcemap-watch') && job.status === 'error'
    if (longRunningFailure && this.settings.notifyOnError) {
      const current = this.jobs.get(job.id) ?? job
      try {
        await this.orca.host.call('notifications.show', {
          title: `Rojo: ${job.title} stopped`,
          body: (current.message ?? 'Rojo exited with an error.').slice(0, 240)
        })
      } catch {
        /* notifications unavailable */
      }
    }
    void logs
    this.changed()
  }

  private async pollClients() {
    for (const job of this.jobs.list()) {
      if (job.kind !== 'serve' || job.status !== 'running' || job.runner !== 'process' || !job.port) continue
      const clients = await countClients(job.port)
      if (clients !== null && clients !== job.clients) this.jobs.patch(job.id, { clients })
    }
  }

  // -------------------------------------------------------------------------------------------
  // Panel requests
  // -------------------------------------------------------------------------------------------

  private registerHandlers() {
    const p = this.orca.panels
    p.handle('state.get', () => this.snapshot())
    p.handle('state.refresh', async () => {
      await this.refreshContext()
      return this.snapshot()
    })
    p.handle('project.select', async ({ path }) => {
      this.selected[this.workspace?.id ?? ''] = path
      await this.save('selected', this.selected)
      if (!this.project(path)) await this.scanProjects()
      await this.rememberRecent(path)
      this.changed()
      return this.snapshot()
    })
    p.handle('project.inspect', ({ path }) => inspectProject(nodeFs, path))
    p.handle('project.open', async ({ path }) => {
      const ws = this.workspace
      if (!ws?.path) return { ok: false, message: 'No workspace is focused.' }
      const rel = relTo(ws.path, path)
      if (rel === path) return { ok: false, message: 'The file is outside this workspace, so Orca cannot open it here.' }
      try {
        await this.orca.host.call('editor.open', { workspaceId: ws.id, path: rel })
        return { ok: true, message: `Opened ${rel}.` }
      } catch (error) {
        return { ok: false, message: errorText(error) }
      }
    })
    p.handle('prefs.set', ({ path, prefs }) => this.setPrefs(path, prefs))
    p.handle('recent.remove', async ({ path }) => {
      this.recent = this.recent.filter((r) => r.path !== path)
      await this.save('recent', this.recent)
      return this.snapshot()
    })
    p.handle('serve.start', ({ path, host, port }) => this.serve(path, host, port))
    p.handle('job.stop', async ({ id }) => {
      const stopped = await this.jobs.stop(id)
      return { ok: stopped, message: stopped ? 'Stopping.' : 'That job is not running.' }
    })
    p.handle('job.dismiss', ({ id }) => {
      this.jobs.dismiss(id)
      return this.snapshot()
    })
    p.handle('job.logs', ({ id }) => ({ lines: this.jobs.logs(id) }))
    p.handle('port.check', async ({ host, port }) => {
      const mine = this.jobs.list().find((j) => j.kind === 'serve' && isActive(j) && j.port === port)
      if (!mine && (await isPortFree(host, port))) return { free: true, holder: null, suggestion: null }
      const holder = mine ? `${mine.projectName ?? 'another project'} (served by Rojo Studio)` : await probeRojo(port)
      return { free: false, holder, suggestion: await findFreePort(host, port) }
    })
    p.handle('build.run', ({ path, output, watch }) => this.build(path, output, watch))
    p.handle('sourcemap.run', ({ path, output, includeNonScripts, absolute, watch }) =>
      this.sourcemap(path, output, includeNonScripts, absolute, watch)
    )
    p.handle('init.run', ({ folder, kind, git }) => this.init(folder, kind, git))
    p.handle('rojo.releases', async ({ force }) => {
      try {
        const list = await this.getReleases(!!force)
        return { releases: list.map(toInfo), error: null }
      } catch (error) {
        return { releases: (this.releases?.list ?? []).map(toInfo), error: errorText(error) }
      }
    })
    p.handle('rojo.install', ({ tag }) => {
      if (this.install && this.install.phase !== 'error' && this.install.phase !== 'done')
        return { ok: false, message: 'An installation is already running.' }
      this.install = { tag, phase: 'download', received: 0, total: 0 }
      this.changed()
      void this.installTag(tag).catch((error) => {
        this.install = { tag, phase: 'error', received: 0, total: 0, message: errorText(error) }
        this.changed()
        this.toast('danger', `Installing Rojo failed: ${errorText(error)}`)
      })
      return { ok: true, message: `Installing Rojo ${tag}…` }
    })
    p.handle('rojo.choose', async ({ path }) => {
      this.chosen = path
      await this.save('rojo.chosen', path)
      this.changed()
      return this.snapshot()
    })
    p.handle('rojo.detect', async () => {
      await this.detect(true)
      return this.snapshot()
    })
    p.handle('rojo.uninstall', async ({ path }) => {
      if (this.jobs.list().some((j) => isActive(j) && j.runner === 'process' && this.activeRojo()?.path === path))
        throw Object.assign(new Error('Stop the running Rojo jobs first.'), { code: 'conflict' })
      if (await uninstallManaged(path)) {
        if (this.chosen === path) {
          this.chosen = null
          await this.save('rojo.chosen', null)
        }
        await this.detect(true)
      }
      return this.snapshot()
    })
    p.handle('studio.install', () => this.installStudioPlugin())
    p.handle('studio.rbxm', ({ offset }) => this.rbxmChunk(offset))
  }

  // -------------------------------------------------------------------------------------------
  // Command palette
  // -------------------------------------------------------------------------------------------

  private registerCommands() {
    const c = this.orca.commands
    c.register('rojo-studio.serve.toggle', async () => {
      const path = this.selectedPath()
      if (!path) return 'Rojo Studio: no *.project.json in this workspace.'
      const running = this.jobs.find('serve', path)
      if (running) {
        await this.jobs.stop(running.id)
        return `Rojo: stopped the server on port ${running.port}.`
      }
      const prefs = this.prefsFor(path)
      const result = await this.serve(path, prefs.host, prefs.port)
      return result.ok ? `Rojo: serving on ${prefs.host}:${prefs.port}.` : `Rojo: ${this.jobs.get(result.jobId ?? '')?.message ?? result.message}`
    })
    c.register('rojo-studio.serve.stopAll', async () => {
      const n = (await this.jobs.stopAll()) as number
      return n ? `Rojo: stopped ${n} job${n === 1 ? '' : 's'}.` : 'Rojo: nothing was running.'
    })
    c.register('rojo-studio.build', async () => {
      const path = this.selectedPath()
      if (!path) return 'Rojo Studio: no *.project.json in this workspace.'
      const result = await this.build(path, this.prefsFor(path).buildOutput, false)
      return `Rojo: ${result.message}`
    })
    c.register('rojo-studio.sourcemap', async () => {
      const path = this.selectedPath()
      if (!path) return 'Rojo Studio: no *.project.json in this workspace.'
      const prefs = this.prefsFor(path)
      const result = await this.sourcemap(path, prefs.sourcemapOutput, prefs.includeNonScripts, prefs.absolutePaths, false)
      return `Rojo: ${result.message}`
    })
  }
}

let current: RojoStudio | null = null

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  current = new RojoStudio(orca)
  await current.start()
}

export async function deactivate(): Promise<void> {
  current?.dispose()
  current = null
}
