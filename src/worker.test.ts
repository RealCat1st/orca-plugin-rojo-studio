// Worker tests against Orca's test kit (mountWorker + mockHost), a real temp folder and a fake
// `rojo` (a shell script that behaves like Rojo's CLI), so no download or Roblox is needed.
// The real Rojo is exercised by src/e2e.test.ts.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as main from './worker'
import type { State } from './protocol'

const posix = process.platform !== 'win32'

const FAKE_ROJO = `#!/bin/sh
cmd="$1"; shift
out=""; port="34872"
while [ $# -gt 0 ]; do
  case "$1" in
    --output|-o) out="$2"; shift ;;
    --port) port="$2"; shift ;;
  esac
  shift
done
case "$cmd" in
  --version) echo "Rojo 7.7.1" ;;
  serve)
    echo "Rojo server listening:"
    echo "  Address: localhost"
    echo "  Port:    $port"
    exec sleep 30 ;;
  build) echo "Building project 'demo'"; printf 'RBXL' > "$out"; echo "Built project to $out" ;;
  sourcemap) printf '{"name":"demo"}' > "$out"; echo "Created sourcemap at $out" ;;
  *) echo "[ERROR rojo] unknown command $cmd" >&2; exit 2 ;;
esac
`

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'rojo-studio-test-'))
  const ws = join(root, 'game')
  await mkdir(join(ws, 'src', 'server'), { recursive: true })
  await writeFile(
    join(ws, 'default.project.json'),
    JSON.stringify({ name: 'demo', tree: { $className: 'DataModel', ServerScriptService: { Server: { $path: 'src/server' } } } })
  )
  await writeFile(join(ws, 'src', 'server', 'init.server.luau'), 'print("hi")')
  // The plugin's data folder (XDG_DATA_HOME on Linux) holds a fake "managed" Rojo.
  process.env.XDG_DATA_HOME = join(root, 'data')
  process.env.HOME = root
  const fake = join(root, 'data', 'rojo-studio', 'rojo', '7.7.1', 'rojo')
  await mkdir(join(root, 'data', 'rojo-studio', 'rojo', '7.7.1'), { recursive: true })
  await writeFile(fake, FAKE_ROJO)
  await chmod(fake, 0o755)
  const host = mockHost({
    settings: { checkForUpdates: false, notifyOnError: true },
    results: {
      'workspace.readContext': { workspaceId: 'ws1', branch: 'main', displayName: 'Game', terminals: [] },
      'workspace.list': {
        workspaces: [{ id: 'ws1', kind: 'folder', name: 'Game', path: ws, branch: null, hostId: 'local' }],
        truncated: false
      },
      'statusBar.update': { ok: true },
      'notifications.show': { delivered: true }
    }
  })
  return { root, ws, host }
}

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 8000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await read()
    if (ok(v) || Date.now() > end) return v
    await new Promise((r) => setTimeout(r, 50))
  }
}

test('finds the project, the managed Rojo, and serves, builds and stops', async () => {
  if (!posix) return // the fake rojo is a shell script
  const { root, ws, host } = await setup()
  const worker = await mountWorker(main, { host })
  try {
    const state = await until(
      () => worker.request('state.get', {}),
      (s: State) => !s.rojo.detecting && !!s.rojo.active
    )
    assert.equal(state.workspace?.path, ws)
    assert.deepEqual(state.projects.map((p) => [p.rel, p.name, p.kind]), [['default.project.json', 'demo', 'place']])
    assert.equal(state.rojo.active?.version, '7.7.1')
    assert.equal(state.rojo.active?.source, 'managed')
    assert.equal(state.prefs.port, 34872)
    assert.equal(state.prefs.buildOutput, 'build/demo.rbxl')

    const inspection = await worker.request('project.inspect', { path: join(ws, 'default.project.json') })
    assert.deepEqual(inspection.issues, [])
    assert.equal(inspection.tree?.children?.[0].children?.[0].className, 'Script')

    const port = 30000 + Math.floor(Math.random() * 20000)
    const started = await worker.request('serve.start', { path: join(ws, 'default.project.json'), host: 'localhost', port })
    assert.ok(started.ok, started.message)
    const running = await until(
      () => worker.request('state.get', {}),
      (s: State) => s.jobs.some((j) => j.kind === 'serve' && j.status === 'running')
    )
    const serve = running.jobs.find((j) => j.kind === 'serve')
    assert.equal(serve?.status, 'running')
    assert.equal(serve?.port, port)
    assert.match(serve?.command ?? '', /serve .*--address 127\.0\.0\.1 --port \d+ --color never$/)
    assert.ok(worker.host.callsOf('statusBar.update').length > 0)
    await new Promise((r) => setTimeout(r, 300))
    assert.ok(worker.posts.some((p) => p.event === 'state'), 'state is posted to panels')
    const logPosts = worker.posts.filter((p) => p.event === 'log') as { payload: { id: string; lines: string[] } }[]
    assert.ok(logPosts.some((p) => p.payload.lines.includes('Rojo server listening:')), 'output is streamed to panels')

    // A second start of the same project is refused.
    const again = await worker.request('serve.start', { path: join(ws, 'default.project.json'), host: 'localhost', port })
    assert.equal(again.ok, false)

    const built = await worker.request('build.run', { path: join(ws, 'default.project.json'), output: 'build/demo.rbxl', watch: false })
    assert.ok(built.ok, built.message)
    const done = await until(
      () => worker.request('state.get', {}),
      (s: State) => s.jobs.some((j) => j.kind === 'build' && j.status === 'done' && !!j.message?.startsWith('Wrote'))
    )
    const build = done.jobs.find((j) => j.kind === 'build')
    assert.equal(build?.message, 'Wrote demo.rbxl (4 B).')
    assert.equal(await readFile(join(ws, 'build', 'demo.rbxl'), 'utf-8'), 'RBXL')
    const logs = await worker.request('job.logs', { id: build?.id ?? '' })
    assert.ok(logs.lines.some((l) => l.startsWith('Built project to')))

    const wrongKind = await worker.request('build.run', { path: join(ws, 'default.project.json'), output: 'x.rbxm', watch: false })
    assert.equal(wrongKind.ok, false)

    const stopped = await worker.request('job.stop', { id: serve?.id ?? '' })
    assert.ok(stopped.ok)
    const after = await until(
      () => worker.request('state.get', {}),
      (s: State) => s.jobs.some((j) => j.kind === 'serve' && j.status === 'stopped')
    )
    assert.equal(after.jobs.find((j) => j.kind === 'serve')?.status, 'stopped')
    assert.equal(worker.host.callsOf('notifications.show').length, 0)
    assert.deepEqual(worker.refusals, [])
  } finally {
    await worker.deactivate()
    await rm(root, { recursive: true, force: true })
  }
})

test('reports a busy port with a free one to use instead', async () => {
  if (!posix) return
  const { root, ws, host } = await setup()
  const worker = await mountWorker(main, { host })
  const { createServer } = await import('node:net')
  const blocker = createServer()
  const port = 30000 + Math.floor(Math.random() * 20000)
  await new Promise<void>((resolve) => blocker.once('listening', () => resolve()).listen({ port, host: '127.0.0.1' }))
  try {
    await until(() => worker.request('state.get', {}), (s: State) => !!s.rojo.active)
    const check = await worker.request('port.check', { host: 'localhost', port })
    assert.equal(check.free, false)
    assert.ok(check.suggestion && check.suggestion > port)
    const result = await worker.request('serve.start', { path: join(ws, 'default.project.json'), host: 'localhost', port })
    assert.equal(result.ok, false)
    const state = await worker.request('state.get', {})
    const job = state.jobs.find((j) => j.id === result.jobId)
    assert.equal(job?.status, 'error')
    assert.match(job?.message ?? '', new RegExp(`Port ${port} is already in use`))
    assert.ok(job?.suggestedPort)
  } finally {
    blocker.close()
    await worker.deactivate()
    await rm(root, { recursive: true, force: true })
  }
})

test('explains what is missing when there is no Rojo and no workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rojo-studio-empty-'))
  process.env.XDG_DATA_HOME = join(root, 'data')
  process.env.HOME = root
  const savedPath = process.env.PATH
  process.env.PATH = join(root, 'bin')
  const host = mockHost({ settings: { checkForUpdates: false }, results: { 'workspace.readContext': null, 'statusBar.update': { ok: true } } })
  const worker = await mountWorker(main, { host })
  try {
    const state = await until(() => worker.request('state.get', {}), (s: State) => !s.rojo.detecting)
    assert.equal(state.workspace, null)
    assert.deepEqual(state.projects, [])
    assert.equal(state.rojo.active, null)
    assert.equal(await worker.command('rojo-studio.build'), 'Rojo Studio: no *.project.json in this workspace.')
    const init = await worker.request('init.run', { folder: join(root, 'new'), kind: 'place', git: false })
    assert.equal(init.ok, false)
    assert.match(init.message, /not installed/)
  } finally {
    process.env.PATH = savedPath
    await worker.deactivate()
    await rm(root, { recursive: true, force: true })
  }
})
