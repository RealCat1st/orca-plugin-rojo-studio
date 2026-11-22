// Reading what Rojo prints, and what the OS reports about open connections. Pure functions.

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007|\u001b[()][0-9A-Za-z]/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}

/** Splits a byte stream into lines, keeping a partial last line until it completes. */
export class LineSplitter {
  private rest = ''
  private readonly decoder = new TextDecoder()
  push(chunk: Uint8Array | string): string[] {
    const text = this.rest + (typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true }))
    const parts = text.split(/\r?\n|\r(?!\n)/)
    this.rest = parts.pop() ?? ''
    return parts.map(stripAnsi)
  }
  flush(): string[] {
    const last = this.rest
    this.rest = ''
    return last ? [stripAnsi(last)] : []
  }
}

/**
 * Follows `rojo serve` output and reports when the server is up. Rojo 7 prints:
 *
 *     Rojo server listening:
 *       Address: localhost
 *       Port:    34872
 */
export class ServeWatcher {
  private inBlock = false
  address: string | null = null
  port: number | null = null
  listening = false

  /** Returns true once, on the line that completes the "listening" block. */
  feed(line: string): boolean {
    const text = line.trim()
    if (/^Rojo server listening/i.test(text)) {
      this.inBlock = true
      return false
    }
    if (!this.inBlock) return false
    const address = /^Address:\s*(\S+)/i.exec(text)
    if (address) this.address = address[1]
    const port = /^Port:\s*(\d+)/i.exec(text)
    if (port) {
      this.port = Number(port[1])
      this.inBlock = false
      if (!this.listening) {
        this.listening = true
        return true
      }
    }
    return false
  }
}

export function isPortInUse(text: string): boolean {
  return /address (is )?already in use|address may already be in use|os error (98|48|10048)\b|EADDRINUSE/i.test(text)
}

/**
 * The first meaningful line of a Rojo error, e.g.
 * `[ERROR rojo] Rojo project referred to a file using $path that could not be turned …`.
 */
export function errorSummary(lines: readonly string[]): string | null {
  for (let i = 0; i < lines.length; i++) {
    const match = /^\[ERROR[^\]]*\]\s*(.*)$/.exec(lines[i].trim())
    if (!match) continue
    let text = match[1].trim()
    // Rojo wraps long messages onto indented lines; join the first continuation.
    const next = lines[i + 1]?.trim()
    if (next && !next.startsWith('[') && !/^caused by/i.test(next) && text.length < 160) text = `${text} ${next}`
    return text.slice(0, 300) || null
  }
  const fallback = [...lines].reverse().find((line) => /error|failed|panicked/i.test(line))
  return fallback ? fallback.trim().slice(0, 300) : null
}

export type LineLevel = 'error' | 'warn' | 'info' | 'debug'

export function lineLevel(line: string): LineLevel {
  if (/^\s*\[(ERROR|FATAL)/.test(line) || /^error:/i.test(line.trim())) return 'error'
  if (/^\s*\[WARN/.test(line)) return 'warn'
  if (/^\s*\[(DEBUG|TRACE)/.test(line)) return 'debug'
  return 'info'
}

// ---------------------------------------------------------------------------------------------
// Connected clients
// ---------------------------------------------------------------------------------------------

function hexToIpv4(hex: string): string {
  // /proc/net/tcp stores the address as a little-endian 32-bit hex number.
  const n = parseInt(hex, 16)
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff].join('.')
}

/**
 * Remote hosts with an ESTABLISHED connection to `port`, from Linux `/proc/net/tcp` or
 * `/proc/net/tcp6` text. Returns remote IPs (IPv6 as hex), one per connection.
 */
export function parseProcNetTcp(text: string, port: number): string[] {
  const out: string[] = []
  for (const line of text.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 4) continue
    const [localAddr, localPort] = cols[1].split(':')
    const [remoteAddr] = cols[2].split(':')
    if (cols[3] !== '01' || parseInt(localPort, 16) !== port) continue
    out.push(remoteAddr.length === 8 ? hexToIpv4(remoteAddr) : remoteAddr)
    void localAddr
  }
  return out
}

/**
 * The same from `netstat -an` on Windows (`TCP 127.0.0.1:34872 127.0.0.1:5000 ESTABLISHED`) or
 * macOS (`tcp4 0 0 127.0.0.1.34872 127.0.0.1.5000 ESTABLISHED`).
 */
export function parseNetstat(text: string, port: number): string[] {
  const out: string[] = []
  const split = (endpoint: string): [string, number] => {
    const m = /^(.*)[:.](\d+)$/.exec(endpoint)
    return m ? [m[1].replace(/^\[|\]$/g, ''), Number(m[2])] : [endpoint, -1]
  }
  for (const line of text.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 4 || !/ESTABLISHED/i.test(line) || !/^tcp/i.test(cols[0])) continue
    const isMac = cols.length >= 6 && /^\d+$/.test(cols[1])
    const local = isMac ? cols[3] : cols[1]
    const remote = isMac ? cols[4] : cols[2]
    const [, localPort] = split(local)
    if (localPort !== port) continue
    out.push(split(remote)[0])
  }
  return out
}

/** Distinct remote hosts. */
export function distinctHosts(remotes: readonly string[]): number {
  return new Set(remotes).size
}

// ---------------------------------------------------------------------------------------------
// Command lines
// ---------------------------------------------------------------------------------------------

/** Quotes one argument for a POSIX shell (used for the Orca-terminal runner and "copy command"). */
export function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

/** Quotes one argument for display on Windows (cmd/PowerShell both accept double quotes). */
export function windowsQuote(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(arg)) return arg
  return `"${arg.replace(/"/g, '\\"')}"`
}

export function commandLine(bin: string, args: readonly string[], windows: boolean): string {
  const quote = windows ? windowsQuote : shellQuote
  return [bin, ...args].map(quote).join(' ')
}

// ---------------------------------------------------------------------------------------------
// Orca-terminal runner
// ---------------------------------------------------------------------------------------------

/** Printed after the command in an Orca terminal, so the plugin learns the exit code. */
export const EXIT_MARKER = '[rojo-studio] exited with'

export function exitMarkerCode(line: string): number | null {
  // Only the printed line counts, not the echo of the typed command (which contains `%s`).
  const match = /^\s*\[rojo-studio\] exited with (-?\d+)\s*$/.exec(line)
  return match ? Number(match[1]) : null
}

function trimTrailingBlank(lines: readonly string[]): string[] {
  let end = lines.length
  while (end > 0 && lines[end - 1].trim() === '') end--
  return lines.slice(0, end)
}

/**
 * New lines between two reads of a terminal's newest output (`terminal.read` returns the last N
 * lines, not a stream). Anchors on the last lines seen before; falls back to everything.
 */
export function diffTerminalLines(previous: readonly string[], next: readonly string[]): string[] {
  const prev = trimTrailingBlank(previous)
  const cur = trimTrailingBlank(next)
  if (!prev.length) return cur
  for (let k = Math.min(prev.length, 6); k >= 1; k--) {
    const tail = prev.slice(-k)
    for (let i = cur.length - k; i >= 0; i--) {
      let same = true
      for (let j = 0; j < k; j++) {
        if (cur[i + j] !== tail[j]) {
          same = false
          break
        }
      }
      if (same) return cur.slice(i + k)
    }
  }
  return cur
}

/** The POSIX shell line typed into an Orca terminal for a job. */
export function terminalCommand(cwd: string, bin: string, args: readonly string[]): string {
  return `cd ${shellQuote(cwd)} && ${commandLine(bin, args, false)}; printf '\\n${EXIT_MARKER} %s\\n' "$?"`
}
