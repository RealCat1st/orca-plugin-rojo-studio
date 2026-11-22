// End-to-end test with the real Rojo, through the worker exactly as the panel drives it:
// download the latest release from GitHub (SHA-256 checked, unpacked by the plugin's own ZIP
// reader), `rojo init`, `rojo serve` on a free port (probed over HTTP), `rojo build`,
// `rojo sourcemap`, the Studio plugin file, then stop. Needs the network, so it runs only with
// ROJO_STUDIO_E2E=1:  ROJO_STUDIO_E2E=1 orca plugin test .
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as main from './worker'
import type { State } from './protocol'
import { decodeMsgpack } from './core/msgpack'
import { countClients } from './net'

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms: number): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await read()
    if (ok(v) || Date.now() > end) return v
    await new Promise((r) => setTimeout(r, 100))
  }
}

test('real Rojo: install, init, serve, build, sourcemap, stop', async () => {
  if (process.env.ROJO_STUDIO_E2E !== '1') return
  const root = await mkdtemp(join(tmpdir(), 'rojo-studio-e2e-'))
  const ws = join(root, 'workspace')
  await mkdir(ws, { recursive: true })
  process.env.XDG_DATA_HOME = join(root, 'data')
  const host = mockHost({
    settings: { checkForUpdates: false },
    results: {
      'workspace.readContext': { workspaceId: 'ws1', branch: 'main', displayName: 'E2E', terminals: [] },
      'workspace.list': { workspaces: [{ id: 'ws1', kind: 'folder', name: 'E2E', path: ws, branch: null, hostId: 'local' }], truncated: false },
      'statusBar.update': { ok: true },
      'notifications.show': { delivered: true }
    }
  })
  const worker = await mountWorker(main, { host })
  const log = (m: string) => console.log(`  e2e: ${m}`)
  try {
    const { releases, error } = await worker.request('rojo.releases', { force: true })
    assert.equal(error, null)
    const latest = releases.find((r) => r.assetName && !r.prerelease)
    assert.ok(latest, 'a release for this machine')
    log(`latest ${latest.tag} (${latest.assetName}, ${latest.assetSize} bytes)`)

    const started = await worker.request('rojo.install', { tag: latest.tag })
    assert.ok(started.ok, started.message)
    const installed = await until(
      () => worker.request('state.get', {}),
      (s: State) => s.install === null && s.rojo.active?.source === 'managed',
      180000
    )
    assert.equal(installed.rojo.active?.version, latest.version)
    log(`installed ${installed.rojo.active?.path}`)

    const init = await worker.request('init.run', { folder: 'demo-place', kind: 'place', git: false })
    assert.ok(init.ok, init.message)
    const created = await until(
      () => worker.request('state.get', {}),
      (s: State) => s.projects.some((p) => p.rel === 'demo-place/default.project.json') && !!s.jobs.find((j) => j.kind === 'init' && j.status === 'done'),
      30000
    )
    const project = created.projects.find((p) => p.rel === 'demo-place/default.project.json')
    assert.ok(project)
    assert.equal(created.selectedProject, project.path)
    assert.equal(project.kind, 'place')
    log(`created ${project.path}`)

    const inspection = await worker.request('project.inspect', { path: project.path })
    assert.deepEqual(inspection.issues.filter((i) => i.severity !== 'info'), [])
    log(`tree: ${inspection.stats.instances} instances, ${inspection.stats.scripts} scripts, ${inspection.stats.mapped} $path`)

    const port = 35000 + Math.floor(Math.random() * 10000)
    const served = await worker.request('serve.start', { path: project.path, host: 'localhost', port })
    assert.ok(served.ok, served.message)
    const running = await until(
      () => worker.request('state.get', {}),
      (s: State) => s.jobs.some((j) => j.kind === 'serve' && (j.status === 'running' || j.status === 'error')),
      20000
    )
    const serve = running.jobs.find((j) => j.kind === 'serve')
    assert.equal(serve?.status, 'running', serve?.message ?? '')
    const response = await fetch(`http://127.0.0.1:${port}/api/rojo`)
    const info = decodeMsgpack(new Uint8Array(await response.arrayBuffer())) as Record<string, unknown>
    assert.equal(info.projectName, 'demo-place')
    assert.equal(info.serverVersion, latest.version)
    const clients = await countClients(port)
    log(`serving on :${port}; /api/rojo says ${String(info.projectName)} (Rojo ${String(info.serverVersion)}); open connections from ${clients} host(s)`)

    const busy = await worker.request('port.check', { host: 'localhost', port })
    assert.equal(busy.free, false)
    assert.match(busy.holder ?? '', /served by Rojo Studio/)

    const built = await worker.request('build.run', { path: project.path, output: 'build/demo.rbxl', watch: false })
    assert.ok(built.ok, built.message)
    await until(() => worker.request('state.get', {}), (s: State) => s.jobs.some((j) => j.kind === 'build' && j.status !== 'running' && j.status !== 'starting'), 30000)
    const rbxl = await stat(join(ws, 'demo-place', 'build', 'demo.rbxl'))
    assert.ok(rbxl.size > 100)
    log(`built demo.rbxl (${rbxl.size} bytes)`)

    const sm = await worker.request('sourcemap.run', { path: project.path, output: 'sourcemap.json', includeNonScripts: false, absolute: false, watch: false })
    assert.ok(sm.ok, sm.message)
    await until(() => worker.request('state.get', {}), (s: State) => s.jobs.some((j) => j.kind === 'sourcemap' && j.status === 'done'), 30000)
    const map = JSON.parse(await readFile(join(ws, 'demo-place', 'sourcemap.json'), 'utf-8')) as { name: string; className: string }
    assert.equal(map.name, 'demo-place')
    assert.equal(map.className, 'DataModel')
    log('sourcemap.json written')

    const rbxm = await worker.request('studio.rbxm', { offset: 0 })
    assert.equal(rbxm.error, null)
    assert.ok(rbxm.total > 100000)
    log(`Rojo.rbxm: ${rbxm.total} bytes, first chunk ${rbxm.base64.length} base64 chars`)

    const stop = await worker.request('job.stop', { id: serve?.id ?? '' })
    assert.ok(stop.ok)
    const after = await until(() => worker.request('state.get', {}), (s: State) => s.jobs.some((j) => j.kind === 'serve' && j.status === 'stopped'), 10000)
    assert.equal(after.jobs.find((j) => j.kind === 'serve')?.status, 'stopped')
    let refused = false
    try {
      await fetch(`http://127.0.0.1:${port}/api/rojo`)
    } catch {
      refused = true
    }
    assert.ok(refused, 'the server is gone after stop')
    log('stopped; port closed')
    assert.deepEqual(worker.refusals, [])
  } finally {
    await worker.deactivate()
    await rm(root, { recursive: true, force: true })
  }
})
