// Live output of one job. The element is owned here and appended to directly (the virtual DOM
// only places it), so thousands of lines stream without re-rendering the panel.
import type { Job } from '../protocol'
import { lineLevel } from '../core/output'

const LIMIT = 3000

export class LogView {
  /** Set by the panel: loads a job's full output from the worker. */
  static fetch: (id: string) => Promise<string[]> = async () => []
  private static cache = new Map<string, string[]>()
  private static fetched = new Set<string>()
  private static views = new Set<LogView>()

  readonly el: HTMLDivElement
  filter = ''
  private jobId: string | null = null
  private job: Job | null = null
  private emptyEl: HTMLDivElement

  constructor(readonly id: string) {
    this.el = document.createElement('div')
    this.el.className = 'log'
    this.el.setAttribute('role', 'log')
    this.el.setAttribute('aria-label', 'Output')
    this.el.tabIndex = 0
    this.emptyEl = document.createElement('div')
    this.emptyEl.className = 'log-empty'
    LogView.views.add(this)
    this.redraw()
  }

  /** New lines from the worker, for any job. */
  static ingest(id: string, lines: string[]) {
    const list = LogView.cache.get(id) ?? []
    list.push(...lines)
    if (list.length > LIMIT) list.splice(0, list.length - LIMIT)
    LogView.cache.set(id, list)
    for (const view of LogView.views) if (view.jobId === id) view.appendLines(lines, true)
  }

  /** Forgets jobs the worker no longer lists. */
  jobs(list: readonly Job[]) {
    const ids = new Set(list.map((j) => j.id))
    for (const id of LogView.cache.keys()) {
      if (!ids.has(id)) {
        LogView.cache.delete(id)
        LogView.fetched.delete(id)
      }
    }
  }

  show(jobId: string | null, job: Job | null) {
    this.job = job
    if (jobId === this.jobId) {
      this.updateEmpty()
      return
    }
    this.jobId = jobId
    this.redraw()
    if (jobId && !LogView.fetched.has(jobId)) {
      LogView.fetched.add(jobId)
      void LogView.fetch(jobId).then((lines) => {
        const have = LogView.cache.get(jobId) ?? []
        if (lines.length >= have.length) LogView.cache.set(jobId, lines.slice(-LIMIT))
        if (this.jobId === jobId) this.redraw()
      })
    }
  }

  setFilter(filter: string) {
    this.filter = filter
    const f = filter.toLowerCase()
    for (const child of Array.from(this.el.children)) {
      if (!child.classList.contains('line')) continue
      child.classList.toggle('hidden', !!f && !(child.textContent ?? '').toLowerCase().includes(f))
    }
  }

  text(): string {
    return (this.jobId ? LogView.cache.get(this.jobId) : null)?.join('\n') ?? ''
  }

  private lineEl(line: string, fresh: boolean): HTMLDivElement {
    const div = document.createElement('div')
    const level = line.startsWith('$ ') ? 'cmd' : lineLevel(line)
    div.className = `line ${level}${fresh ? ' fresh' : ''}`
    div.textContent = line || ' '
    if (this.filter && !line.toLowerCase().includes(this.filter.toLowerCase())) div.classList.add('hidden')
    return div
  }

  private nearBottom(): boolean {
    return this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < 40
  }

  private appendLines(lines: string[], fresh: boolean) {
    const stick = this.nearBottom()
    if (this.emptyEl.parentNode) this.emptyEl.remove()
    const fragment = document.createDocumentFragment()
    for (const line of lines) fragment.appendChild(this.lineEl(line, fresh))
    this.el.appendChild(fragment)
    while (this.el.childElementCount > LIMIT) this.el.firstElementChild?.remove()
    if (stick) this.el.scrollTop = this.el.scrollHeight
  }

  private redraw() {
    this.el.replaceChildren()
    const lines = this.jobId ? LogView.cache.get(this.jobId) ?? [] : []
    if (lines.length) this.appendLines(lines, false)
    this.updateEmpty()
    this.el.scrollTop = this.el.scrollHeight
  }

  private updateEmpty() {
    const hasLines = this.el.querySelector('.line') !== null
    if (hasLines) {
      if (this.emptyEl.parentNode) this.emptyEl.remove()
      return
    }
    this.emptyEl.textContent = !this.jobId
      ? 'Output appears here when Rojo runs.'
      : this.job?.runner === 'terminal'
        ? 'Waiting for output from the Orca terminal…'
        : 'Waiting for output…'
    if (!this.emptyEl.parentNode) this.el.appendChild(this.emptyEl)
  }
}
