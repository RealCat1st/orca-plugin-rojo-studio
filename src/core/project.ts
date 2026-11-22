// Rojo project files (`*.project.json`): tolerant parsing (Rojo accepts JSON with comments and
// trailing commas), a linter with helpful messages, and the Roblox instance tree the project maps
// to, following Rojo's file-to-instance rules (rojo.space/docs/v7/sync-details/).
import type { Issue, NodeKind, ProjectInspection, ProjectKind, TreeNode } from '../protocol'

export type FsEntry = { name: string; isDir: boolean }
/** The few file-system calls the inspector needs; the worker passes real ones. */
export interface FsLike {
  join(...parts: string[]): string
  dirname(path: string): string
  isAbsolute(path: string): boolean
  /** null when the path does not exist. */
  kind(path: string): Promise<'file' | 'dir' | null>
  list(dir: string): Promise<FsEntry[]>
  readText(path: string): Promise<string | null>
}

// ---------------------------------------------------------------------------------------------
// JSONC
// ---------------------------------------------------------------------------------------------

/** Replaces comments and trailing commas with spaces, so offsets stay the same for errors. */
export function stripJsonc(text: string): string {
  let out = ''
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i]
    if (c === '"') {
      let j = i + 1
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j + 1
    } else if (c === '/' && text[i + 1] === '/') {
      let j = i
      while (j < n && text[j] !== '\n') j++
      out += ' '.repeat(j - i)
      i = j
    } else if (c === '/' && text[i + 1] === '*') {
      let j = i + 2
      while (j < n && !(text[j] === '*' && text[j + 1] === '/')) j++
      const chunk = text.slice(i, Math.min(n, j + 2))
      out += chunk.replace(/[^\n]/g, ' ')
      i = j + 2
    } else if (c === ',') {
      let j = i + 1
      while (j < n && /\s/.test(text[j])) j++
      out += text[j] === '}' || text[j] === ']' ? ' ' : ','
      i++
    } else {
      out += c
      i++
    }
  }
  return out
}

export type ParseResult = { ok: true; value: unknown } | { ok: false; message: string; line?: number; column?: number }

function lineColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1
  let column = 1
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') {
      line++
      column = 1
    } else column++
  }
  return { line, column }
}

export function parseJsonc(text: string): ParseResult {
  const clean = stripJsonc(text.replace(/^﻿/, ''))
  try {
    return { ok: true, value: JSON.parse(clean) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const lc = /line (\d+) column (\d+)/.exec(message)
    if (lc) return { ok: false, message: tidyJsonError(message), line: Number(lc[1]), column: Number(lc[2]) }
    const pos = /position (\d+)/.exec(message)
    if (pos) return { ok: false, message: tidyJsonError(message), ...lineColumn(clean, Number(pos[1])) }
    return { ok: false, message: tidyJsonError(message) }
  }
}

function tidyJsonError(message: string): string {
  return message.replace(/\s*\(line \d+ column \d+\)/, '').replace(/ in JSON at position \d+/, '').trim()
}

// ---------------------------------------------------------------------------------------------
// Knowledge about Rojo projects
// ---------------------------------------------------------------------------------------------

export const TOP_LEVEL_KEYS = [
  '$schema',
  'name',
  'tree',
  'servePort',
  'serveAddress',
  'servePlaceIds',
  'blockedPlaceIds',
  'placeId',
  'gameId',
  'globIgnorePaths',
  'emitLegacyScripts',
  'serveAllowedHosts',
  'syncbackRules'
]

export const NODE_KEYS = ['$className', '$path', '$properties', '$attributes', '$ignoreUnknownInstances', '$id']

/** Services Rojo can infer `$className` for when they sit directly under the DataModel. */
export const SERVICES = new Set([
  'AnalyticsService',
  'AssetService',
  'BadgeService',
  'Chat',
  'CollectionService',
  'ContentProvider',
  'ContextActionService',
  'DataStoreService',
  'Debris',
  'GamePassService',
  'GroupService',
  'GuiService',
  'HttpService',
  'InsertService',
  'Lighting',
  'LocalizationService',
  'LogService',
  'MarketplaceService',
  'MaterialService',
  'MemoryStoreService',
  'MessagingService',
  'PathfindingService',
  'PhysicsService',
  'Players',
  'PolicyService',
  'ProximityPromptService',
  'ReplicatedFirst',
  'ReplicatedStorage',
  'RunService',
  'ServerScriptService',
  'ServerStorage',
  'SocialService',
  'SoundService',
  'StarterGui',
  'StarterPack',
  'StarterPlayer',
  'Teams',
  'TeleportService',
  'TestService',
  'TextChatService',
  'TextService',
  'TweenService',
  'UserInputService',
  'VRService',
  'VoiceChatService',
  'Workspace'
])

/** Children Rojo infers by name below a given parent class. */
const INFERRED_CHILDREN: Record<string, string[]> = {
  StarterPlayer: ['StarterPlayerScripts', 'StarterCharacterScripts'],
  Workspace: ['Terrain']
}

export function inferClassName(name: string, parentClass: string | null): string | null {
  if (parentClass === 'DataModel' && SERVICES.has(name)) return name
  if (parentClass && INFERRED_CHILDREN[parentClass]?.includes(name)) return name
  return null
}

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return row[b.length]
}

/** The closest known key, for "did you mean" hints. */
export function suggestKey(key: string, known: readonly string[]): string | null {
  let best: string | null = null
  let score = Infinity
  for (const candidate of known) {
    const d = levenshtein(key.toLowerCase(), candidate.toLowerCase())
    if (d < score) {
      score = d
      best = candidate
    }
  }
  return best && score <= Math.max(2, Math.floor(key.length / 3)) ? best : null
}

// ---------------------------------------------------------------------------------------------
// File → instance rules (rojo.space/docs/v7/sync-details/)
// ---------------------------------------------------------------------------------------------

type FileRule = { suffix: string; className: string; kind: NodeKind }

const FILE_RULES: FileRule[] = [
  { suffix: '.server.luau', className: 'Script', kind: 'script' },
  { suffix: '.server.lua', className: 'Script', kind: 'script' },
  { suffix: '.client.luau', className: 'LocalScript', kind: 'localscript' },
  { suffix: '.client.lua', className: 'LocalScript', kind: 'localscript' },
  { suffix: '.plugin.luau', className: 'Script', kind: 'script' },
  { suffix: '.plugin.lua', className: 'Script', kind: 'script' },
  { suffix: '.local.luau', className: 'LocalScript', kind: 'localscript' },
  { suffix: '.legacy.luau', className: 'Script', kind: 'script' },
  { suffix: '.project.json', className: 'Project', kind: 'project' },
  { suffix: '.model.json', className: 'Instance', kind: 'instance' },
  { suffix: '.meta.json', className: '', kind: 'instance' },
  { suffix: '.luau', className: 'ModuleScript', kind: 'module' },
  { suffix: '.lua', className: 'ModuleScript', kind: 'module' },
  { suffix: '.json', className: 'ModuleScript', kind: 'module' },
  { suffix: '.jsonc', className: 'ModuleScript', kind: 'module' },
  { suffix: '.toml', className: 'ModuleScript', kind: 'module' },
  { suffix: '.yaml', className: 'ModuleScript', kind: 'module' },
  { suffix: '.yml', className: 'ModuleScript', kind: 'module' },
  { suffix: '.txt', className: 'StringValue', kind: 'value' },
  { suffix: '.csv', className: 'LocalizationTable', kind: 'value' },
  { suffix: '.rbxm', className: 'Model file', kind: 'model' },
  { suffix: '.rbxmx', className: 'Model file', kind: 'model' }
]

export function fileRule(fileName: string): FileRule | null {
  const lower = fileName.toLowerCase()
  return FILE_RULES.find((rule) => lower.endsWith(rule.suffix) && lower.length > rule.suffix.length) ?? null
}

const INIT_RULES: { names: string[]; className: string; kind: NodeKind }[] = [
  { names: ['init.server.luau', 'init.server.lua'], className: 'Script', kind: 'script' },
  { names: ['init.client.luau', 'init.client.lua'], className: 'LocalScript', kind: 'localscript' },
  { names: ['init.luau', 'init.lua'], className: 'ModuleScript', kind: 'module' },
  { names: ['init.csv'], className: 'LocalizationTable', kind: 'value' }
]

function kindForClass(className: string): NodeKind {
  if (className === 'DataModel') return 'datamodel'
  if (SERVICES.has(className)) return 'service'
  if (className === 'Folder') return 'folder'
  if (className === 'Script') return 'script'
  if (className === 'LocalScript') return 'localscript'
  if (className === 'ModuleScript') return 'module'
  if (/Value$/.test(className)) return 'value'
  if (className === 'Model') return 'model'
  return 'instance'
}

// ---------------------------------------------------------------------------------------------
// Inspector
// ---------------------------------------------------------------------------------------------

export const LIMITS = { nodes: 1500, depth: 12, childrenPerFolder: 250, nestedProjects: 4 }

type Ctx = {
  fs: FsLike
  projectDir: string
  issues: Issue[]
  nodes: number
  stats: ProjectInspection['stats']
  seq: number
  nestedDepth: number
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function issue(ctx: Ctx, severity: Issue['severity'], where: string[], message: string, hint?: string) {
  ctx.issues.push({ severity, where: where.join(' › '), message, ...(hint ? { hint } : {}) })
}

function relSource(ctx: Ctx, abs: string): string {
  const base = ctx.projectDir.replace(/[\\/]+$/, '')
  if (abs.startsWith(base + '/') || abs.startsWith(base + '\\')) return abs.slice(base.length + 1).replace(/\\/g, '/')
  return abs
}

function nextKey(ctx: Ctx): string {
  return `n${(ctx.seq++).toString(36)}`
}

function stripSuffix(name: string, suffix: string): string {
  return name.slice(0, name.length - suffix.length)
}

async function nestedProjectNode(ctx: Ctx, abs: string, name: string, depth: number): Promise<TreeNode> {
  const text = await ctx.fs.readText(abs)
  const base: TreeNode = { key: nextKey(ctx), name, className: 'Folder', kind: 'project', source: relSource(ctx, abs) }
  if (text === null || ctx.nestedDepth >= LIMITS.nestedProjects) return { ...base, truncated: ctx.nestedDepth >= LIMITS.nestedProjects }
  const parsed = parseJsonc(text)
  if (!parsed.ok || !isObject(parsed.value) || !isObject(parsed.value.tree)) return base
  ctx.nestedDepth++
  const saved = ctx.projectDir
  ctx.projectDir = ctx.fs.dirname(abs)
  try {
    const node = await treeNode(ctx, parsed.value.tree, name, null, [name], depth)
    return { ...node, kind: node.kind === 'folder' ? 'project' : node.kind, source: relSource({ ...ctx, projectDir: saved }, abs) }
  } finally {
    ctx.projectDir = saved
    ctx.nestedDepth--
  }
}

/** The instance a file or folder on disk becomes. */
async function fsNode(ctx: Ctx, abs: string, name: string, depth: number, mapped: boolean): Promise<TreeNode | null> {
  if (ctx.nodes >= LIMITS.nodes) return null
  const kind = await ctx.fs.kind(abs)
  if (kind === null) return null
  ctx.nodes++
  if (kind === 'file') {
    const fileName = abs.split(/[\\/]/).pop() ?? abs
    const rule = fileRule(fileName)
    if (!rule || rule.suffix === '.meta.json') return null
    if (rule.kind === 'project') return nestedProjectNode(ctx, abs, name, depth)
    let className = rule.className
    if (rule.suffix === '.model.json') {
      const parsed = parseJsonc((await ctx.fs.readText(abs)) ?? '')
      if (parsed.ok && isObject(parsed.value)) {
        const cn = parsed.value.ClassName ?? parsed.value.className
        if (typeof cn === 'string') className = cn
      }
    }
    if (rule.kind === 'script' || rule.kind === 'localscript' || rule.kind === 'module') ctx.stats.scripts++
    ctx.stats.instances++
    return { key: nextKey(ctx), name, className, kind: rule.kind === 'instance' ? kindForClass(className) : rule.kind, source: relSource(ctx, abs), mapped }
  }
  // A folder: an init file turns it into that script; a default.project.json into a project.
  const entries = await ctx.fs.list(abs)
  const lowerNames = new Set(entries.filter((e) => !e.isDir).map((e) => e.name.toLowerCase()))
  if (lowerNames.has('default.project.json')) return nestedProjectNode(ctx, ctx.fs.join(abs, 'default.project.json'), name, depth)
  let className = 'Folder'
  let nodeKind: NodeKind = 'folder'
  let initFile: string | null = null
  for (const rule of INIT_RULES) {
    const hit = rule.names.find((n) => lowerNames.has(n))
    if (hit) {
      className = rule.className
      nodeKind = rule.kind
      initFile = hit
      break
    }
  }
  if (nodeKind === 'script' || nodeKind === 'localscript' || nodeKind === 'module') ctx.stats.scripts++
  ctx.stats.instances++
  const node: TreeNode = { key: nextKey(ctx), name, className, kind: nodeKind, source: relSource(ctx, abs), mapped }
  if (depth >= LIMITS.depth) return { ...node, truncated: entries.length > 0 }
  const children: TreeNode[] = []
  const sorted = entries
    .filter((e) => !e.name.startsWith('.') && e.name.toLowerCase() !== initFile && !/^init\.meta\.json$/i.test(e.name))
    .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
  let truncated = false
  for (const entry of sorted) {
    if (children.length >= LIMITS.childrenPerFolder || ctx.nodes >= LIMITS.nodes) {
      truncated = true
      break
    }
    let childName = entry.name
    if (!entry.isDir) {
      const rule = fileRule(entry.name)
      if (!rule || rule.suffix === '.meta.json') continue
      childName = stripSuffix(entry.name, rule.suffix)
    }
    const child = await fsNode(ctx, ctx.fs.join(abs, entry.name), childName, depth + 1, false)
    if (child) children.push(child)
  }
  if (children.length) node.children = children
  if (truncated) node.truncated = true
  return node
}

async function treeNode(
  ctx: Ctx,
  value: unknown,
  name: string,
  parentClass: string | null,
  where: string[],
  depth: number
): Promise<TreeNode> {
  ctx.nodes++
  const node: TreeNode = { key: nextKey(ctx), name, className: 'Folder', kind: 'folder' }
  if (!isObject(value)) {
    issue(ctx, 'error', where, `"${name}" must be an object describing an instance.`, 'Use { "$className": "Folder" } or { "$path": "src" }.')
    return { ...node, className: '?', kind: 'instance' }
  }
  for (const key of Object.keys(value)) {
    if (key.startsWith('$') && !NODE_KEYS.includes(key)) {
      const guess = suggestKey(key, NODE_KEYS)
      issue(ctx, 'warning', where, `Unknown key "${key}"; Rojo ignores it.`, guess ? `Did you mean "${guess}"?` : undefined)
    }
  }
  const className = value.$className
  const path = value.$path
  if (className !== undefined && typeof className !== 'string') issue(ctx, 'error', where, '"$className" must be a string.')
  let pathString: string | null = null
  let optional = false
  if (path !== undefined) {
    if (typeof path === 'string') pathString = path
    else if (isObject(path) && typeof path.optional === 'string') {
      pathString = path.optional
      optional = true
    } else issue(ctx, 'error', where, '"$path" must be a string or { "optional": "path" }.')
  }
  if (value.$properties !== undefined && !isObject(value.$properties)) issue(ctx, 'error', where, '"$properties" must be an object.')
  if (value.$attributes !== undefined && !isObject(value.$attributes)) issue(ctx, 'error', where, '"$attributes" must be an object.')
  if (value.$ignoreUnknownInstances !== undefined && typeof value.$ignoreUnknownInstances !== 'boolean')
    issue(ctx, 'error', where, '"$ignoreUnknownInstances" must be true or false.')
  const props =
    (isObject(value.$properties) ? Object.keys(value.$properties).length : 0) +
    (isObject(value.$attributes) ? Object.keys(value.$attributes).length : 0)
  if (props) node.props = props

  let resolved: string | null = typeof className === 'string' ? className : null
  if (pathString !== null) {
    if (pathString.includes('\\'))
      issue(ctx, 'warning', where, `"$path" uses backslashes ("${pathString}").`, 'Use forward slashes so the project works on every OS.')
    if (ctx.fs.isAbsolute(pathString)) issue(ctx, 'warning', where, `"$path" is absolute ("${pathString}").`, 'Use a path relative to the project file.')
    const abs = ctx.fs.isAbsolute(pathString) ? pathString : ctx.fs.join(ctx.projectDir, pathString)
    const mappedNode = await fsNode(ctx, abs, name, depth, true)
    ctx.stats.mapped++
    if (!mappedNode) {
      ctx.stats.missing++
      if (optional) issue(ctx, 'info', where, `Optional $path "${pathString}" does not exist; it is skipped.`)
      else
        issue(
          ctx,
          'error',
          where,
          `"$path" points to "${pathString}", which does not exist.`,
          'Create the file or folder, fix the path, or make it optional with { "optional": "…" }.'
        )
      node.source = pathString
      node.missing = true
      node.mapped = true
      if (optional) node.optional = true
      if (resolved) {
        node.className = resolved
        node.kind = kindForClass(resolved)
      }
    } else {
      Object.assign(node, mappedNode, { key: node.key })
      if (resolved && mappedNode.className !== 'Folder' && mappedNode.className !== resolved && mappedNode.kind !== 'project')
        issue(ctx, 'warning', where, `"$className" is ${resolved}, but "${pathString}" makes a ${mappedNode.className}.`)
      if (resolved && mappedNode.className === 'Folder') {
        node.className = resolved
        node.kind = kindForClass(resolved)
      }
      if (optional) node.optional = true
      if (props) node.props = props
    }
  } else if (resolved) {
    node.className = resolved
    node.kind = kindForClass(resolved)
    ctx.stats.instances++
  } else {
    const inferred = inferClassName(name, parentClass)
    if (inferred) {
      node.className = inferred
      node.kind = kindForClass(inferred)
      ctx.stats.instances++
    } else {
      issue(
        ctx,
        'error',
        where,
        `"${name}" has neither "$className" nor "$path", so Rojo cannot tell what instance it is.`,
        parentClass === 'DataModel'
          ? `"${name}" is not a service Rojo knows. Add "$className", or check the spelling.`
          : 'Add "$className": "Folder" (or another class), or a "$path".'
      )
      node.className = '?'
      node.kind = 'instance'
    }
  }
  if (node.className === 'DataModel' && parentClass !== null)
    issue(ctx, 'error', where, 'Only the root of "tree" can be a DataModel.')

  const children: TreeNode[] = node.children ? [...node.children] : []
  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith('$')) continue
    if (ctx.nodes >= LIMITS.nodes) {
      node.truncated = true
      break
    }
    children.push(await treeNode(ctx, child, key, node.className, [...where, key], depth + 1))
  }
  if (children.length) node.children = children
  return node
}

function projectKind(tree: TreeNode | null): ProjectKind {
  if (!tree) return 'unknown'
  return tree.className === 'DataModel' ? 'place' : 'model'
}

/** Lints a project file and builds its instance tree. */
export async function inspectProject(fs: FsLike, projectPath: string): Promise<ProjectInspection> {
  const ctx: Ctx = {
    fs,
    projectDir: fs.dirname(projectPath),
    issues: [],
    nodes: 0,
    stats: { instances: 0, mapped: 0, scripts: 0, missing: 0 },
    seq: 0,
    nestedDepth: 0
  }
  const empty = (issues: Issue[]): ProjectInspection => ({ path: projectPath, name: null, kind: 'unknown', tree: null, issues, stats: ctx.stats })
  const text = await fs.readText(projectPath)
  if (text === null) return empty([{ severity: 'error', where: '', message: 'The project file could not be read.' }])
  const parsed = parseJsonc(text)
  if (!parsed.ok)
    return empty([
      {
        severity: 'error',
        where: '',
        message: `Not valid JSON: ${parsed.message}`,
        ...(parsed.line ? { line: parsed.line, column: parsed.column } : {}),
        hint: parsed.line ? `Check line ${parsed.line}, column ${parsed.column}.` : undefined
      }
    ])
  const project = parsed.value
  if (!isObject(project)) return empty([{ severity: 'error', where: '', message: 'A project file must be a JSON object.' }])
  for (const key of Object.keys(project)) {
    if (!TOP_LEVEL_KEYS.includes(key)) {
      const guess = suggestKey(key, TOP_LEVEL_KEYS)
      issue(ctx, 'warning', [], `Unknown top-level key "${key}"; Rojo ignores it.`, guess ? `Did you mean "${guess}"?` : undefined)
    }
  }
  const name = typeof project.name === 'string' ? project.name : null
  if (project.name === undefined) issue(ctx, 'error', [], 'The project has no "name".', 'Add "name": "MyGame" at the top level.')
  else if (typeof project.name !== 'string') issue(ctx, 'error', [], '"name" must be a string.')
  if (project.servePort !== undefined) {
    const port = project.servePort
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)
      issue(ctx, 'error', [], '"servePort" must be a whole number from 1 to 65535.')
  }
  for (const key of ['servePlaceIds', 'blockedPlaceIds']) {
    if (project[key] !== undefined && !Array.isArray(project[key])) issue(ctx, 'error', [], `"${key}" must be an array of place ids.`)
  }
  if (project.globIgnorePaths !== undefined) {
    const globs = project.globIgnorePaths
    if (!Array.isArray(globs) || globs.some((g) => typeof g !== 'string')) issue(ctx, 'error', [], '"globIgnorePaths" must be an array of strings.')
  }
  let tree: TreeNode | null = null
  if (project.tree === undefined) issue(ctx, 'error', [], 'The project has no "tree".', 'Add "tree": { "$path": "src" } for a model, or a DataModel tree for a place.')
  else if (!isObject(project.tree)) issue(ctx, 'error', ['tree'], '"tree" must be an object.')
  else {
    tree = await treeNode(ctx, project.tree, name ?? 'tree', null, ['tree'], 0)
    if (tree.className === 'DataModel' && !tree.children?.length)
      issue(ctx, 'info', ['tree'], 'The place has no services yet.', 'Map a folder, e.g. "ReplicatedStorage": { "$path": "src/shared" }.')
  }
  if (ctx.nodes >= LIMITS.nodes)
    issue(ctx, 'info', [], `The tree is large; only the first ${LIMITS.nodes} instances are shown.`)
  const order = { error: 0, warning: 1, info: 2 }
  ctx.issues.sort((a, b) => order[a.severity] - order[b.severity])
  return { path: projectPath, name, kind: projectKind(tree), tree, issues: ctx.issues, stats: ctx.stats }
}

/** Quick facts for the project picker, without walking the file system. */
export function summarizeProject(text: string): { name: string | null; kind: ProjectKind; servePort: number | null; error: string | null } {
  const parsed = parseJsonc(text)
  if (!parsed.ok) return { name: null, kind: 'unknown', servePort: null, error: parsed.message }
  const project = parsed.value
  if (!isObject(project)) return { name: null, kind: 'unknown', servePort: null, error: 'Not a JSON object.' }
  const tree = project.tree
  const kind: ProjectKind = isObject(tree) ? (tree.$className === 'DataModel' ? 'place' : 'model') : 'unknown'
  const port = typeof project.servePort === 'number' && Number.isInteger(project.servePort) ? project.servePort : null
  return { name: typeof project.name === 'string' ? project.name : null, kind, servePort: port, error: null }
}

/** Sort order of the picker: `default.project.json` first, then shallow before deep, then by name. */
export function compareProjectPaths(a: string, b: string): number {
  const base = (p: string) => p.split(/[\\/]/).pop() ?? p
  const da = base(a).toLowerCase() === 'default.project.json' ? 0 : 1
  const db = base(b).toLowerCase() === 'default.project.json' ? 0 : 1
  const depth = (p: string) => p.split(/[\\/]/).length
  return depth(a) - depth(b) || da - db || a.localeCompare(b)
}

/** Default build output for a project: `build/<name>.rbxl` for places, `.rbxm` for models. */
export function defaultBuildOutput(name: string | null, kind: ProjectKind): string {
  const safe = (name ?? 'project').replace(/[^A-Za-z0-9._ -]+/g, '-').trim() || 'project'
  return `build/${safe}.${kind === 'place' ? 'rbxl' : 'rbxm'}`
}

/** Checks a build output name against the project kind. Returns a problem, or null. */
export function checkBuildOutput(output: string, kind: ProjectKind): string | null {
  const lower = output.toLowerCase()
  if (!/\.(rbxl|rbxlx|rbxm|rbxmx)$/.test(lower)) return 'The output must end in .rbxl, .rbxlx, .rbxm or .rbxmx.'
  if (kind === 'place' && /\.rbxmx?$/.test(lower)) return 'This project is a place (DataModel); build it to .rbxl or .rbxlx.'
  if (kind === 'model' && /\.rbxlx?$/.test(lower)) return 'This project is a model; build it to .rbxm or .rbxmx.'
  return null
}

/** Rojo pins in a toolchain file: `rojo = "rojo-rbx/rojo@7.4.4"` (rokit, aftman, foreman). */
export function parseToolchainPin(text: string): { spec: string; version: string | null } | null {
  for (const line of text.split(/\r?\n/)) {
    const clean = line.replace(/#.*$/, '').trim()
    // rokit/aftman: rojo = "rojo-rbx/rojo@7.4.4"; foreman: rojo = { source = "rojo-rbx/rojo", version = "7.4.4" }
    const simple = /^rojo\s*=\s*"([^"]+)"/i.exec(clean)
    if (simple) {
      const version = /@v?([0-9][^"\s]*)$/.exec(simple[1])
      return { spec: simple[1], version: version ? version[1] : null }
    }
    const table = /^rojo\s*=\s*\{(.*)\}/i.exec(clean)
    if (table) {
      const source = /source\s*=\s*"([^"]+)"/.exec(table[1])
      const version = /version\s*=\s*"[=^~]?v?([^"]+)"/.exec(table[1])
      return { spec: `${source?.[1] ?? 'rojo-rbx/rojo'}@${version?.[1] ?? '*'}`, version: version ? version[1] : null }
    }
  }
  return null
}
