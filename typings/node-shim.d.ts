// Type-check only: the slice of Node's API the worker uses. There is no @types/node on the build
// machine and Orca's generated typings (.orca/types) ship none. Orca never loads this file; at
// runtime the trusted worker gets the real Node modules (docs/reference/plugin-authoring.md,
// "A worker does not inherit Orca's full environment": the worker is a normal Node process).

declare module 'node:child_process' {
  export type StdioPipe = 'pipe' | 'ignore' | 'inherit'
  export interface SpawnOptions {
    cwd?: string
    env?: Record<string, string | undefined>
    stdio?: [StdioPipe, StdioPipe, StdioPipe]
    windowsHide?: boolean
    shell?: boolean
    detached?: boolean
  }
  export interface Readable {
    on(event: 'data', listener: (chunk: Uint8Array) => void): this
    on(event: 'end', listener: () => void): this
  }
  export interface ChildProcess {
    readonly pid?: number
    readonly exitCode: number | null
    readonly stdout: Readable | null
    readonly stderr: Readable | null
    kill(signal?: string): boolean
    on(event: 'error', listener: (error: Error & { code?: string }) => void): this
    on(event: 'close', listener: (code: number | null, signal: string | null) => void): this
    on(event: 'exit', listener: (code: number | null, signal: string | null) => void): this
  }
  export function spawn(command: string, args: readonly string[], options?: SpawnOptions): ChildProcess
}

declare module 'node:fs/promises' {
  export interface Dirent {
    name: string
    isDirectory(): boolean
    isFile(): boolean
    isSymbolicLink(): boolean
  }
  export interface Stats {
    size: number
    mtimeMs: number
    isFile(): boolean
    isDirectory(): boolean
  }
  export function readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>
  export function readdir(path: string): Promise<string[]>
  export function stat(path: string): Promise<Stats>
  export function readFile(path: string): Promise<Uint8Array>
  export function readFile(path: string, encoding: 'utf-8' | 'utf8'): Promise<string>
  export function writeFile(path: string, data: string | Uint8Array): Promise<void>
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>
  export function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>
  export function rename(from: string, to: string): Promise<void>
  export function chmod(path: string, mode: number): Promise<void>
  export function realpath(path: string): Promise<string>
  export function mkdtemp(prefix: string): Promise<string>
}

declare module 'node:path' {
  export function join(...parts: string[]): string
  export function resolve(...parts: string[]): string
  export function relative(from: string, to: string): string
  export function basename(path: string, suffix?: string): string
  export function dirname(path: string): string
  export function extname(path: string): string
  export function isAbsolute(path: string): boolean
  export function normalize(path: string): string
  export const sep: string
  export const delimiter: string
}

declare module 'node:os' {
  export interface NetworkInterfaceInfo {
    address: string
    family: string | number
    internal: boolean
  }
  export function homedir(): string
  export function tmpdir(): string
  export function platform(): string
  export function arch(): string
  export function networkInterfaces(): Record<string, NetworkInterfaceInfo[] | undefined>
}

declare module 'node:net' {
  export interface Server {
    listen(options: { port: number; host?: string; exclusive?: boolean }): this
    close(callback?: () => void): this
    once(event: 'error', listener: (error: Error & { code?: string }) => void): this
    once(event: 'listening', listener: () => void): this
    unref(): this
  }
  export function createServer(): Server
}

declare module 'node:zlib' {
  export function inflateRawSync(data: Uint8Array): Uint8Array
}

declare module 'node:crypto' {
  export interface Hash {
    update(data: Uint8Array | string): Hash
    digest(encoding: 'hex'): string
  }
  export function createHash(algorithm: 'sha256'): Hash
}

declare const process: {
  readonly env: Record<string, string | undefined>
  readonly platform: string
  readonly arch: string
  readonly pid: number
}

declare module 'node:zlib' {
  export function deflateRawSync(data: Uint8Array): Uint8Array
}

declare module 'node:net' {
  export interface Server {
    listen(options: { port: number; host?: string }): this
  }
}
