import { assert, test } from 'orca/testing'
import { decodeMsgpack, MsgpackError } from './msgpack'

function str(s: string): number[] {
  const b = Array.from(new TextEncoder().encode(s))
  return b.length < 32 ? [0xa0 | b.length, ...b] : [0xd9, b.length, ...b]
}

test('decodes a Rojo /api/rojo answer', () => {
  // { sessionId, serverVersion, protocolVersion: 5, projectName, expectedPlaceIds: nil, gameId: nil, placeId: nil }
  const bytes = new Uint8Array([
    0x87,
    ...str('sessionId'), ...str('8ad780a7-ea5b-4cbf-be87-67a4586636ce'),
    ...str('serverVersion'), ...str('7.7.1'),
    ...str('protocolVersion'), 0x05,
    ...str('projectName'), ...str('place1'),
    ...str('expectedPlaceIds'), 0xc0,
    ...str('gameId'), 0xc0,
    ...str('placeId'), 0xcd, 0x30, 0x39
  ])
  assert.deepEqual(decodeMsgpack(bytes), {
    sessionId: '8ad780a7-ea5b-4cbf-be87-67a4586636ce',
    serverVersion: '7.7.1',
    protocolVersion: 5,
    projectName: 'place1',
    expectedPlaceIds: null,
    gameId: null,
    placeId: 12345
  })
})

test('decodes arrays, negatives, floats and booleans', () => {
  assert.deepEqual(decodeMsgpack(new Uint8Array([0x93, 0xff, 0xc3, 0xc2])), [-1, true, false])
  assert.equal(decodeMsgpack(new Uint8Array([0xcb, 0x3f, 0xf8, 0, 0, 0, 0, 0, 0])), 1.5)
  assert.equal(decodeMsgpack(new Uint8Array([0xd0, 0x80])), -128)
  assert.throws(() => decodeMsgpack(new Uint8Array([0xa5, 0x61])), (e) => e instanceof MsgpackError)
})
