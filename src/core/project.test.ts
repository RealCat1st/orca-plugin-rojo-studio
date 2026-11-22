import { assert, test } from 'orca/testing'
import {
  checkBuildOutput,
  compareProjectPaths,
  defaultBuildOutput,
  inspectProject,
  parseJsonc,
  parseToolchainPin,
  suggestKey,
  summarizeProject,
  type FsLike
} from './project'

/** An in-memory file system: keys are paths, `null` marks a folder. */
function memFs(files: Record<string, string | null>): FsLike {
  const norm = (p: string) => p.replace(/\/+$/, '').replace(/\/\.\//g, '/')
  const join = (...parts: string[]) => norm(parts.join('/').replace(/\/+/g, '/'))
  const all = new Map<string, string | null>()
  for (const [path, content] of Object.entries(files)) {
    all.set(norm(path), content)
    let dir = path
    while (dir.includes('/')) {
      dir = dir.slice(0, dir.lastIndexOf('/'))
      if (dir) all.set(dir, null)
    }
  }
  return {
    join,
    dirname: (p) => p.slice(0, p.lastIndexOf('/')) || '/',
    isAbsolute: (p) => p.startsWith('/'),
    async kind(p) {
      const v = all.get(norm(p))
      return v === undefined ? null : v === null ? 'dir' : 'file'
    },
    async list(dir) {
      const d = norm(dir)
      const out = new Map<string, boolean>()
      for (const [p, v] of all) {
        if (!p.startsWith(d + '/')) continue
        const rest = p.slice(d.length + 1)
        if (rest.includes('/')) continue
        out.set(rest, v === null)
      }
      return [...out].map(([name, isDir]) => ({ name, isDir }))
    },
    async readText(p) {
      const v = all.get(norm(p))
      return typeof v === 'string' ? v : null
    }
  }
}

const PLACE = `{
  // a comment
  "name": "place1",
  "tree": {
    "$className": "DataModel",
    "ReplicatedStorage": { "Shared": { "$path": "src/shared" } },
    "ServerScriptService": { "Server": { "$path": "src/server" } },
    "StarterPlayer": { "StarterPlayerScripts": { "Client": { "$path": "src/client" } } },
    "Workspace": { "$properties": { "FilteringEnabled": true }, "Baseplate": { "$className": "Part", "$properties": { "Anchored": true } } },
  },
}`

test('parses JSONC and reports error positions', () => {
  const ok = parseJsonc(PLACE)
  assert.ok(ok.ok)
  const bad = parseJsonc('{\n  "name": "x",\n  "tree": { "$path": "src" \n}')
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.ok(bad.line && bad.line >= 3)
  assert.deepEqual(parseJsonc('{"url": "http://x//y", /* c */ "a": [1,2,],}'), { ok: true, value: { url: 'http://x//y', a: [1, 2] } })
})

test('inspects the place template', async () => {
  const fs = memFs({
    '/p/default.project.json': PLACE,
    '/p/src/shared/Hello.luau': 'return {}',
    '/p/src/server/init.server.luau': 'print(1)',
    '/p/src/server/Data/init.luau': 'return {}',
    '/p/src/server/Data/Store.luau': 'return {}',
    '/p/src/server/Data/init.meta.json': '{}',
    '/p/src/client/init.client.luau': 'print(2)',
    '/p/src/client/Strings.csv': 'a,b',
    '/p/src/client/Config.model.json': '{"ClassName": "Configuration"}',
    '/p/src/client/notes.md': 'ignored'
  })
  const result = await inspectProject(fs, '/p/default.project.json')
  assert.deepEqual(result.issues, [])
  assert.equal(result.kind, 'place')
  assert.equal(result.name, 'place1')
  const tree = result.tree
  assert.ok(tree)
  assert.equal(tree.className, 'DataModel')
  const names = (tree.children ?? []).map((c) => `${c.name}:${c.className}`)
  assert.deepEqual(names, ['ReplicatedStorage:ReplicatedStorage', 'ServerScriptService:ServerScriptService', 'StarterPlayer:StarterPlayer', 'Workspace:Workspace'])
  const server = tree.children?.[1].children?.[0]
  assert.equal(server?.className, 'Script')
  assert.equal(server?.mapped, true)
  assert.equal(server?.source, 'src/server')
  assert.deepEqual(server?.children?.map((c) => `${c.name}:${c.className}`), ['Data:ModuleScript'])
  assert.deepEqual(server?.children?.[0].children?.map((c) => c.name), ['Store'])
  const client = tree.children?.[2].children?.[0].children?.[0]
  assert.equal(client?.className, 'LocalScript')
  assert.deepEqual(client?.children?.map((c) => `${c.name}:${c.className}`), ['Config:Configuration', 'Strings:LocalizationTable'])
  assert.equal(tree.children?.[3].props, 1)
  assert.equal(result.stats.mapped, 3)
  assert.equal(result.stats.missing, 0)
})

test('reports helpful problems', async () => {
  const fs = memFs({
    '/p/bad.project.json': JSON.stringify({
      nmae: 'x',
      servePort: 99999,
      tree: {
        $className: 'DataModel',
        ReplicatedStorage: { $pth: 'src', Lib: { $path: 'missing/dir' }, Opt: { $path: { optional: 'nope' } } },
        Stuff: {},
        Win: { $className: 'Folder', $path: 'src\\x' }
      }
    })
  })
  const r = await inspectProject(fs, '/p/bad.project.json')
  const text = r.issues.map((i) => `${i.severity}: ${i.message}${i.hint ? ` (${i.hint})` : ''}`)
  assert.ok(text.some((t) => t.startsWith('error: The project has no "name"')), text.join('\n'))
  assert.ok(text.some((t) => t.includes('Unknown top-level key "nmae"') && t.includes('Did you mean "name"?')))
  assert.ok(text.some((t) => t.includes('"servePort" must be')))
  assert.ok(text.some((t) => t.includes('Unknown key "$pth"') && t.includes('"$path"')))
  assert.ok(text.some((t) => t.startsWith('error: "$path" points to "missing/dir"')))
  assert.ok(text.some((t) => t.startsWith('info: Optional $path "nope"')))
  assert.ok(text.some((t) => t.includes('"Stuff" has neither "$className" nor "$path"')))
  assert.ok(text.some((t) => t.includes('backslashes')))
  assert.equal(r.issues[0].severity, 'error')
  assert.equal(r.stats.missing, 3)
})

test('reports invalid JSON with a line', async () => {
  const r = await inspectProject(memFs({ '/p/x.project.json': '{\n "name": "x"\n "tree": {}\n}' }), '/p/x.project.json')
  assert.equal(r.tree, null)
  assert.match(r.issues[0].message, /^Not valid JSON/)
  assert.equal(r.issues[0].line, 3)
})

test('follows nested projects', async () => {
  const fs = memFs({
    '/p/default.project.json': JSON.stringify({ name: 'outer', tree: { $className: 'DataModel', ReplicatedStorage: { Pkg: { $path: 'packages/pkg' } } } }),
    '/p/packages/pkg/default.project.json': JSON.stringify({ name: 'pkg', tree: { $path: 'src' } }),
    '/p/packages/pkg/src/init.luau': 'return 1'
  })
  const r = await inspectProject(fs, '/p/default.project.json')
  assert.deepEqual(r.issues, [])
  const pkg = r.tree?.children?.[0].children?.[0]
  assert.equal(pkg?.name, 'Pkg')
  assert.equal(pkg?.className, 'ModuleScript')
})

test('small helpers', () => {
  assert.equal(suggestKey('$classname', ['$className', '$path']), '$className')
  assert.equal(suggestKey('$zzzzzzzz', ['$className', '$path']), null)
  assert.deepEqual(summarizeProject('{"name":"m","tree":{"$path":"src"},"servePort":4000}'), { name: 'm', kind: 'model', servePort: 4000, error: null })
  assert.equal(defaultBuildOutput('My Game!', 'place'), 'build/My Game-.rbxl')
  assert.equal(defaultBuildOutput(null, 'model'), 'build/project.rbxm')
  assert.equal(checkBuildOutput('out.rbxl', 'place'), null)
  assert.match(checkBuildOutput('out.rbxm', 'place') ?? '', /place/)
  assert.match(checkBuildOutput('out.txt', 'model') ?? '', /must end/)
  assert.deepEqual(parseToolchainPin('[tools]\nrojo = "rojo-rbx/rojo@7.4.4" # pinned\n'), { spec: 'rojo-rbx/rojo@7.4.4', version: '7.4.4' })
  assert.deepEqual(parseToolchainPin('[tools]\nrojo = { source = "rojo-rbx/rojo", version = "=7.3.0" }'), { spec: 'rojo-rbx/rojo@7.3.0', version: '7.3.0' })
  assert.equal(parseToolchainPin('[tools]\nselene = "x/y@1"'), null)
  const sorted = ['b/x.project.json', 'default.project.json', 'a.project.json', 'b/default.project.json'].sort(compareProjectPaths)
  assert.deepEqual(sorted, ['default.project.json', 'a.project.json', 'b/default.project.json', 'b/x.project.json'])
})
