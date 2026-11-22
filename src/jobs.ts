// Runs Rojo commands and tracks them as jobs: `serve`, `build`, `sourcemap` (once or --watch),
// `init` and `plugin install`. Two runners:
//
// - process: a child process of the worker (the default for workspaces on this machine), with
//   live output, status and exit code;
// - terminal: the command is typed into a new Orca terminal (`terminal.create`), which runs it on
//   the workspace's own host (SSH and other remote workspaces). Output is followed with
//   `terminal.read`, and an exit marker printed after the command gives the exit code.
import { spawn, type ChildProcess } from 'node:child_process'
import type { OrcaWorkerApi } from 'orca/worker'
import type { Job, JobKind } from './protocol'
import {
  LineSplitter,
  ServeWatcher,
  commandLine,
  diffTerminalLines,
  errorSummary,
  exitMarkerCode,
  isPortInUse,
  terminalCommand
} from './core/output'
import { childEnv, isWindows } from './system'

export const LOG_LIMIT = 3000

export type JobSpec = {
  kind: JobKind
  title: string
  projectPath: string | null
  projectName: string | null
  cwd: string
  bin: string
  args: string[]
  runner: 'process' | 'terminal'
  workspaceId?: string
  host?: string
  port?: number
  output?: string
}

type Record_ = {
  job: Job
  spec: JobSpec
  logs: string[]
  child?: ChildProcess
  terminalId?: string
  poller?: ReturnType<typeof setInterval>
  lastRead?: string[]
  serve?: ServeWatcher
  stopRequested: boolean
  killTimer?: ReturnType<typeof setTimeout>
}

export type JobHooks = {
  changed(): void
  lines(id: string, lines: string[]): void
  finished(job: Job, logs: readonly string[]): void | Promise<void>
}

const LONG_RUNNING: ReadonlySet<JobKind> = new Set(['serve', 'build-watch', 'sourcemap-watch'])

export function isLongRunning(kind: JobKind): boolean {
  return LONG_RUNNING.has(kind)
}

export function isActive(job: Job): boolean {
  return job.status === 'starting' || job.status === 'running' || job.status === 'stopping'
}

let seq = 0

export class JobManager {
  private readonly records = new Map<string, Record_>()

  constructor(
    private readonly orca: OrcaWorkerApi,
    private readonly hooks: JobHooks
  ) {}

  list(): Job[] {
    return [...this.records.values()].map((r) => r.job).sort((a, b) => b.startedAt - a.startedAt)
  }

  get(id: string): Job | null {
    return this.records.get(id)?.job ?? null
  }

  logs(id: string): string[] {
    return this.records.get(id)?.logs.slice() ?? []
  }

  /** Active job of a kind for a project, if any. */
  find(kind: JobKind, projectPath: string | null): Job | null {
    for (const r of this.records.values()) {
      if (r.job.kind === kind && r.job.projectPath === projectPath && isActive(r.job)) return r.job
    }
    return null
  }

  /** Removes a finished job from the list. */
  dismiss(id: string): boolean {
    const r = this.records.get(id)
    if (!r || isActive(r.job)) return false
    this.records.delete(id)
    this.hooks.changed()
    return true
  }

  /** Keeps the list short: at most `keep` finished jobs. */
  prune(keep = 12) {
    const finished = this.list().filter((j) => !isActive(j))
    for (const job of finished.slice(keep)) this.records.delete(job.id)
  }

  patch(id: string, fields: Partial<Job>) {
    const r = this.records.get(id)
    if (!r) return
    Object.assign(r.job, fields)
    this.hooks.changed()
  }

  /** Records a job that could not start (e.g. its port is taken), without running anything. */
  failed(spec: Omit<JobSpec, 'bin' | 'args' | 'cwd'> & { command: string }, fields: Partial<Job>): Job {
    const id = `j${Date.now().toString(36)}${(++seq).toString(36)}`
    const now = Date.now()
    const job: Job = {
      id,
      kind: spec.kind,
      title: spec.title,
      projectPath: spec.projectPath,
      projectName: spec.projectName,
      command: spec.command,
      runner: spec.runner,
      status: 'error',
      startedAt: now,
      endedAt: now,
      exitCode: null,
      message: null,
      lineCount: 0,
      ...(spec.host !== undefined ? { host: spec.host } : {}),
      ...(spec.port !== undefined ? { port: spec.port } : {}),
      ...fields
    }
    const record: Record_ = { job, spec: { ...spec, bin: '', args: [], cwd: '' }, logs: [], stopRequested: false }
    if (job.message) record.logs.push(job.message)
    job.lineCount = record.logs.length
    this.records.set(id, record)
    this.prune()
    this.hooks.changed()
    return job
  }

  async start(spec: JobSpec): Promise<Job> {
    const id = `j${Date.now().toString(36)}${(++seq).toString(36)}`
    const shown = commandLine(spec.bin, spec.args, isWindows && spec.runner === 'process')
    const job: Job = {
      id,
      kind: spec.kind,
      title: spec.title,
      projectPath: spec.projectPath,
      projectName: spec.projectName,
      command: shown,
      runner: spec.runner,
      status: 'starting',
      startedAt: Date.now(),
      endedAt: null,
      exitCode: null,
      message: null,
      lineCount: 0,
      ...(spec.host !== undefined ? { host: spec.host } : {}),
      ...(spec.port !== undefined ? { port: spec.port } : {}),
      ...(spec.output !== undefined ? { output: spec.output } : {})
    }
    const record: Record_ = { job, spec, logs: [], stopRequested: false }
    if (spec.kind === 'serve') record.serve = new ServeWatcher()
    this.records.set(id, record)
    this.prune()
    this.append(record, [`$ ${shown}`])
    this.hooks.changed()
    if (spec.runner === 'terminal') await this.startTerminal(record)
    else this.startProcess(record)
    return job
  }

  private append(record: Record_, lines: string[]) {
    if (!lines.length) return
    record.logs.push(...lines)
    if (record.logs.length > LOG_LIMIT) record.logs.splice(0, record.logs.length - LOG_LIMIT)
    record.job.lineCount += lines.length
    this.hooks.lines(record.job.id, lines)
    if (record.serve) {
      for (const line of lines) {
        if (record.serve.feed(line)) {
          record.job.status = 'running'
          if (record.serve.port) record.job.port = record.serve.port
          this.hooks.changed()
        }
      }
    }
  }

  private startProcess(record: Record_) {
    const { spec, job } = record
    let child: ChildProcess
    try {
      child = spawn(spec.bin, spec.args, { cwd: spec.cwd, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      this.finish(record, null, error instanceof Error ? error.message : String(error))
      return
    }
    record.child = child
    // A server is "running" once it prints its address (see append); everything else at once.
    if (spec.kind !== 'serve') job.status = 'running'
    const out = new LineSplitter()
    const err = new LineSplitter()
    child.stdout?.on('data', (chunk) => this.append(record, out.push(chunk)))
    child.stderr?.on('data', (chunk) => this.append(record, err.push(chunk)))
    child.on('error', (error) => {
      const message = error.code === 'ENOENT' ? `Rojo was not found at ${spec.bin}.` : error.message
      this.finish(record, null, message)
    })
    child.on('close', (code) => {
      this.append(record, [...out.flush(), ...err.flush()])
      this.finish(record, code, null)
    })
  }

  private async startTerminal(record: Record_) {
    const { spec } = record
    if (!spec.workspaceId) {
      this.finish(record, null, 'No workspace to open a terminal in.')
      return
    }
    try {
      const { terminalId } = await this.orca.host.call('terminal.create', {
        workspaceId: spec.workspaceId,
        title: spec.title,
        command: terminalCommand(spec.cwd, spec.bin, spec.args)
      })
      record.terminalId = terminalId
      if (spec.kind !== 'serve') record.job.status = 'running'
      this.hooks.changed()
    } catch (error) {
      this.finish(record, null, `Could not open an Orca terminal: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    record.poller = setInterval(() => void this.pollTerminal(record), 1000)
  }

  private async pollTerminal(record: Record_) {
    if (!record.terminalId || !isActive(record.job)) return
    try {
      const { lines } = await this.orca.host.call('terminal.read', { terminalId: record.terminalId, maxLines: 400 })
      const fresh = diffTerminalLines(record.lastRead ?? [], lines)
      record.lastRead = lines
      for (const line of fresh) {
        const code = exitMarkerCode(line)
        if (code !== null) {
          this.finish(record, code, null)
          return
        }
      }
      this.append(record, fresh)
    } catch {
      // The terminal was closed by the person.
      this.finish(record, null, record.stopRequested ? null : 'The terminal was closed.')
    }
  }

  private finish(record: Record_, code: number | null, failure: string | null) {
    const { job } = record
    if (!isActive(job)) return
    if (record.poller) clearInterval(record.poller)
    if (record.killTimer) clearTimeout(record.killTimer)
    job.endedAt = Date.now()
    job.exitCode = code
    if (record.stopRequested) {
      job.status = 'stopped'
      job.message = null
    } else if (failure) {
      job.status = 'error'
      job.message = failure
    } else if (code === 0) {
      job.status = isLongRunning(job.kind) ? 'stopped' : 'done'
      job.message = isLongRunning(job.kind) ? 'Rojo exited.' : null
    } else {
      job.status = 'error'
      job.message = errorSummary(record.logs) ?? `Rojo exited with code ${code ?? 'unknown'}.`
    }
    if (job.kind === 'serve') job.clients = 0
    record.child = undefined
    this.hooks.changed()
    void this.hooks.finished(job, record.logs)
  }

  /** True when the job's output says its port was taken. */
  portInUse(id: string): boolean {
    const r = this.records.get(id)
    return !!r && r.logs.some(isPortInUse)
  }

  async stop(id: string): Promise<boolean> {
    const record = this.records.get(id)
    if (!record || !isActive(record.job)) return false
    record.stopRequested = true
    record.job.status = 'stopping'
    this.hooks.changed()
    if (record.child) {
      record.child.kill()
      record.killTimer = setTimeout(() => record.child?.kill('SIGKILL'), 3000)
      return true
    }
    if (record.terminalId) {
      try {
        await this.orca.host.call('terminal.close', { terminalId: record.terminalId })
      } catch {
        /* already gone */
      }
      this.finish(record, null, null)
      return true
    }
    this.finish(record, null, null)
    return true
  }

  async stopAll(): Promise<number> {
    const active = this.list().filter(isActive)
    await Promise.all(active.map((j) => this.stop(j.id)))
    return active.length
  }

  /** Synchronous kill for deactivate: no awaits, the worker is about to stop. */
  killAll() {
    for (const r of this.records.values()) {
      if (r.child && isActive(r.job)) {
        r.stopRequested = true
        r.child.kill()
      }
    }
  }
}
