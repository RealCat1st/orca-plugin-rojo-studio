// Rojo Studio panel: an HTML panel in Orca's isolated frame (`window.orca`). It holds no Rojo
// logic of its own: it asks the worker (`orca.plugin.request`) and redraws from the state the
// worker posts (`orca.plugin.on('state')`). The frame has no network and no file system.
import type {
  ActionResult,
  Issue,
  Job,
  ProjectInspection,
  ProjectPrefs,
  ReleaseInfo,
  RojoInstall,
  State,
  TreeNode
} from './protocol'
import { h, patchChildren, raw, type VElement, type VNode } from './panel/vdom'
import { icon } from './panel/icons'
import { LogView } from './panel/log'

type Tab = 'serve' | 'build' | 'project' | 'setup'
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'serve', label: 'Serve', icon: 'play' },
  { id: 'build', label: 'Build', icon: 'hammer' },
  { id: 'project', label: 'Project', icon: 'tree' },
  { id: 'setup', label: 'Setup', icon: 'settings' }
]
const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
const MOD = isMac ? '⌘' : 'Ctrl'

// ---------------------------------------------------------------------------------------------
// Local state
// ---------------------------------------------------------------------------------------------

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(`rojo-studio:${key}`)
    return v === null ? fallback : (JSON.parse(v) as T)
  } catch {
    return fallback
  }
}
function keep(key: string, value: unknown) {
  try {
    localStorage.setItem(`rojo-studio:${key}`, JSON.stringify(value))
  } catch {
    /* storage unavailable */
  }
}

type Form = {
  forPath: string | null
  host: 'localhost' | '0.0.0.0'
  port: string
  buildOutput: string
  buildWatch: boolean
  smOutput: string
  smNonScripts: boolean
  smAbsolute: boolean
  smWatch: boolean
  remoteProject: string
}

const ui = {
  tab: load<Tab>('tab', 'serve'),
  state: null as State | null,
  fatal: null as string | null,
  form: {
    forPath: null,
    host: 'localhost',
    port: '34872',
    buildOutput: '',
    buildWatch: false,
    smOutput: 'sourcemap.json',
    smNonScripts: false,
    smAbsolute: false,
    smWatch: false,
    remoteProject: 'default.project.json'
  } as Form,
  portCheck: null as { port: number; host: string; free: boolean; holder: string | null; suggestion: number | null } | null,
  busy: new Set<string>(),
  inspection: null as ProjectInspection | null,
  inspecting: false,
  expanded: new Set<string>(load<string[]>('expanded', [])),
  treeFocus: null as string | null,
  releases: null as ReleaseInfo[] | null,
  releasesError: null as string | null,
  releasesLoading: false,
  pickTag: '',
  init: { folder: load('initFolder', ''), kind: 'place' as 'place' | 'model' | 'plugin', git: true },
  newProjectOpen: false,
  jobView: { serve: null as string | null, build: null as string | null },
  toasts: [] as { id: number; tone: 'success' | 'danger' | 'neutral'; message: string; leaving?: boolean }[]
}

const logs = {
  serve: new LogView('serve-log'),
  build: new LogView('build-log')
}

// ---------------------------------------------------------------------------------------------
// Worker calls
// ---------------------------------------------------------------------------------------------

async function call<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  ui.busy.add(name)
  render()
  try {
    return await fn()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    toast('danger', message)
    return null
  } finally {
    ui.busy.delete(name)
    render()
  }
}

function report(result: ActionResult | null) {
  if (result && !result.ok && !result.jobId) toast('danger', result.message)
}

let toastSeq = 0
function toast(tone: 'success' | 'danger' | 'neutral', message: string) {
  const id = ++toastSeq
  ui.toasts = [...ui.toasts.slice(-2), { id, tone, message }]
  render()
  setTimeout(() => {
    const t = ui.toasts.find((x) => x.id === id)
    if (t) t.leaving = true
    render()
    setTimeout(() => {
      ui.toasts = ui.toasts.filter((x) => x.id !== id)
      render()
    }, 230)
  }, tone === 'danger' ? 6000 : 3200)
}

function copy(text: string, what = 'Copied') {
  // Plugin frames deny navigator.clipboard; execCommand('copy') works inside a click.
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  area.remove()
  toast(ok ? 'success' : 'danger', ok ? `${what}: ${text.length > 60 ? text.slice(0, 60) + '…' : text}` : 'Copy is not available here.')
}

// ---------------------------------------------------------------------------------------------
// Derived data
// ---------------------------------------------------------------------------------------------

function selected() {
  const s = ui.state
  if (!s?.selectedProject) return null
  return s.projects.find((p) => p.path === s.selectedProject) ?? null
}

function isRemote(): boolean {
  return !!ui.state?.workspace && !ui.state.workspace.local
}

/** Path used for jobs: the selected project, or the typed path on a remote workspace. */
function projectPath(): string | null {
  if (isRemote()) return ui.form.remoteProject.trim() || null
  return selected()?.path ?? null
}

function active(job: Job): boolean {
  return job.status === 'starting' || job.status === 'running' || job.status === 'stopping'
}

function jobsFor(kinds: Job['kind'][], path: string | null): Job[] {
  return (ui.state?.jobs ?? []).filter((j) => kinds.includes(j.kind) && (path === null || j.projectPath === path || (isRemote() && j.projectPath?.endsWith(path))))
}

function serveJob(): Job | null {
  const path = projectPath()
  const list = jobsFor(['serve'], path)
  return list.find(active) ?? list[0] ?? null
}

function syncForm() {
  const s = ui.state
  if (!s) return
  const path = s.selectedProject
  if (ui.form.forPath === path && ui.form.buildOutput) return
  const prefs: ProjectPrefs = s.prefs
  ui.form = {
    ...ui.form,
    forPath: path,
    host: prefs.host,
    port: String(prefs.port),
    buildOutput: prefs.buildOutput,
    smOutput: prefs.sourcemapOutput,
    smNonScripts: prefs.includeNonScripts,
    smAbsolute: prefs.absolutePaths
  }
  ui.portCheck = null
  schedulePortCheck()
  ui.inspection = null
  if (ui.tab === 'project') void inspect()
}

function connectHost(job: Job | null): string {
  return job?.host === '0.0.0.0' || (!job && ui.form.host === '0.0.0.0') ? '0.0.0.0' : 'localhost'
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const hours = Math.round(m / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
}

function uptime(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

// ---------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------

async function refresh() {
  const state = await call('refresh', () => orca.plugin.request('state.refresh', {}))
  if (state) applyState(state)
}

async function selectProject(path: string) {
  const state = await call('select', () => orca.plugin.request('project.select', { path }))
  if (state) {
    applyState(state)
    ui.form.forPath = null
    syncForm()
  }
}

async function toggleServe() {
  const job = serveJob()
  if (job && active(job)) {
    report(await call('serve', () => orca.plugin.request('job.stop', { id: job.id })))
    return
  }
  const path = projectPath()
  if (!path) return toast('danger', 'There is no project file to serve.')
  const port = Number(ui.form.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return toast('danger', 'The port must be a whole number from 1 to 65535.')
  const result = await call('serve', () => orca.plugin.request('serve.start', { path, host: ui.form.host, port }))
  if (result?.jobId) ui.jobView.serve = result.jobId
  report(result)
}

async function startOnPort(port: number) {
  ui.form.port = String(port)
  ui.portCheck = null
  await toggleServe()
}

async function stopJob(id: string) {
  report(await call(`stop:${id}`, () => orca.plugin.request('job.stop', { id })))
}

async function runBuild() {
  const path = projectPath()
  if (!path) return toast('danger', 'There is no project file to build.')
  const watching = jobsFor(['build-watch'], path).find(active)
  if (watching) return stopJob(watching.id)
  const result = await call('build', () => orca.plugin.request('build.run', { path, output: ui.form.buildOutput, watch: ui.form.buildWatch }))
  if (result?.jobId) ui.jobView.build = result.jobId
  report(result)
}

async function runSourcemap() {
  const path = projectPath()
  if (!path) return toast('danger', 'There is no project file.')
  const watching = jobsFor(['sourcemap-watch'], path).find(active)
  if (watching) return stopJob(watching.id)
  const result = await call('sourcemap', () =>
    orca.plugin.request('sourcemap.run', {
      path,
      output: ui.form.smOutput,
      includeNonScripts: ui.form.smNonScripts,
      absolute: ui.form.smAbsolute,
      watch: ui.form.smWatch
    })
  )
  if (result?.jobId) ui.jobView.build = result.jobId
  report(result)
}

async function inspect() {
  const path = selected()?.path
  if (!path || isRemote()) {
    ui.inspection = null
    return
  }
  ui.inspecting = true
  render()
  try {
    ui.inspection = await orca.plugin.request('project.inspect', { path })
    if (ui.inspection.tree && ui.expanded.size === 0) {
      // Open the first two levels on first sight.
      const open = (node: TreeNode, id: string, depth: number) => {
        if (depth < 2 && node.children?.length) {
          ui.expanded.add(id)
          node.children.forEach((c) => open(c, `${id}/${c.name}`, depth + 1))
        }
      }
      open(ui.inspection.tree, ui.inspection.tree.name, 0)
    }
  } catch (error) {
    toast('danger', error instanceof Error ? error.message : String(error))
  } finally {
    ui.inspecting = false
    render()
  }
}

async function openFile(path: string) {
  const result = await call('open', () => orca.plugin.request('project.open', { path }))
  if (result && !result.ok) toast('danger', result.message)
}

async function loadReleases(force = false) {
  ui.releasesLoading = true
  render()
  try {
    const { releases, error } = await orca.plugin.request('rojo.releases', { force }, { timeoutMs: 30000 })
    ui.releases = releases
    ui.releasesError = error
    if (!ui.pickTag || !releases.some((r) => r.tag === ui.pickTag)) {
      const latest = releases.find((r) => r.assetName && (!r.prerelease || ui.state?.settings.includePrereleases))
      ui.pickTag = latest?.tag ?? ''
    }
  } catch (error) {
    ui.releasesError = error instanceof Error ? error.message : String(error)
  } finally {
    ui.releasesLoading = false
    render()
  }
}

async function installRojo(tag: string) {
  if (!tag) return
  report(await call('install', () => orca.plugin.request('rojo.install', { tag })))
}

async function chooseRojo(path: string | null) {
  const state = await call('choose', () => orca.plugin.request('rojo.choose', { path }))
  if (state) applyState(state)
}

async function uninstallRojo(install: RojoInstall) {
  const state = await call(`uninstall:${install.path}`, () => orca.plugin.request('rojo.uninstall', { path: install.path }))
  if (state) {
    applyState(state)
    toast('success', `Removed Rojo ${install.version ?? ''}.`)
  }
}

async function detect() {
  const state = await call('detect', () => orca.plugin.request('rojo.detect', {}, { timeoutMs: 90000 }))
  if (state) applyState(state)
}

async function installStudioPlugin() {
  const result = await call('studio', () => orca.plugin.request('studio.install', {}))
  if (result?.jobId) {
    ui.jobView.build = result.jobId
    toast('neutral', 'Installing the Rojo plugin into Roblox Studio…')
  } else report(result)
}

async function saveRbxm() {
  if (!orca.files) return toast('danger', 'Saving files needs the Orca desktop app.')
  // The gesture expires after a few seconds, so fetch first, then ask on a second click if slow.
  const started = Date.now()
  const result = await call('rbxm', async () => {
    const parts: Uint8Array[] = []
    let total = Infinity
    let offset = 0
    let name = 'Rojo.rbxm'
    while (offset < total) {
      const chunk = await orca.plugin.request('studio.rbxm', { offset }, { timeoutMs: 60000 })
      if (chunk.error) throw new Error(chunk.error)
      total = chunk.total
      name = chunk.name
      const bin = atob(chunk.base64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      if (!bytes.length) break
      parts.push(bytes)
      offset += bytes.length
    }
    const data = new Uint8Array(offset)
    let at = 0
    for (const p of parts) {
      data.set(p, at)
      at += p.length
    }
    return { name, data }
  })
  if (!result) return
  if (Date.now() - started > 3500) {
    pendingRbxm = result
    toast('neutral', 'Rojo.rbxm is ready. Press "Save Rojo.rbxm" again to choose where to save it.')
    render()
    return
  }
  await saveBytes(result.name, result.data)
}

let pendingRbxm: { name: string; data: Uint8Array } | null = null

async function saveBytes(name: string, data: Uint8Array) {
  try {
    const out = await orca.files?.saveAs({ suggestedName: name, mimeType: 'application/octet-stream', data })
    if (out?.status === 'saved') toast('success', `Saved ${name}. Copy it into Roblox Studio's Plugins folder.`)
    pendingRbxm = null
  } catch (error) {
    toast('danger', error instanceof Error ? error.message : String(error))
  }
}

async function createProject() {
  const folder = ui.init.folder.trim()
  if (!folder) return toast('danger', 'Type a folder for the new project.')
  keep('initFolder', folder)
  const result = await call('init', () => orca.plugin.request('init.run', { folder, kind: ui.init.kind, git: ui.init.git }))
  if (result?.jobId) ui.jobView.build = result.jobId
  report(result)
}

let portTimer: ReturnType<typeof setTimeout> | null = null
function schedulePortCheck() {
  if (portTimer) clearTimeout(portTimer)
  if (isRemote()) return
  portTimer = setTimeout(async () => {
    const port = Number(ui.form.port)
    const host = ui.form.host
    if (!Number.isInteger(port) || port < 1 || port > 65535) return
    const job = serveJob()
    if (job && active(job)) return
    try {
      const result = await orca.plugin.request('port.check', { host, port })
      if (Number(ui.form.port) === port && ui.form.host === host) {
        ui.portCheck = { port, host, ...result }
        render()
      }
    } catch {
      /* ignore */
    }
  }, 350)
}

function savePrefs(prefs: Partial<ProjectPrefs>) {
  const path = selected()?.path
  if (path) void orca.plugin.request('prefs.set', { path, prefs }).catch(() => undefined)
}

// ---------------------------------------------------------------------------------------------
// Small view helpers
// ---------------------------------------------------------------------------------------------

function btn(
  label: string | null,
  onclick: () => unknown,
  opts: { icon?: string; cls?: string; title?: string; disabled?: boolean; busy?: boolean; kbd?: string; key?: string } = {}
): VElement {
  return h(
    'button',
    {
      type: 'button',
      class: `btn ${opts.cls ?? ''} ${opts.busy ? 'busy' : ''} ${label ? '' : 'icon-only'}`.replace(/\s+/g, ' ').trim(),
      title: opts.title ?? (label ? null : null),
      'aria-label': opts.title ?? label ?? undefined,
      disabled: opts.disabled || opts.busy || false,
      onclick: () => void onclick(),
      key: opts.key
    },
    opts.icon ? icon(opts.busy ? 'refresh' : opts.icon, 14) : null,
    label,
    opts.kbd ? h('span', { class: 'kbd' }, opts.kbd) : null
  )
}

function switchCtl(label: string, checked: boolean, onchange: (v: boolean) => void, detail?: string, disabled = false): VElement {
  return h(
    'label',
    { class: 'switch' },
    h('input', { type: 'checkbox', checked, disabled, onchange: (e: Event) => onchange((e.target as HTMLInputElement).checked) }),
    h('span', { class: 'track', 'aria-hidden': 'true' }),
    h('span', { class: 'text' }, label, detail ? h('small', null, detail) : null)
  )
}

function segmented<T extends string>(label: string, value: T, options: { value: T; label: string; icon?: string }[], onchange: (v: T) => void, disabled = false): VElement {
  return h(
    'div',
    { class: 'segmented', role: 'radiogroup', 'aria-label': label },
    options.map((o) =>
      h(
        'button',
        {
          type: 'button',
          role: 'radio',
          'aria-checked': String(o.value === value),
          disabled,
          key: o.value,
          onclick: () => onchange(o.value),
          onkeydown: (e: KeyboardEvent) => {
            if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
            e.preventDefault()
            const i = options.findIndex((x) => x.value === value)
            const next = options[(i + (e.key === 'ArrowRight' ? 1 : options.length - 1)) % options.length]
            onchange(next.value)
            requestAnimationFrame(() => (document.querySelector(`[aria-label="${label}"] [aria-checked="true"]`) as HTMLElement | null)?.focus())
          }
        },
        o.icon ? icon(o.icon, 13) : null,
        o.label
      )
    )
  )
}

function callout(tone: 'info' | 'warn' | 'danger' | 'ok', title: string | null, body: VNode | string | null, actions: VElement[] = [], key?: string): VElement {
  const ic = tone === 'danger' ? 'error' : tone === 'warn' ? 'alert' : tone === 'ok' ? 'check' : 'info'
  return h(
    'div',
    { class: `callout ${tone}`, role: tone === 'danger' ? 'alert' : 'note', key },
    icon(ic, 16),
    h('div', { class: 'grow' }, title ? h('div', { class: 'callout-title' }, title) : null, body, actions.length ? h('div', { class: 'actions' }, actions) : null)
  )
}

function empty(art: string, title: string, text: string, actions: VElement[] = []): VElement {
  return h(
    'div',
    { class: 'empty' },
    h('div', { class: 'art' }, icon(art, 24)),
    h('div', { class: 'empty-title' }, title),
    h('div', { class: 'empty-text' }, text),
    actions.length ? h('div', { class: 'actions' }, actions) : null
  )
}

function statusLabel(job: Job | null): string {
  if (!job) return 'Stopped'
  switch (job.status) {
    case 'starting':
      return 'Starting…'
    case 'running':
      return 'Running'
    case 'stopping':
      return 'Stopping…'
    case 'error':
      return 'Error'
    case 'done':
      return 'Done'
    default:
      return 'Stopped'
  }
}

// ---------------------------------------------------------------------------------------------
// Header and tabs
// ---------------------------------------------------------------------------------------------

function header(): VElement {
  const s = ui.state
  const rojo = s?.rojo.active
  const project = selected()
  const sub = !s
    ? 'Connecting…'
    : !s.workspace
      ? 'No workspace focused'
      : `${s.workspace.name}${project ? ` · ${project.rel}` : isRemote() ? ' · remote' : ''}`
  const chip = !s
    ? null
    : s.rojo.detecting && !rojo
      ? h('span', { class: 'chip' }, 'Looking for Rojo…')
      : rojo
        ? h(
            'button',
            { class: `chip ${s.rojo.updateAvailable ? 'info' : 'ok'}`, title: `${rojo.label}: ${rojo.path}`, onclick: () => setTab('setup') },
            icon(s.rojo.updateAvailable ? 'sparkle' : 'check', 12),
            h('strong', null, `Rojo ${rojo.version}`),
            s.rojo.updateAvailable ? ' · update' : null
          )
        : h('button', { class: 'chip warn', onclick: () => setTab('setup') }, icon('download', 12), 'Install Rojo')
  return h(
    'header',
    { class: 'header' },
    h('div', { class: 'brand', 'aria-hidden': 'true' }, icon('rocket', 17)),
    h('div', { class: 'header-text' }, h('div', { class: 'title' }, 'Rojo Studio'), h('div', { class: 'subtitle', title: sub }, sub)),
    chip,
    btn(null, () => refresh(), { icon: 'refresh', cls: 'ghost sm', title: 'Rescan workspace', busy: ui.busy.has('refresh') })
  )
}

function setTab(tab: Tab) {
  ui.tab = tab
  keep('tab', tab)
  if (tab === 'project' && !ui.inspection) void inspect()
  if (tab === 'setup' && !ui.releases && !ui.releasesLoading) void loadReleases()
  render()
}

function tabs(): VElement {
  const s = ui.state
  const running = (s?.jobs ?? []).some((j) => j.kind === 'serve' && j.status === 'running')
  const failed = (s?.jobs ?? []).some((j) => j.kind === 'serve' && j.status === 'error' && j.endedAt && Date.now() - j.endedAt < 300000)
  const errors = ui.inspection?.issues.filter((i) => i.severity === 'error').length ?? 0
  const setupFlag = s && (!s.rojo.active || s.rojo.updateAvailable)
  return h(
    'nav',
    { class: 'tabs', role: 'tablist', 'aria-label': 'Sections' },
    TABS.map((t, i) =>
      h(
        'button',
        {
          key: t.id,
          id: `tab-${t.id}`,
          class: 'tab',
          role: 'tab',
          'aria-selected': String(ui.tab === t.id),
          'aria-controls': 'tabpanel',
          tabindex: ui.tab === t.id ? 0 : -1,
          title: `${t.label} (Alt+${i + 1})`,
          onclick: () => setTab(t.id),
          onkeydown: (e: KeyboardEvent) => {
            if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return
            e.preventDefault()
            const idx = TABS.findIndex((x) => x.id === ui.tab)
            const next =
              e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : (idx + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length
            setTab(TABS[next].id)
            requestAnimationFrame(() => document.getElementById(`tab-${TABS[next].id}`)?.focus())
          }
        },
        icon(t.icon, 13),
        t.label,
        t.id === 'serve' && (running || failed) ? h('span', { class: `badge-dot ${running ? '' : 'danger'}` }) : null,
        t.id === 'project' && errors ? h('span', { class: 'count' }, String(errors)) : null,
        t.id === 'setup' && setupFlag ? h('span', { class: `badge-dot ${s?.rojo.active ? 'info' : 'danger'}` }) : null
      )
    )
  )
}

// ---------------------------------------------------------------------------------------------
// Project picker (shared by Serve and Build)
// ---------------------------------------------------------------------------------------------

function projectPicker(): VElement | null {
  const s = ui.state
  if (!s) return null
  if (isRemote()) {
    return h(
      'div',
      { class: 'card' },
      callout(
        'info',
        'Remote workspace',
        `This workspace is on ${s.workspace?.hostId ?? 'another host'}. Rojo runs in an Orca terminal there, using the rojo installed on that host.`
      ),
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'remote-project' }, 'Project file (relative to the workspace)'),
        h('input', {
          id: 'remote-project',
          class: 'input mono',
          value: ui.form.remoteProject,
          spellcheck: 'false',
          oninput: (e: Event) => (ui.form.remoteProject = (e.target as HTMLInputElement).value)
        })
      )
    )
  }
  if (!s.projects.length) return null
  const project = selected()
  const kindPill = project ? h('span', { class: 'pill' }, project.kind === 'place' ? 'Place' : project.kind === 'model' ? 'Model' : '?') : null
  if (s.projects.length === 1 && project) {
    return h(
      'div',
      { class: 'row', style: { padding: '0 2px' } },
      icon('file', 14, 'muted'),
      h('span', { class: 'mono ellipsis grow', title: project.path }, project.rel),
      kindPill,
      btn(null, () => openFile(project.path), { icon: 'external', cls: 'ghost sm', title: 'Open the project file in the editor' })
    )
  }
  return h(
    'div',
    { class: 'field' },
    h('label', { for: 'project-select' }, 'Project'),
    h(
      'div',
      { class: 'row' },
      h(
        'select',
        {
          id: 'project-select',
          class: 'select mono grow',
          value: s.selectedProject ?? '',
          onchange: (e: Event) => void selectProject((e.target as HTMLSelectElement).value)
        },
        s.projects.map((p) =>
          h('option', { value: p.path, key: p.path, selected: p.path === s.selectedProject }, `${p.rel}${p.name ? `  —  ${p.name}` : ''}`)
        )
      ),
      kindPill,
      project ? btn(null, () => openFile(project.path), { icon: 'external', cls: 'ghost sm', title: 'Open the project file in the editor' }) : null
    )
  )
}

function noWorkspace(): VElement | null {
  const s = ui.state
  if (!s) return h('div', { class: 'stack' }, h('div', { class: 'skeleton', style: { height: '120px' } }), h('div', { class: 'skeleton', style: { height: '200px' } }))
  if (!s.workspace)
    return empty('folder', 'No workspace focused', 'Open a folder or workspace that contains a Rojo project (a *.project.json file).', [
      btn('Rescan', () => refresh(), { icon: 'refresh' })
    ])
  if (!isRemote() && !s.projects.length)
    return empty('map', 'No Rojo project here', `${s.workspace.name} has no *.project.json file. Create a new project, or open a folder that has one.`, [
      btn('New project', () => {
        ui.newProjectOpen = true
        setTab('project')
      }, { icon: 'plus', cls: 'primary' }),
      btn('Rescan', () => refresh(), { icon: 'refresh' })
    ])
  return null
}

function rojoMissing(): VElement | null {
  const s = ui.state
  if (!s || s.rojo.active || isRemote() || s.rojo.detecting) return null
  return callout('warn', 'Rojo is not installed', 'Download the official release from GitHub in one click.', [
    btn('Open Setup', () => setTab('setup'), { icon: 'download', cls: 'primary' })
  ])
}

// ---------------------------------------------------------------------------------------------
// Serve tab
// ---------------------------------------------------------------------------------------------

function serveView(): VElement {
  const blocked = noWorkspace()
  if (blocked) return h('div', { class: 'view', key: 'serve' }, blocked)
  const s = ui.state as State
  const job = serveJob()
  const running = !!job && active(job)
  const status = job ? job.status : 'stopped'
  const host = running && job ? connectHost(job) : ui.form.host === '0.0.0.0' ? '0.0.0.0' : 'localhost'
  const port = running && job?.port ? job.port : Number(ui.form.port) || 34872
  const address = `localhost:${port}`
  const remote = isRemote()
  const others = (s.jobs ?? []).filter((j) => active(j) && j.id !== job?.id)

  const portHint =
    !running && ui.portCheck && !ui.portCheck.free && ui.portCheck.port === Number(ui.form.port)
      ? callout(
          'warn',
          `Port ${ui.portCheck.port} is in use`,
          ui.portCheck.holder ? `It is held by ${ui.portCheck.holder}.` : 'Another program is listening on it.',
          ui.portCheck.suggestion
            ? [btn(`Use port ${ui.portCheck.suggestion}`, () => {
                ui.form.port = String(ui.portCheck?.suggestion)
                ui.portCheck = null
                schedulePortCheck()
                render()
              }, { icon: 'check' })]
            : [],
          'port-hint'
        )
      : null

  const errorBox =
    job?.status === 'error'
      ? callout(
          'danger',
          'The server stopped',
          job.message ?? 'Rojo exited with an error. See the output below.',
          [
            ...(job.suggestedPort ? [btn(`Start on port ${job.suggestedPort}`, () => startOnPort(job.suggestedPort as number), { icon: 'play', cls: 'go' })] : []),
            btn('Dismiss', async () => {
              const state = await orca.plugin.request('job.dismiss', { id: job.id })
              applyState(state)
            }, { cls: 'ghost' })
          ],
          'serve-error'
        )
      : null

  const meta = running && job
    ? h(
        'div',
        { class: 'row wrap' },
        job.status === 'running' ? h('span', { class: 'status-meta' }, `Up ${uptime(job.startedAt)}`) : null,
        job.status === 'running' && job.runner === 'process'
          ? job.clients
            ? h('span', { class: 'chip ok' }, icon('plug', 12), job.clients === 1 ? 'Studio connected' : `${job.clients} hosts connected`)
            : h('span', { class: 'chip' }, icon('wifi', 12), 'Waiting for Studio')
          : null,
        job.runner === 'terminal' ? h('span', { class: 'chip' }, icon('terminal', 12), 'In an Orca terminal') : null
      )
    : job?.status === 'error'
      ? h('span', { class: 'status-meta' }, `Stopped ${ago(job.endedAt ?? job.startedAt)}`)
      : h('span', { class: 'status-meta' }, remote ? 'Runs in an Orca terminal on the remote host.' : 'Start a server, then press Connect in the Rojo plugin in Roblox Studio.')

  const addresses =
    host === '0.0.0.0'
      ? [address, ...s.platform.lanAddresses.map((ip) => `${ip}:${port}`)]
      : [address]

  const hero = h(
    'section',
    { class: 'card hero elevated', 'data-status': status, 'aria-label': 'Server' },
    h(
      'div',
      { class: 'status-line' },
      h('span', { class: 'dot', 'aria-hidden': 'true' }),
      h('div', { class: 'grow' }, h('div', { class: 'status-text' }, statusLabel(job && (active(job) || job.status === 'error') ? job : null)), meta),
      btn(running ? 'Stop' : 'Start server', () => toggleServe(), {
        icon: running ? 'stop' : 'play',
        cls: `lg ${running ? 'danger' : 'go'}`,
        busy: ui.busy.has('serve') || job?.status === 'stopping',
        disabled: !running && !remote && !s.rojo.active,
        title: `${running ? 'Stop' : 'Start'} the server (${MOD}+Enter)`
      })
    ),
    h(
      'div',
      { class: 'stack', style: { gap: '6px' } },
      addresses.map((a, i) =>
        h(
          'div',
          { class: 'address', key: a },
          h(
            'div',
            { class: 'grow' },
            h('div', { class: 'label' }, i === 0 ? (host === '0.0.0.0' ? 'This computer' : 'Connect Studio to') : 'From your network'),
            h('div', { class: 'mono ellipsis' }, a)
          ),
          btn(null, () => copy(a, 'Copied address'), { icon: 'copy', cls: 'ghost sm', title: `Copy ${a}` })
        )
      )
    ),
    h('div', { class: 'sep' }),
    h(
      'div',
      { class: 'grid2' },
      h(
        'div',
        { class: 'field' },
        h('span', { class: 'field-label' }, 'Listen on'),
        segmented(
          'Listen on',
          ui.form.host,
          [
            { value: 'localhost', label: 'This computer', icon: 'laptop' },
            { value: '0.0.0.0', label: 'Network', icon: 'globe' }
          ],
          (v) => {
            ui.form.host = v
            savePrefs({ host: v })
            schedulePortCheck()
            render()
          },
          running
        )
      ),
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'port' }, 'Port'),
        h('input', {
          id: 'port',
          class: `input mono ${ui.portCheck && !ui.portCheck.free && !running ? 'invalid' : ''}`,
          inputmode: 'numeric',
          value: running && job?.port ? String(job.port) : ui.form.port,
          disabled: running,
          'aria-invalid': String(!!(ui.portCheck && !ui.portCheck.free)),
          oninput: (e: Event) => {
            ui.form.port = (e.target as HTMLInputElement).value.replace(/[^\d]/g, '').slice(0, 5)
            ui.portCheck = null
            schedulePortCheck()
          },
          onchange: () => {
            const p = Number(ui.form.port)
            if (Number.isInteger(p) && p > 0 && p < 65536) savePrefs({ port: p })
          }
        })
      )
    ),
    ui.form.host === '0.0.0.0' && !running
      ? h('div', { class: 'hint' }, icon('alert', 12), ' Anyone on your network can reach this server and read your project. Use it for Studio in a VM or on another computer.')
      : null
  )

  const logJob = ui.jobView.serve && s.jobs.some((j) => j.id === ui.jobView.serve) ? ui.jobView.serve : job?.id ?? null

  return h(
    'div',
    { class: 'view', key: 'serve' },
    rojoMissing(),
    projectPicker(),
    errorBox,
    hero,
    portHint,
    logCard(logs.serve, logJob, 'Server output'),
    others.length ? activity(others, 'Also running') : null,
    h(
      'div',
      { class: 'footer-hint' },
      h('span', null, h('kbd', null, `${MOD}+Enter`), ' start / stop'),
      h('span', null, h('kbd', null, 'Alt+1–4'), ' switch tabs'),
      h('span', null, h('kbd', null, '/'), ' filter output')
    )
  )
}

function logCard(view: LogView, jobId: string | null, title: string): VElement {
  const job = jobId ? ui.state?.jobs.find((j) => j.id === jobId) ?? null : null
  view.show(jobId, job)
  return h(
    'section',
    { class: 'card log-card', 'aria-label': title, key: `log-${view.id}` },
    h(
      'div',
      { class: 'log-toolbar' },
      h('div', { class: 'card-title grow ellipsis', title: job?.command ?? '' }, job ? job.title : title),
      h('input', {
        class: 'input',
        type: 'search',
        placeholder: 'Filter',
        'aria-label': 'Filter output',
        'data-log-filter': view.id,
        value: view.filter,
        oninput: (e: Event) => view.setFilter((e.target as HTMLInputElement).value)
      }),
      job ? btn(null, () => copy(job.command, 'Copied command'), { icon: 'terminal', cls: 'ghost sm', title: 'Copy the command line' }) : null,
      btn(null, () => copy(view.text() || ' ', 'Copied output'), { icon: 'copy', cls: 'ghost sm', title: 'Copy the output', disabled: !job })
    ),
    raw(view.el, `raw-${view.id}`)
  )
}

function activity(jobs: Job[], label: string): VElement {
  return h(
    'div',
    { class: 'stack', key: `activity-${label}` },
    h('div', { class: 'section-label' }, label, h('span', null, String(jobs.length))),
    h(
      'div',
      { class: 'list', role: 'list' },
      jobs.map((j) =>
        h(
          'div',
          { class: 'item job clickable', 'data-status': j.status, key: j.id, role: 'listitem', tabindex: 0, onclick: () => showJob(j), onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && showJob(j) },
          h('span', { class: 'dot', 'aria-hidden': 'true' }),
          h(
            'div',
            { class: 'grow' },
            h('div', { class: 'item-title ellipsis' }, j.title),
            h('div', { class: 'item-sub ellipsis' }, [statusLabel(j), j.port ? `:${j.port}` : null, j.message, ago(j.startedAt)].filter(Boolean).join(' · '))
          ),
          active(j)
            ? h('div', { class: 'actions' }, btn(null, () => stopJob(j.id), { icon: 'stop', cls: 'ghost sm', title: `Stop ${j.title}`, busy: ui.busy.has(`stop:${j.id}`) }))
            : null
        )
      )
    )
  )
}

function showJob(job: Job) {
  if (job.kind === 'serve') {
    ui.jobView.serve = job.id
    setTab('serve')
  } else {
    ui.jobView.build = job.id
    setTab('build')
  }
}

// ---------------------------------------------------------------------------------------------
// Build tab
// ---------------------------------------------------------------------------------------------

function buildView(): VElement {
  const blocked = noWorkspace()
  if (blocked) return h('div', { class: 'view', key: 'build' }, blocked)
  const s = ui.state as State
  const project = selected()
  const path = projectPath()
  const kind = project?.kind ?? 'unknown'
  const watchBuild = jobsFor(['build-watch'], path).find(active)
  const watchMap = jobsFor(['sourcemap-watch'], path).find(active)
  const lastBuild = jobsFor(['build', 'build-watch'], path)[0] ?? null
  const lastMap = jobsFor(['sourcemap', 'sourcemap-watch'], path)[0] ?? null
  const ext = (/\.(rbxlx?|rbxmx?)$/i.exec(ui.form.buildOutput)?.[1] ?? '').toLowerCase()
  const formats = kind === 'model' ? ['rbxm', 'rbxmx'] : kind === 'place' ? ['rbxl', 'rbxlx'] : ['rbxl', 'rbxlx', 'rbxm', 'rbxmx']
  const setFormat = (f: string) => {
    ui.form.buildOutput = /\.(rbxlx?|rbxmx?)$/i.test(ui.form.buildOutput) ? ui.form.buildOutput.replace(/\.(rbxlx?|rbxmx?)$/i, `.${f}`) : `${ui.form.buildOutput || 'build/project'}.${f}`
    render()
  }
  const noRojo = !s.rojo.active && !isRemote()

  const result = (job: Job | null) =>
    job
      ? h(
          'div',
          { class: 'item job', 'data-status': job.status, key: job.id, style: { padding: '8px 10px', border: '1px solid var(--hairline)', 'border-radius': 'var(--radius)' } },
          h('span', { class: 'dot', 'aria-hidden': 'true' }),
          h(
            'div',
            { class: 'grow' },
            h('div', { class: 'item-title ellipsis' }, job.status === 'done' ? job.message ?? 'Done' : `${statusLabel(job)}${job.message ? ` · ${job.message}` : ''}`),
            h('div', { class: 'item-sub ellipsis mono', title: job.output }, `${job.output ?? ''} · ${ago(job.startedAt)}`)
          ),
          job.output ? btn(null, () => copy(job.output as string, 'Copied path'), { icon: 'copy', cls: 'ghost sm', title: 'Copy the output path' }) : null,
          btn(null, () => showJob(job), { icon: 'eye', cls: 'ghost sm', title: 'Show its output' })
        )
      : null

  const buildCard = h(
    'section',
    { class: 'card elevated', 'aria-label': 'Build' },
    h(
      'div',
      { class: 'card-head' },
      h('div', { class: 'item-icon' }, icon('box', 16)),
      h('div', { class: 'grow' }, h('div', { class: 'card-title' }, 'Build'), h('div', { class: 'card-sub' }, kind === 'model' ? 'A model file (.rbxm) for the toolbox or a package.' : 'A place file (.rbxl) you can open in Studio.'))
    ),
    segmented('Output format', ext as string, formats.map((f) => ({ value: f, label: `.${f}` })), setFormat, !!watchBuild),
    h(
      'div',
      { class: 'field' },
      h('label', { for: 'build-output' }, 'Output file (relative to the project)'),
      h('input', {
        id: 'build-output',
        class: 'input mono',
        value: ui.form.buildOutput,
        spellcheck: 'false',
        disabled: !!watchBuild,
        oninput: (e: Event) => (ui.form.buildOutput = (e.target as HTMLInputElement).value)
      })
    ),
    switchCtl('Rebuild on every change', ui.form.buildWatch || !!watchBuild, (v) => {
      ui.form.buildWatch = v
      render()
    }, 'rojo build --watch', !!watchBuild),
    h(
      'div',
      { class: 'row end' },
      btn(watchBuild ? 'Stop watching' : ui.form.buildWatch ? 'Start watch build' : 'Build', () => runBuild(), {
        icon: watchBuild ? 'stop' : 'hammer',
        cls: watchBuild ? 'danger' : 'primary',
        busy: ui.busy.has('build'),
        disabled: noRojo,
        title: `Build (${MOD}+Enter)`
      })
    ),
    result(lastBuild)
  )

  const mapCard = h(
    'section',
    { class: 'card', 'aria-label': 'Sourcemap' },
    h(
      'div',
      { class: 'card-head' },
      h('div', { class: 'item-icon' }, icon('map', 16)),
      h('div', { class: 'grow' }, h('div', { class: 'card-title' }, 'Sourcemap'), h('div', { class: 'card-sub' }, 'sourcemap.json lets luau-lsp resolve requires and instance paths.'))
    ),
    h(
      'div',
      { class: 'field' },
      h('label', { for: 'sm-output' }, 'Sourcemap file'),
      h('input', { id: 'sm-output', class: 'input mono', value: ui.form.smOutput, spellcheck: 'false', disabled: !!watchMap, oninput: (e: Event) => (ui.form.smOutput = (e.target as HTMLInputElement).value) })
    ),
    switchCtl('Include non-script instances', ui.form.smNonScripts, (v) => ((ui.form.smNonScripts = v), render()), '--include-non-scripts', !!watchMap),
    switchCtl('Absolute paths', ui.form.smAbsolute, (v) => ((ui.form.smAbsolute = v), render()), '--absolute', !!watchMap),
    switchCtl('Keep it up to date', ui.form.smWatch || !!watchMap, (v) => ((ui.form.smWatch = v), render()), 'rojo sourcemap --watch', !!watchMap),
    h(
      'div',
      { class: 'row end' },
      btn(watchMap ? 'Stop watching' : ui.form.smWatch ? 'Start watching' : 'Generate', () => runSourcemap(), {
        icon: watchMap ? 'stop' : 'map',
        cls: watchMap ? 'danger' : '',
        busy: ui.busy.has('sourcemap'),
        disabled: noRojo
      })
    ),
    result(lastMap)
  )

  const logJob = ui.jobView.build && s.jobs.some((j) => j.id === ui.jobView.build) ? ui.jobView.build : (lastBuild ?? lastMap)?.id ?? null
  return h('div', { class: 'view', key: 'build' }, rojoMissing(), projectPicker(), buildCard, mapCard, logCard(logs.build, logJob, 'Output'))
}

// ---------------------------------------------------------------------------------------------
// Project tab
// ---------------------------------------------------------------------------------------------

function flatten(node: TreeNode, id: string, depth: number, out: { node: TreeNode; id: string; depth: number }[]) {
  out.push({ node, id, depth })
  if (node.children?.length && ui.expanded.has(id)) for (const c of node.children) flatten(c, `${id}/${c.name}`, depth + 1, out)
}

function kindIcon(kind: TreeNode['kind']): string {
  switch (kind) {
    case 'datamodel':
      return 'globe'
    case 'service':
      return 'service'
    case 'folder':
      return 'folder'
    case 'script':
    case 'localscript':
      return 'script'
    case 'module':
      return 'module'
    case 'value':
      return 'value'
    case 'project':
      return 'layers'
    default:
      return 'cube'
  }
}

function toggleNode(id: string, open?: boolean) {
  const now = open ?? !ui.expanded.has(id)
  if (now) ui.expanded.add(id)
  else ui.expanded.delete(id)
  keep('expanded', [...ui.expanded].slice(0, 400))
  render()
}

function setAll(open: boolean) {
  const tree = ui.inspection?.tree
  if (!tree) return
  if (!open) ui.expanded.clear()
  else {
    const walk = (n: TreeNode, id: string) => {
      if (n.children?.length) {
        ui.expanded.add(id)
        n.children.forEach((c) => walk(c, `${id}/${c.name}`))
      }
    }
    walk(tree, tree.name)
  }
  keep('expanded', [...ui.expanded].slice(0, 400))
  render()
}

function treeView(tree: TreeNode): VElement {
  const rows: { node: TreeNode; id: string; depth: number }[] = []
  flatten(tree, tree.name, 0, rows)
  const focusId = ui.treeFocus && rows.some((r) => r.id === ui.treeFocus) ? ui.treeFocus : rows[0]?.id
  const onKey = (e: KeyboardEvent) => {
    const i = rows.findIndex((r) => r.id === focusId)
    if (i < 0) return
    const r = rows[i]
    let next: string | null = null
    if (e.key === 'ArrowDown') next = rows[Math.min(rows.length - 1, i + 1)].id
    else if (e.key === 'ArrowUp') next = rows[Math.max(0, i - 1)].id
    else if (e.key === 'Home') next = rows[0].id
    else if (e.key === 'End') next = rows[rows.length - 1].id
    else if (e.key === 'ArrowRight') {
      if (r.node.children?.length && !ui.expanded.has(r.id)) toggleNode(r.id, true)
      else if (r.node.children?.length) next = rows[i + 1]?.id ?? null
    } else if (e.key === 'ArrowLeft') {
      if (ui.expanded.has(r.id)) toggleNode(r.id, false)
      else next = r.id.includes('/') ? r.id.slice(0, r.id.lastIndexOf('/')) : null
    } else if (e.key === 'Enter' && r.node.source && !r.node.missing) {
      const dir = (ui.inspection?.path ?? '').replace(/[\\/][^\\/]*$/, '')
      void openFile(r.node.source.startsWith('/') || /^[A-Za-z]:/.test(r.node.source) ? r.node.source : `${dir}/${r.node.source}`)
    } else return
    e.preventDefault()
    if (next) {
      ui.treeFocus = next
      render()
      requestAnimationFrame(() => (document.querySelector(`[data-tree-id="${CSS.escape(next as string)}"]`) as HTMLElement | null)?.focus())
    }
  }
  return h(
    'div',
    { class: 'tree-wrap', role: 'tree', 'aria-label': 'Instance tree', onkeydown: onKey },
    rows.map(({ node, id, depth }) => {
      const hasKids = !!node.children?.length
      const open = ui.expanded.has(id)
      return h(
        'div',
        {
          key: id,
          class: `tree-row ${focusId === id ? 'focused' : ''}`,
          role: 'treeitem',
          'aria-level': depth + 1,
          'aria-expanded': hasKids ? String(open) : undefined,
          'data-tree-id': id,
          tabindex: focusId === id ? 0 : -1,
          style: { 'padding-left': `${6 + depth * 16}px` },
          onclick: () => {
            ui.treeFocus = id
            if (hasKids) toggleNode(id)
            else render()
          },
          title: `${node.name} (${node.className})${node.source ? ` ← ${node.source}` : ''}`
        },
        Array.from({ length: depth }, (_, d) => h('span', { class: 'tree-guide', style: { left: `${14 + d * 16}px` }, key: `g${d}` })),
        h('span', { class: `caret ${open ? 'open' : ''} ${hasKids ? '' : 'leaf'}` }, icon('chevron', 12)),
        h('span', { class: `kind kind-${node.kind}` }, icon(kindIcon(node.kind), 14)),
        h('span', { class: 'tree-name' }, node.name),
        h('span', { class: 'tree-class' }, node.className),
        node.props ? h('span', { class: 'pill', title: `${node.props} properties / attributes` }, `${node.props} prop${node.props === 1 ? '' : 's'}`) : null,
        node.truncated ? h('span', { class: 'pill', title: 'Not all children are shown' }, '…') : null,
        node.source && (node.mapped || node.missing)
          ? h('span', { class: `tree-src ${node.missing ? 'missing' : 'mapped'}` }, node.source)
          : null
      )
    })
  )
}

function issueRow(issue: Issue, i: number): VElement {
  const ic = issue.severity === 'error' ? 'error' : issue.severity === 'warning' ? 'alert' : 'info'
  return h(
    'div',
    { class: `issue ${issue.severity}`, key: `i${i}` },
    icon(ic, 15),
    h(
      'div',
      { class: 'grow' },
      h('div', null, issue.message),
      issue.where ? h('div', { class: 'where' }, issue.where) : null,
      issue.hint ? h('div', { class: 'fix' }, issue.hint) : null
    )
  )
}

function newProjectCard(): VElement {
  const s = ui.state
  const base = s?.workspace?.path ?? '~'
  const kinds = [
    { value: 'place' as const, label: 'Place', icon: 'cube', text: 'A game: services, server and client scripts.' },
    { value: 'model' as const, label: 'Model', icon: 'box', text: 'A library or package built to .rbxm.' },
    { value: 'plugin' as const, label: 'Plugin', icon: 'plug', text: 'A Roblox Studio plugin.' }
  ]
  const desc = kinds.find((k) => k.value === ui.init.kind)?.text ?? ''
  return h(
    'section',
    { class: 'card elevated', 'aria-label': 'New project', key: 'new-project' },
    h(
      'div',
      { class: 'card-head' },
      h('div', { class: 'item-icon' }, icon('sparkle', 16)),
      h('div', { class: 'grow' }, h('div', { class: 'card-title' }, 'New project'), h('div', { class: 'card-sub' }, 'rojo init with a starter template')),
      s?.projects.length ? btn(null, () => ((ui.newProjectOpen = false), render()), { icon: 'x', cls: 'ghost sm', title: 'Close' }) : null
    ),
    segmented('Template', ui.init.kind, kinds, (v) => ((ui.init.kind = v), render())),
    h('div', { class: 'hint' }, desc),
    h(
      'div',
      { class: 'field' },
      h('label', { for: 'init-folder' }, 'Folder'),
      h('input', {
        id: 'init-folder',
        class: 'input mono',
        placeholder: `my-${ui.init.kind}`,
        value: ui.init.folder,
        spellcheck: 'false',
        oninput: (e: Event) => (ui.init.folder = (e.target as HTMLInputElement).value),
        onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && void createProject()
      }),
      h('div', { class: 'hint' }, `Relative to ${base}, or an absolute path. Rojo creates the folder.`)
    ),
    switchCtl('Initialize a Git repository', ui.init.git, (v) => ((ui.init.git = v), render()), 'Needs git on this machine; skipped otherwise.'),
    h('div', { class: 'row end' }, btn('Create project', () => createProject(), { icon: 'plus', cls: 'primary', busy: ui.busy.has('init'), disabled: !s?.rojo.active && !isRemote() }))
  )
}

function recentList(): VElement | null {
  const s = ui.state
  if (!s?.recent.length) return null
  return h(
    'div',
    { class: 'stack', key: 'recent' },
    h('div', { class: 'section-label' }, 'Recent projects'),
    h(
      'div',
      { class: 'list' },
      s.recent.map((r) =>
        h(
          'div',
          {
            class: `item clickable ${r.path === s.selectedProject ? 'selected' : ''}`,
            key: r.path,
            tabindex: 0,
            role: 'button',
            onclick: () => selectProject(r.path),
            onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && void selectProject(r.path)
          },
          h('div', { class: 'item-icon' }, icon('file', 14)),
          h('div', { class: 'grow' }, h('div', { class: 'item-title ellipsis' }, r.name ?? r.path.split(/[\\/]/).slice(-2).join('/')), h('div', { class: 'item-sub ellipsis mono', title: r.path }, `${r.workspace ?? ''}${r.workspace ? ' · ' : ''}${ago(r.at)}`)),
          h('div', { class: 'actions' }, btn(null, async () => applyState(await orca.plugin.request('recent.remove', { path: r.path })), { icon: 'x', cls: 'ghost sm', title: 'Remove from recent' }))
        )
      )
    )
  )
}

function projectView(): VElement {
  const s = ui.state
  if (!s) return h('div', { class: 'view', key: 'project' }, noWorkspace())
  const project = selected()
  const parts: (VElement | null)[] = []
  if (isRemote()) {
    parts.push(callout('info', 'Remote workspace', 'The project tree and checks need the files on this computer. Serve and Build still work through an Orca terminal.'))
    parts.push(newProjectCard())
  } else if (!project) {
    parts.push(noWorkspace() ?? null)
    if (s.workspace) parts.push(newProjectCard())
  } else {
    parts.push(projectPicker())
    const ins = ui.inspection
    if (!ins || ui.inspecting) parts.push(h('div', { class: 'stack', key: 'loading' }, h('div', { class: 'skeleton', style: { height: '58px' } }), h('div', { class: 'skeleton', style: { height: '240px' } })))
    else {
      const errors = ins.issues.filter((i) => i.severity === 'error').length
      const warnings = ins.issues.filter((i) => i.severity === 'warning').length
      parts.push(
        h(
          'div',
          { class: 'stats', key: 'stats' },
          h('div', { class: 'stat' }, h('div', { class: 'n' }, String(ins.stats.instances)), h('div', { class: 'l' }, 'Instances')),
          h('div', { class: 'stat' }, h('div', { class: 'n' }, String(ins.stats.scripts)), h('div', { class: 'l' }, 'Scripts')),
          h('div', { class: 'stat' }, h('div', { class: 'n' }, String(ins.stats.mapped)), h('div', { class: 'l' }, '$path')),
          h('div', { class: `stat ${ins.stats.missing ? 'bad' : ''}` }, h('div', { class: 'n' }, String(ins.stats.missing)), h('div', { class: 'l' }, 'Missing'))
        )
      )
      parts.push(
        ins.issues.length
          ? h(
              'section',
              { class: 'card', style: { padding: '0', gap: '0' }, key: 'issues', 'aria-label': 'Problems' },
              h(
                'div',
                { class: 'log-toolbar' },
                h('div', { class: 'card-title grow' }, 'Problems'),
                errors ? h('span', { class: 'chip danger' }, `${errors} error${errors === 1 ? '' : 's'}`) : null,
                warnings ? h('span', { class: 'chip warn' }, `${warnings} warning${warnings === 1 ? '' : 's'}`) : null
              ),
              ins.issues.map(issueRow)
            )
          : callout('ok', 'No problems found', `${ins.name ?? 'The project'} is a valid ${ins.kind === 'place' ? 'place' : 'model'} project.`, [], 'ok')
      )
      parts.push(
        h(
          'div',
          { class: 'section-label', key: 'tree-label' },
          'Instance tree',
          h(
            'span',
            { class: 'row', style: { gap: '2px' } },
            btn(null, () => setAll(true), { icon: 'plus', cls: 'ghost sm', title: 'Expand all' }),
            btn(null, () => setAll(false), { icon: 'minus', cls: 'ghost sm', title: 'Collapse all' }),
            btn(null, () => inspect(), { icon: 'refresh', cls: 'ghost sm', title: 'Check again', busy: ui.inspecting })
          )
        )
      )
      parts.push(ins.tree ? treeView(ins.tree) : empty('tree', 'Nothing to show', 'Fix the problems above to see the instance tree.'))
      parts.push(h('div', { class: 'hint', key: 'tree-hint' }, 'Arrow keys move, Enter opens the source file. Blue paths are $path mappings.'))
    }
    parts.push(ui.newProjectOpen ? newProjectCard() : h('div', { class: 'row', key: 'np' }, btn('New project', () => ((ui.newProjectOpen = true), render()), { icon: 'plus', cls: 'ghost' })))
  }
  parts.push(recentList())
  return h('div', { class: 'view', key: 'project' }, parts)
}

// ---------------------------------------------------------------------------------------------
// Setup tab
// ---------------------------------------------------------------------------------------------

function updateCallout(s: State, latest: ReleaseInfo, installing: boolean): VElement {
  const rojo = s.rojo.active
  const have = s.rojo.installs.find((i) => i.source === 'managed' && i.version === latest.version)
  const pinned = rojo && (rojo.source === 'rokit' || rojo.source === 'aftman' || rojo.source === 'foreman')
  const text = have
    ? `It is already installed here. ${pinned ? `Your project pins ${rojo?.version} through ${rojo?.label}; switching overrides the pin for this plugin only.` : 'Switch to it with one click.'}`
    : pinned
      ? `Your project pins ${rojo?.version} through ${rojo?.label}. Installing adds a plugin-managed copy and selects it; to update the pin, edit ${s.toolchain?.file ?? 'the toolchain file'}.`
      : 'Install it next to your current version; you can switch back any time.'
  return callout(
    'info',
    `Rojo ${latest.version} is available`,
    text,
    [
      have
        ? btn(`Use ${latest.version}`, () => chooseRojo(have.path), { icon: 'check', cls: 'primary', busy: ui.busy.has('choose') })
        : btn(`Install ${latest.version}`, () => installRojo(latest.tag), { icon: 'download', cls: 'primary', busy: installing }),
      btn('Release notes', () => void orca.shell?.openExternal(latest.url), { icon: 'external', cls: 'ghost' })
    ],
    'update'
  )
}

function setupView(): VElement {
  const s = ui.state
  if (!s) return h('div', { class: 'view', key: 'setup' }, noWorkspace())
  const rojo = s.rojo.active
  const install = s.install
  const installing = !!install && install.phase !== 'error' && install.phase !== 'done'
  const pct = install && install.total ? Math.min(100, Math.round((install.received / install.total) * 100)) : 0
  const latest = s.rojo.latest
  const releaseOptions = (ui.releases ?? []).filter((r) => r.assetName && (s.settings.includePrereleases || !r.prerelease || r.tag === ui.pickTag))

  const activeCard = h(
    'section',
    { class: 'card elevated hero', 'data-status': rojo ? 'running' : 'error', 'aria-label': 'Rojo' },
    h(
      'div',
      { class: 'status-line' },
      h('span', { class: 'dot', 'aria-hidden': 'true' }),
      h(
        'div',
        { class: 'grow' },
        h('div', { class: 'status-text' }, rojo ? `Rojo ${rojo.version}` : s.rojo.detecting ? 'Looking for Rojo…' : 'Rojo not found'),
        h('div', { class: 'status-meta ellipsis', title: rojo?.path }, rojo ? `${rojo.label} · ${rojo.path}` : 'Install it below, or set "Path to rojo" in the plugin settings.')
      ),
      btn(null, () => detect(), { icon: 'refresh', cls: 'ghost sm', title: 'Look for Rojo again', busy: ui.busy.has('detect') || s.rojo.detecting })
    ),
    s.toolchain
      ? h('div', { class: 'hint' }, icon('info', 12), ` ${s.toolchain.file} pins ${s.toolchain.spec}${s.rojo.installs.some((i) => i.source === s.toolchain?.manager) ? `, so the ${s.toolchain.manager} shim is used by default.` : `, but no ${s.toolchain.manager} shim was found.`}`)
      : null,
    s.rojo.updateAvailable && latest ? updateCallout(s, latest, installing) : null
  )

  const installsList = h(
    'div',
    { class: 'stack' },
    h('div', { class: 'section-label' }, 'Installations', h('span', null, String(s.rojo.installs.length))),
    s.rojo.installs.length
      ? h(
          'div',
          { class: 'list', role: 'radiogroup', 'aria-label': 'Rojo to use' },
          [
            h(
              'div',
              { class: `item clickable ${s.rojo.chosen === null ? 'selected' : ''}`, key: 'auto', role: 'radio', 'aria-checked': String(s.rojo.chosen === null), tabindex: 0, onclick: () => chooseRojo(null), onkeydown: (e: KeyboardEvent) => (e.key === 'Enter' || e.key === ' ') && void chooseRojo(null) },
              h('span', { class: `radio-mark ${s.rojo.chosen === null ? 'on' : ''}` }),
              h('div', { class: 'grow' }, h('div', { class: 'item-title' }, 'Automatic'), h('div', { class: 'item-sub' }, 'Project pin, then PATH, then the newest version installed here.'))
            ),
            ...s.rojo.installs.map((i) => {
              const on = s.rojo.chosen === i.path
              return h(
                'div',
                {
                  class: `item clickable ${on ? 'selected' : ''}`,
                  key: i.path,
                  role: 'radio',
                  'aria-checked': String(on),
                  'aria-disabled': String(!i.version),
                  tabindex: 0,
                  onclick: () => i.version && chooseRojo(i.path),
                  onkeydown: (e: KeyboardEvent) => (e.key === 'Enter' || e.key === ' ') && i.version && void chooseRojo(i.path)
                },
                h('span', { class: `radio-mark ${on ? 'on' : ''}` }),
                h(
                  'div',
                  { class: 'grow' },
                  h('div', { class: 'item-title row', style: { gap: '6px' } }, i.version ? `Rojo ${i.version}` : 'Unusable', h('span', { class: 'pill' }, i.label), rojo?.path === i.path ? h('span', { class: 'chip ok', style: { height: '18px' } }, 'in use') : null),
                  h('div', { class: 'item-sub ellipsis mono', title: i.path }, i.path),
                  i.note ? h('div', { class: 'item-sub' }, i.note) : null
                ),
                i.source === 'managed'
                  ? h('div', { class: 'actions' }, btn(null, () => uninstallRojo(i), { icon: 'trash', cls: 'ghost sm', title: `Remove Rojo ${i.version}`, busy: ui.busy.has(`uninstall:${i.path}`) }))
                  : null
              )
            })
          ]
        )
      : s.rojo.detecting
        ? h('div', { class: 'skeleton', style: { height: '54px' } })
        : empty('search', 'No Rojo found', 'Not on PATH, not in Rokit, Aftman or Foreman, and not installed by this plugin yet.')
  )

  const downloadCard = h(
    'section',
    { class: 'card', 'aria-label': 'Download Rojo' },
    h(
      'div',
      { class: 'card-head' },
      h('div', { class: 'item-icon' }, icon('download', 16)),
      h(
        'div',
        { class: 'grow' },
        h('div', { class: 'card-title' }, 'Download Rojo'),
        h('div', { class: 'card-sub' }, `Official builds from github.com/rojo-rbx/rojo for ${s.platform.os} ${s.platform.arch}, checked against GitHub's SHA-256.`)
      ),
      btn(null, () => loadReleases(true), { icon: 'refresh', cls: 'ghost sm', title: 'Reload the release list', busy: ui.releasesLoading })
    ),
    ui.releasesError ? callout('warn', 'Could not reach GitHub', ui.releasesError, [], 'rel-error') : null,
    h(
      'div',
      { class: 'row' },
      h(
        'select',
        {
          class: 'select grow',
          'aria-label': 'Version',
          disabled: installing || !releaseOptions.length,
          value: ui.pickTag,
          onchange: (e: Event) => ((ui.pickTag = (e.target as HTMLSelectElement).value), render())
        },
        releaseOptions.length
          ? releaseOptions.map((r, i) =>
              h(
                'option',
                { value: r.tag, key: r.tag, selected: r.tag === ui.pickTag },
                `${r.version}${i === 0 && !r.prerelease ? '  (latest)' : ''}${r.prerelease ? '  (prerelease)' : ''}${s.rojo.installs.some((x) => x.source === 'managed' && x.version === r.version) ? '  ✓ installed' : ''}`
              )
            )
          : [h('option', { value: '', key: 'none' }, ui.releasesLoading ? 'Loading releases…' : 'No releases loaded')]
      ),
      btn(installing ? 'Installing…' : 'Install', () => installRojo(ui.pickTag), { icon: 'download', cls: 'primary', busy: installing, disabled: !ui.pickTag })
    ),
    install && install.phase !== 'done'
      ? h(
          'div',
          { class: 'stack', style: { gap: '6px' }, key: 'progress' },
          h('div', { class: `progress ${install.phase !== 'download' || !install.total ? 'indeterminate' : ''}`, role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('div', { style: { width: `${pct}%` } })),
          h(
            'div',
            { class: `hint ${install.phase === 'error' ? 'error' : ''}` },
            install.phase === 'download'
              ? `Downloading ${install.tag} · ${fmtBytes(install.received)}${install.total ? ` of ${fmtBytes(install.total)}` : ''}`
              : install.phase === 'verify'
                ? 'Checking the SHA-256 checksum…'
                : install.phase === 'extract'
                  ? 'Unpacking…'
                  : `Failed: ${install.message ?? 'unknown error'}`
          )
        )
      : null,
    h('div', { class: 'hint mono ellipsis', title: s.platform.dataDir }, `Installs to ${s.platform.dataDir}`)
  )

  const studioCard = h(
    'section',
    { class: 'card', 'aria-label': 'Roblox Studio plugin' },
    h(
      'div',
      { class: 'card-head' },
      h('div', { class: 'item-icon' }, icon('plug', 16)),
      h('div', { class: 'grow' }, h('div', { class: 'card-title' }, 'Roblox Studio plugin'), h('div', { class: 'card-sub' }, 'Studio needs the Rojo plugin to connect to your server.'))
    ),
    s.platform.studioPluginSupported
      ? h('div', { class: 'hint' }, 'Installs the plugin that matches your Rojo version into Studio\'s Plugins folder. Restart Studio afterwards.')
      : callout(
          'info',
          'Studio is not available on this OS',
          'Roblox Studio runs on Windows and macOS. If Studio runs in a VM or on another computer: save Rojo.rbxm and put it into Studio\'s Plugins folder there (Studio → Plugins → Plugins Folder), or install "Rojo" from the Creator Store. Serve with "Network (0.0.0.0)" so it can connect.'
        ),
    h(
      'div',
      { class: 'row wrap end' },
      pendingRbxm
        ? btn('Save Rojo.rbxm', () => saveBytes((pendingRbxm as { name: string }).name, (pendingRbxm as { data: Uint8Array }).data), { icon: 'download', cls: 'primary' })
        : btn('Save Rojo.rbxm…', () => saveRbxm(), { icon: 'download', busy: ui.busy.has('rbxm'), disabled: !orca.files }),
      s.platform.studioPluginSupported
        ? btn('Install into Studio', () => installStudioPlugin(), { icon: 'plug', cls: 'primary', busy: ui.busy.has('studio'), disabled: !rojo })
        : null
    )
  )

  const settingsHint = h(
    'div',
    { class: 'card', style: { gap: '6px' } },
    h('div', { class: 'card-title' }, 'Defaults'),
    h(
      'dl',
      { class: 'kv' },
      h('dt', null, 'Server address'),
      h('dd', null, s.settings.defaultHost === '0.0.0.0' ? 'All interfaces (0.0.0.0)' : 'This computer (localhost)'),
      h('dt', null, 'Port'),
      h('dd', { class: 'mono' }, String(s.settings.defaultPort)),
      h('dt', null, 'Runs in'),
      h('dd', null, s.settings.runIn === 'auto' ? 'Automatic' : s.settings.runIn === 'process' ? 'Background process' : 'Orca terminal'),
      h('dt', null, 'Sourcemap with serve'),
      h('dd', null, s.settings.sourcemapWithServe ? 'On' : 'Off')
    ),
    h('div', { class: 'hint' }, 'Change these in Orca Settings → Plugins → Rojo Studio.')
  )

  return h('div', { class: 'view', key: 'setup' }, activeCard, installsList, downloadCard, studioCard, settingsHint)
}

// ---------------------------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------------------------

const root = document.getElementById('root') as HTMLElement
let frame = 0

function render() {
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    draw()
  })
}

function draw() {
  const body =
    ui.fatal
      ? h('div', { class: 'view', key: 'fatal' }, empty('error', 'Rojo Studio could not start', ui.fatal, [btn('Try again', () => boot(), { icon: 'refresh', cls: 'primary' })]))
      : ui.tab === 'serve'
        ? serveView()
        : ui.tab === 'build'
          ? buildView()
          : ui.tab === 'project'
            ? projectView()
            : setupView()
  patchChildren(root, [
    header(),
    tabs(),
    h('main', { class: 'content', id: 'tabpanel', role: 'tabpanel', 'aria-labelledby': `tab-${ui.tab}`, key: 'content' }, body),
    h(
      'div',
      { class: 'toasts', key: 'toasts', 'aria-live': 'polite' },
      ui.toasts.map((t) => h('div', { class: `toast ${t.tone} ${t.leaving ? 'leaving' : ''}`, key: String(t.id), role: 'status' }, icon(t.tone === 'success' ? 'check' : t.tone === 'danger' ? 'error' : 'info', 15), t.message))
    )
  ])
}

function applyState(state: State) {
  const prevSelected = ui.state?.selectedProject
  ui.state = state
  ui.fatal = null
  logs.serve.jobs(state.jobs)
  logs.build.jobs(state.jobs)
  if (prevSelected !== state.selectedProject) {
    ui.form.forPath = null
    ui.jobView = { serve: null, build: null }
  }
  syncForm()
  render()
}

// Keyboard: Alt+1..4 tabs, Mod+Enter primary action, "/" filter output.
document.addEventListener('keydown', (e) => {
  const typing = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)
  if (e.altKey && !e.ctrlKey && !e.metaKey && /^Digit[1-4]$/.test(e.code)) {
    e.preventDefault()
    setTab(TABS[Number(e.code.slice(5)) - 1].id)
    return
  }
  if ((isMac ? e.metaKey : e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault()
    if (ui.tab === 'serve') void toggleServe()
    else if (ui.tab === 'build') void runBuild()
    else if (ui.tab === 'project' && ui.newProjectOpen) void createProject()
    return
  }
  if (e.key === '/' && !typing && (ui.tab === 'serve' || ui.tab === 'build')) {
    e.preventDefault()
    ;(document.querySelector(`[data-log-filter="${ui.tab === 'serve' ? 'serve-log' : 'build-log'}"]`) as HTMLElement | null)?.focus()
  }
})

orca.plugin.on('state', (state) => applyState(state))
orca.plugin.on('log', ({ id, lines }) => LogView.ingest(id, lines))
orca.plugin.on('toast', ({ tone, message }) => toast(tone, message))
orca.on('workspace.changed', () => void refresh())

// Keep "Up 3m 12s" and "2m ago" fresh without the worker posting.
setInterval(() => {
  if (ui.state?.jobs.some((j) => j.status === 'running')) render()
}, 1000)

async function boot() {
  ui.fatal = null
  render()
  try {
    applyState(await orca.plugin.request('state.get', {}, { timeoutMs: 30000 }))
    if (ui.tab === 'project') void inspect()
    if (ui.tab === 'setup') void loadReleases()
  } catch (error) {
    ui.fatal = error instanceof Error ? error.message : String(error)
    render()
  }
}

LogView.fetch = (id) => orca.plugin.request('job.logs', { id }).then((r) => r.lines)
void boot()
