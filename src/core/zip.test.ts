import { assert, test } from 'orca/testing'
import { deflateRawSync } from 'node:zlib'
import { ZipError, extractExecutable, isUnsafeEntryName, listZip } from './zip'

/** Builds a ZIP in memory (the format Rojo's release archives use). */
function makeZip(files: { name: string; data: Uint8Array; deflate?: boolean; mode?: number }[]): Uint8Array {
  const enc = new TextEncoder()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const f of files) {
    const name = enc.encode(f.name)
    const body = f.deflate === false ? f.data : deflateRawSync(f.data)
    const method = f.deflate === false ? 0 : 8
    const local = new Uint8Array(30 + name.length + body.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(8, method, true)
    lv.setUint32(18, body.length, true)
    lv.setUint32(22, f.data.length, true)
    lv.setUint16(26, name.length, true)
    local.set(name, 30)
    local.set(body, 30 + name.length)
    const central = new Uint8Array(46 + name.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(10, method, true)
    cv.setUint32(20, body.length, true)
    cv.setUint32(24, f.data.length, true)
    cv.setUint16(28, name.length, true)
    cv.setUint32(38, ((f.mode ?? 0o100755) << 16) >>> 0, true)
    cv.setUint32(42, offset, true)
    central.set(name, 46)
    locals.push(local)
    centrals.push(central)
    offset += local.length
  }
  const dirSize = centrals.reduce((n, c) => n + c.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, files.length, true)
  ev.setUint16(10, files.length, true)
  ev.setUint32(12, dirSize, true)
  ev.setUint32(16, offset, true)
  const all = [...locals, ...centrals, eocd]
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of all) {
    out.set(p, at)
    at += p.length
  }
  return out
}

const payload = new TextEncoder().encode('#!/bin/sh\necho "Rojo 7.7.1"\n'.repeat(50))

test('extracts the executable from a deflated archive', () => {
  const zip = makeZip([{ name: 'README.md', data: new TextEncoder().encode('hi') }, { name: 'rojo', data: payload }])
  const entries = listZip(zip)
  assert.deepEqual(entries.map((e) => e.name), ['README.md', 'rojo'])
  assert.equal(entries[1].mode, 0o100755)
  const { name, data } = extractExecutable(zip, ['rojo', 'rojo.exe'])
  assert.equal(name, 'rojo')
  assert.deepEqual(Array.from(data), Array.from(payload))
})

test('extracts stored entries and nested Windows names', () => {
  const zip = makeZip([{ name: 'bin/rojo.exe', data: payload, deflate: false }])
  assert.equal(extractExecutable(zip, ['rojo.exe']).data.length, payload.length)
})

test('refuses archives without rojo, unsafe names and garbage', () => {
  assert.throws(() => extractExecutable(makeZip([{ name: 'other', data: payload }]), ['rojo']), (e) => e instanceof ZipError)
  assert.throws(() => extractExecutable(makeZip([{ name: '../rojo', data: payload }]), ['rojo']), (e) => e instanceof ZipError)
  assert.throws(() => listZip(new Uint8Array(100)), (e) => e instanceof ZipError)
  assert.ok(isUnsafeEntryName('../x'))
  assert.ok(isUnsafeEntryName('/etc/passwd'))
  assert.ok(isUnsafeEntryName('C:\\x'))
  assert.ok(!isUnsafeEntryName('rojo-7.7.1/rojo'))
})
