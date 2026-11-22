// Worker-side system helpers: where the plugin keeps its files, the environment Rojo runs with,
// running a short command, and finding Rojo installations. The worker is a normal Node process
// (docs/reference/plugin-authoring.md), so this uses node: modules directly.
import { spawn } from 'node:child_process'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import type { InstallSource, RojoInstall, ToolchainPin } from './protocol'
import type { FsLike, FsEntry } from './core/project'
import { compareVersions, parseVersionOutput } from './core/releases'
import { parseToolchainPin } from './core/project'

export const isWindows = process.platform === 'win32'
export const exeName = isWindows ? 'rojo.exe' : 'rojo'

export function home(): string {
  return process.env.USERPROFILE && isWindows ? process.env.USERPROFILE : process.env.HOME || homedir()
}

/**
 * The plugin's own data folder. Orca gives workers no data-folder API (its `pluginRoot` is
 * internal), so this follows each OS's convention for per-user application data.
 */
export function dataDir(): string {
  const h = home()
  if (isWindows) return join(process.env.LOCALAPPDATA || join(h, 'AppData', 'Local'), 'RojoStudio')
  if (process.platform === 'darwin') return join(h, 'Library', 'Application Support', 'RojoStudio')
  return join(process.env.XDG_DATA_HOME || join(h, '.local', 'share'), 'rojo-studio')
}

export function managedRoot(): string {
  return join(dataDir(), 'rojo')
}

/**
 * Environment for Rojo. Orca hands workers an allowlisted environment (no LOCALAPPDATA on
 * Windows, which `rojo plugin install` needs to find Studio's Plugins folder), plus
 * ELECTRON_RUN_AS_NODE, which must not leak into child processes.
 */
export function childEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string' && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value
  }
  if (isWindows) {
    const h = home()
    env.LOCALAPPDATA ??= join(h, 'AppData', 'Local')
    env.APPDATA ??= join(h, 'AppData', 'Roaming')
    env.USERPROFILE ??= h
  }
  // Tool managers install shims here; Orca's launch PATH often lacks them (GUI apps on macOS).
  const extra = [join(home(), '.rokit', 'bin'), join(home(), '.aftman', 'bin'), join(home(), '.foreman', 'bin'), join(home(), '.cargo', 'bin')]
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  const parts = (env[pathKey] ?? '').split(delimiter).filter(Boolean)
  env[pathKey] = [...parts, ...extra.filter((p) => !parts.includes(p))].join(delimiter)
  return env
}

export type RunResult = { code: number | null; stdout: string; stderr: string; error: string | null }

/** Runs a short command and collects its output. Never throws. */
export function run(bin: string, args: readonly string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let done = false
    const decoder = new TextDecoder()
    const finish = (result: RunResult) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(result)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bin, args, { cwd: options.cwd, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: '', error: error instanceof Error ? error.message : String(error) })
      return
    }
    const timer = setTimeout(() => {
      child.kill()
      finish({ code: null, stdout, stderr, error: `Timed out after ${Math.round((options.timeoutMs ?? 10000) / 1000)} s.` })
    }, options.timeoutMs ?? 10000)
    child.stdout?.on('data', (chunk) => (stdout += decoder.decode(chunk, { stream: true })))
    child.stderr?.on('data', (chunk) => (stderr += decoder.decode(chunk, { stream: true })))
    child.on('error', (error) => finish({ code: null, stdout, stderr, error: error.code === 'ENOENT' ? 'Not found.' : error.message }))
    child.on('close', (code) => finish({ code, stdout, stderr, error: null }))
  })
}

// ---------------------------------------------------------------------------------------------
// File system adapter for the project inspector
// ---------------------------------------------------------------------------------------------

export const nodeFs: FsLike = {
  join,
  dirname,
  isAbsolute,
  async kind(path) {
    try {
      const s = await stat(path)
      return s.isDirectory() ? 'dir' : s.isFile() ? 'file' : null
    } catch {
      return null
    }
  },
  async list(dir) {
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      const out: FsEntry[] = []
      for (const e of entries) {
        if (e.isDirectory()) out.push({ name: e.name, isDir: true })
        else if (e.isFile()) out.push({ name: e.name, isDir: false })
        else if (e.isSymbolicLink()) {
          try {
            const s = await stat(join(dir, e.name))
            out.push({ name: e.name, isDir: s.isDirectory() })
          } catch {
            /* dangling link */
          }
        }
      }
      return out
    } catch {
      return []
    }
  },
  async readText(path) {
    try {
      const s = await stat(path)
      if (!s.isFile() || s.size > 4 * 1024 * 1024) return null
      return await readFile(path, 'utf-8')
    } catch {
      return null
    }
  }
}

export async function exists(path: string): Promise<boolean> {
  return (await nodeFs.kind(path)) !== null
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'Packages', 'ServerPackages', 'DevPackages', 'build', 'dist', 'out', 'target', '.rokit', '.aftman'])

/** `*.project.json` files in a folder and up to two levels below it. */
export async function findProjectFiles(root: string, maxDepth = 2): Promise<string[]> {
  const found: string[] = []
  async function walk(dir: string, depth: number) {
    const entries = await nodeFs.list(dir)
    for (const e of entries) {
      if (e.isDir) {
        if (depth < maxDepth && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) await walk(join(dir, e.name), depth + 1)
      } else if (e.name.toLowerCase().endsWith('.project.json')) found.push(join(dir, e.name))
      if (found.length >= 50) return
    }
  }
  await walk(root, 0)
  return found
}

// ---------------------------------------------------------------------------------------------
// Rojo installations
// ---------------------------------------------------------------------------------------------

const MANAGERS: { dir: string[]; source: InstallSource; label: string }[] = [
  { dir: ['.rokit', 'bin'], source: 'rokit', label: 'Rokit' },
  { dir: ['.aftman', 'bin'], source: 'aftman', label: 'Aftman' },
  { dir: ['.foreman', 'bin'], source: 'foreman', label: 'Foreman' },
  { dir: ['.cargo', 'bin'], source: 'cargo', label: 'Cargo' }
]

function managerFor(path: string): (typeof MANAGERS)[number] | null {
  const norm = path.replace(/\\/g, '/').toLowerCase()
  return MANAGERS.find((m) => norm.includes(`/${m.dir.join('/')}/`)) ?? null
}

/** The version a binary reports, with `cwd` set so tool-manager shims resolve the project's pin. */
export async function binaryVersion(bin: string, cwd?: string): Promise<{ version: string | null; error: string | null }> {
  const result = await run(bin, ['--version'], { cwd, timeoutMs: 20000 })
  const version = parseVersionOutput(result.stdout + '\n' + result.stderr)
  if (version) return { version, error: null }
  const detail = (result.stderr || result.stdout || result.error || '').trim().split(/\r?\n/).slice(-1)[0]
  return { version: null, error: detail || `Exited with code ${result.code}.` }
}

export type DetectOptions = { workspaceDir: string | null; customPath: string }

/** Every Rojo the plugin can find: custom setting, plugin-managed, tool managers and PATH. */
export async function detectInstalls(options: DetectOptions): Promise<RojoInstall[]> {
  const candidates: { path: string; source: InstallSource; label: string }[] = []
  const custom = options.customPath.trim()
  if (custom) candidates.push({ path: custom, source: 'custom', label: 'Custom path (setting)' })
  const managed = await nodeFs.list(managedRoot())
  for (const dir of managed.filter((e) => e.isDir).sort((a, b) => compareVersions(b.name, a.name))) {
    const bin = join(managedRoot(), dir.name, exeName)
    if (await exists(bin)) candidates.push({ path: bin, source: 'managed', label: `Installed by Rojo Studio` })
  }
  for (const m of MANAGERS) {
    const bin = join(home(), ...m.dir, exeName)
    if (await exists(bin)) candidates.push({ path: bin, source: m.source, label: m.source === 'cargo' ? 'Cargo install' : `${m.label} shim` })
  }
  const pathDirs = (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean)
  for (const dir of pathDirs) {
    const bin = join(dir, exeName)
    if (!(await exists(bin))) continue
    const m = managerFor(bin)
    candidates.push({ path: bin, source: m?.source ?? 'path', label: m ? `${m.label} shim` : 'On PATH' })
  }
  const seen = new Set<string>()
  const out: RojoInstall[] = []
  for (const c of candidates) {
    const key = isWindows ? c.path.toLowerCase() : c.path
    if (seen.has(key)) continue
    seen.add(key)
    let resolved = c.path
    try {
      resolved = await realpath(c.path)
    } catch {
      /* keep */
    }
    // Two PATH entries that point at the same real file (e.g. /usr/bin → /bin) are one install.
    const realKey = `real:${isWindows ? resolved.toLowerCase() : resolved}`
    if (c.source === 'path' && seen.has(realKey)) continue
    seen.add(realKey)
    const { version, error } = await binaryVersion(c.path, options.workspaceDir ?? undefined)
    const install: RojoInstall = { path: c.path, version, source: c.source, label: c.label }
    if (!version) install.note = error ?? 'Did not report a version.'
    else if (c.source === 'rokit' || c.source === 'aftman' || c.source === 'foreman') install.note = 'Uses the version the project pins.'
    out.push(install)
  }
  return out
}

/** The install to use: the person's choice, else the project's pinned tool manager, PATH, managed. */
export function pickActive(installs: readonly RojoInstall[], chosen: string | null, pin: ToolchainPin | null): RojoInstall | null {
  const usable = installs.filter((i) => i.version)
  if (chosen) {
    const hit = usable.find((i) => i.path === chosen)
    if (hit) return hit
  }
  const custom = usable.find((i) => i.source === 'custom')
  if (custom) return custom
  if (pin) {
    const shim = usable.find((i) => i.source === pin.manager)
    if (shim) return shim
  }
  return usable.find((i) => i.source === 'path') ?? usable.find((i) => i.source === 'managed') ?? usable[0] ?? null
}

/** A Rojo pin in the workspace's rokit.toml, aftman.toml or foreman.toml. */
export async function readToolchainPin(dir: string): Promise<ToolchainPin | null> {
  for (const manager of ['rokit', 'aftman', 'foreman'] as const) {
    const file = join(dir, `${manager}.toml`)
    const text = await nodeFs.readText(file)
    if (text === null) continue
    const pin = parseToolchainPin(text)
    if (pin) return { file: `${manager}.toml`, manager, ...pin }
  }
  return null
}

export async function fileSize(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size
  } catch {
    return null
  }
}
