// Minimal MessagePack decoder. Rojo 7.7+ answers `GET /api/rojo` with `application/msgpack`
// (older servers send JSON); the plugin reads it to tell whether a busy port belongs to another
// Rojo server and which project it serves. Extension types are skipped (decoded as null).

export class MsgpackError extends Error {}

export function decodeMsgpack(bytes: Uint8Array): unknown {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const decoder = new TextDecoder()
  let at = 0
  const need = (n: number) => {
    if (at + n > bytes.length) throw new MsgpackError('Unexpected end of MessagePack data.')
  }
  const str = (n: number) => {
    need(n)
    const text = decoder.decode(bytes.subarray(at, at + n))
    at += n
    return text
  }
  const bin = (n: number) => {
    need(n)
    const out = bytes.slice(at, at + n)
    at += n
    return out
  }
  const array = (n: number): unknown[] => {
    const out: unknown[] = []
    for (let i = 0; i < n; i++) out.push(read())
    return out
  }
  const map = (n: number): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    for (let i = 0; i < n; i++) {
      const key = read()
      out[String(key)] = read()
    }
    return out
  }
  const ext = (n: number) => {
    need(n + 1)
    at += n + 1
    return null
  }
  function read(): unknown {
    need(1)
    const type = bytes[at++]
    if (type <= 0x7f) return type
    if (type >= 0x80 && type <= 0x8f) return map(type & 0x0f)
    if (type >= 0x90 && type <= 0x9f) return array(type & 0x0f)
    if (type >= 0xa0 && type <= 0xbf) return str(type & 0x1f)
    if (type >= 0xe0) return type - 0x100
    switch (type) {
      case 0xc0:
        return null
      case 0xc2:
        return false
      case 0xc3:
        return true
      case 0xc4: {
        need(1)
        return bin(bytes[at++])
      }
      case 0xc5: {
        need(2)
        const n = view.getUint16(at)
        at += 2
        return bin(n)
      }
      case 0xc6: {
        need(4)
        const n = view.getUint32(at)
        at += 4
        return bin(n)
      }
      case 0xc7: {
        need(1)
        return ext(bytes[at++])
      }
      case 0xc8: {
        need(2)
        const n = view.getUint16(at)
        at += 2
        return ext(n)
      }
      case 0xc9: {
        need(4)
        const n = view.getUint32(at)
        at += 4
        return ext(n)
      }
      case 0xca: {
        need(4)
        const v = view.getFloat32(at)
        at += 4
        return v
      }
      case 0xcb: {
        need(8)
        const v = view.getFloat64(at)
        at += 8
        return v
      }
      case 0xcc: {
        need(1)
        return bytes[at++]
      }
      case 0xcd: {
        need(2)
        const v = view.getUint16(at)
        at += 2
        return v
      }
      case 0xce: {
        need(4)
        const v = view.getUint32(at)
        at += 4
        return v
      }
      case 0xcf: {
        need(8)
        const v = Number(view.getBigUint64(at))
        at += 8
        return v
      }
      case 0xd0: {
        need(1)
        return view.getInt8(at++)
      }
      case 0xd1: {
        need(2)
        const v = view.getInt16(at)
        at += 2
        return v
      }
      case 0xd2: {
        need(4)
        const v = view.getInt32(at)
        at += 4
        return v
      }
      case 0xd3: {
        need(8)
        const v = Number(view.getBigInt64(at))
        at += 8
        return v
      }
      case 0xd4:
        return ext(1)
      case 0xd5:
        return ext(2)
      case 0xd6:
        return ext(4)
      case 0xd7:
        return ext(8)
      case 0xd8:
        return ext(16)
      case 0xd9: {
        need(1)
        return str(bytes[at++])
      }
      case 0xda: {
        need(2)
        const n = view.getUint16(at)
        at += 2
        return str(n)
      }
      case 0xdb: {
        need(4)
        const n = view.getUint32(at)
        at += 4
        return str(n)
      }
      case 0xdc: {
        need(2)
        const n = view.getUint16(at)
        at += 2
        return array(n)
      }
      case 0xdd: {
        need(4)
        const n = view.getUint32(at)
        at += 4
        return array(n)
      }
      case 0xde: {
        need(2)
        const n = view.getUint16(at)
        at += 2
        return map(n)
      }
      case 0xdf: {
        need(4)
        const n = view.getUint32(at)
        at += 4
        return map(n)
      }
      default:
        throw new MsgpackError(`Unknown MessagePack type 0x${type.toString(16)}.`)
    }
  }
  return read()
}
