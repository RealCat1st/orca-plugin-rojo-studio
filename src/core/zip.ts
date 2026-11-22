// A small, dependency-free ZIP reader: enough to unpack Rojo's release archives (one binary,
// deflate or stored). Node has no built-in unzip, and `unzip` is not installed everywhere, so the
// worker reads the archive itself. ZIP64, encryption and multi-disk archives are refused.
import { inflateRawSync } from 'node:zlib'

export type ZipEntry = {
  name: string
  method: number
  compressedSize: number
  size: number
  /** Unix mode from the "external attributes", or 0 when the archive was made on Windows. */
  mode: number
  isDirectory: boolean
  offset: number
}

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50

export class ZipError extends Error {}

function u16(view: DataView, at: number): number {
  return view.getUint16(at, true)
}
function u32(view: DataView, at: number): number {
  return view.getUint32(at, true)
}

/** Reads the central directory. Throws ZipError for anything it cannot handle safely. */
export function listZip(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // The end-of-central-directory record is in the last 22 + 65535 bytes (comment up to 64 KiB).
  let eocd = -1
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) {
    if (u32(view, at) === EOCD) {
      eocd = at
      break
    }
  }
  if (eocd < 0) throw new ZipError('Not a ZIP archive (no end-of-central-directory record).')
  const count = u16(view, eocd + 10)
  const dirSize = u32(view, eocd + 12)
  const dirOffset = u32(view, eocd + 16)
  if (count === 0xffff || dirOffset === 0xffffffff) throw new ZipError('ZIP64 archives are not supported.')
  if (dirOffset + dirSize > bytes.length) throw new ZipError('Truncated ZIP archive.')
  const decoder = new TextDecoder()
  const entries: ZipEntry[] = []
  let at = dirOffset
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || u32(view, at) !== CENTRAL) throw new ZipError('Corrupt ZIP central directory.')
    const flags = u16(view, at + 8)
    const method = u16(view, at + 10)
    const compressedSize = u32(view, at + 20)
    const size = u32(view, at + 24)
    const nameLength = u16(view, at + 28)
    const extraLength = u16(view, at + 30)
    const commentLength = u16(view, at + 32)
    const external = u32(view, at + 38)
    const offset = u32(view, at + 42)
    if (flags & 0x1) throw new ZipError('Encrypted ZIP entries are not supported.')
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength))
    entries.push({
      name,
      method,
      compressedSize,
      size,
      mode: (external >>> 16) & 0xffff,
      isDirectory: name.endsWith('/'),
      offset
    })
    at += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** True when an entry name could escape the folder it is unpacked into ("zip slip"). */
export function isUnsafeEntryName(name: string): boolean {
  if (name.startsWith('/') || name.startsWith('\\') || /^[a-zA-Z]:/.test(name)) return true
  return name.split(/[\\/]/).some((part) => part === '..')
}

/** Inflates one entry. */
export function readEntry(bytes: Uint8Array, entry: ZipEntry): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const at = entry.offset
  if (at + 30 > bytes.length || u32(view, at) !== LOCAL) throw new ZipError(`Corrupt local header for ${entry.name}.`)
  const start = at + 30 + u16(view, at + 26) + u16(view, at + 28)
  const end = start + entry.compressedSize
  if (end > bytes.length) throw new ZipError(`Truncated data for ${entry.name}.`)
  const raw = bytes.subarray(start, end)
  let data: Uint8Array
  if (entry.method === 0) data = raw.slice()
  else if (entry.method === 8) data = inflateRawSync(raw)
  else throw new ZipError(`Unsupported compression method ${entry.method} for ${entry.name}.`)
  if (data.length !== entry.size) throw new ZipError(`Size mismatch for ${entry.name}.`)
  return data
}

/**
 * Finds the Rojo executable in a release archive (`rojo` or `rojo.exe`, at any depth) and returns
 * its bytes.
 */
export function extractExecutable(bytes: Uint8Array, names: readonly string[]): { name: string; data: Uint8Array } {
  const entries = listZip(bytes)
  for (const entry of entries) {
    if (entry.isDirectory || isUnsafeEntryName(entry.name)) continue
    const base = entry.name.split('/').pop() ?? ''
    if (names.includes(base.toLowerCase())) return { name: base, data: readEntry(bytes, entry) }
  }
  throw new ZipError(`The archive has no ${names.join(' or ')} (found: ${entries.map((e) => e.name).join(', ') || 'nothing'}).`)
}
