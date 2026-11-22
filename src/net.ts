// Ports and connections: is a port free, who holds it, a free one to suggest, how many Studio
// clients are connected, and this machine's LAN addresses (for 0.0.0.0 servers).
import { createServer } from 'node:net'
import { readFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { decodeMsgpack } from './core/msgpack'
import { distinctHosts, parseNetstat, parseProcNetTcp } from './core/output'
import { run } from './system'

export type BindHost = 'localhost' | '0.0.0.0'

/** The address Rojo is told to bind. `localhost` → 127.0.0.1, as Rojo's own default. */
export function bindAddress(host: BindHost): string {
  return host === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1'
}

export function isPortFree(host: BindHost, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    try {
      server.listen({ port, host: bindAddress(host), exclusive: true })
    } catch {
      resolve(false)
    }
  })
}

export async function findFreePort(host: BindHost, from: number, skip: ReadonlySet<number> = new Set()): Promise<number | null> {
  for (let port = from + 1; port <= Math.min(65535, from + 60); port++) {
    if (!skip.has(port) && (await isPortFree(host, port))) return port
  }
  return null
}

/** If a Rojo server answers on the port, its project name and version ("MyGame (Rojo 7.7.1)"). */
export async function probeRojo(port: number, timeoutMs = 1500): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/rojo`, { signal: controller.signal })
    if (!response.ok) return null
    const type = response.headers.get('content-type') ?? ''
    const bytes = new Uint8Array(await response.arrayBuffer())
    const info = (type.includes('json') ? JSON.parse(new TextDecoder().decode(bytes)) : decodeMsgpack(bytes)) as Record<string, unknown>
    if (!info || typeof info !== 'object' || !('serverVersion' in info)) return null
    const name = typeof info.projectName === 'string' ? info.projectName : 'a Rojo project'
    return `${name} (Rojo ${String(info.serverVersion)})`
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Distinct remote hosts with an open connection to the port; null when the OS cannot tell. */
export async function countClients(port: number): Promise<number | null> {
  try {
    if (process.platform === 'linux') {
      const texts = await Promise.all(['/proc/net/tcp', '/proc/net/tcp6'].map((f) => readFile(f, 'utf-8').catch(() => '')))
      return distinctHosts(texts.flatMap((t) => parseProcNetTcp(t, port)))
    }
    const args = process.platform === 'win32' ? ['-an', '-p', 'TCP'] : ['-an', '-p', 'tcp']
    const result = await run('netstat', args, { timeoutMs: 4000 })
    if (result.code !== 0) return null
    return distinctHosts(parseNetstat(result.stdout, port))
  } catch {
    return null
  }
}

export function lanAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const info of list ?? []) {
      if (!info.internal && (info.family === 'IPv4' || info.family === 4)) out.push(info.address)
    }
  }
  return out.slice(0, 6)
}
