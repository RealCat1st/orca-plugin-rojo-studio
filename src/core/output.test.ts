import { assert, test } from 'orca/testing'
import {
  LineSplitter,
  ServeWatcher,
  commandLine,
  diffTerminalLines,
  distinctHosts,
  errorSummary,
  exitMarkerCode,
  isPortInUse,
  lineLevel,
  parseNetstat,
  parseProcNetTcp,
  stripAnsi,
  terminalCommand
} from './output'

test('detects the listening block of rojo serve', () => {
  const w = new ServeWatcher()
  const lines = ['Rojo server listening:', '  Address: localhost', '  Port:    34990', '', 'Visit http://localhost:34990/ in your browser for more information.']
  const hits = lines.map((l) => w.feed(l))
  assert.deepEqual(hits, [false, false, true, false, false])
  assert.equal(w.address, 'localhost')
  assert.equal(w.port, 34990)
})

test('summarises Rojo errors and port conflicts', () => {
  const log = [
    '[ERROR rojo] Could not start the Rojo server on 127.0.0.1:34872.',
    '        The address may already be in use or reserved. Another Rojo server might already be running.',
    '        Caused by:',
    '            0: error creating server listener: Address already in use (os error 98)'
  ]
  assert.match(errorSummary(log) ?? '', /^Could not start the Rojo server on 127\.0\.0\.1:34872\. The address may already be in use/)
  assert.ok(log.some(isPortInUse))
  assert.ok(isPortInUse('Only one usage of each socket address is normally permitted. (os error 10048)'))
  assert.ok(!isPortInUse('Building project'))
  assert.equal(errorSummary(['Building project', 'Built project to out.rbxl']), null)
  assert.equal(lineLevel('[WARN librojo] x'), 'warn')
  assert.equal(lineLevel('[ERROR rojo] x'), 'error')
  assert.equal(lineLevel('[TRACE x] y'), 'debug')
})

test('splits streamed output into lines and strips colours', () => {
  const s = new LineSplitter()
  const enc = new TextEncoder()
  assert.deepEqual(s.push(enc.encode('Rojo server lis')), [])
  assert.deepEqual(s.push(enc.encode('tening:\r\n  Port: 1\n\u001b[31mred\u001b[0m')), ['Rojo server listening:', '  Port: 1'])
  assert.deepEqual(s.flush(), ['red'])
  assert.equal(stripAnsi('\u001b[1;32mok\u001b[0m'), 'ok')
})

test('counts connections from /proc/net/tcp', () => {
  const text = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 0100007F:8836 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1',
    '   1: 0100007F:8836 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 2',
    '   2: 0100007F:8836 0100007F:C351 01 00000000:00000000 00:00000000 00000000  1000        0 3',
    '   3: 0100007F:C350 0100007F:8836 01 00000000:00000000 00:00000000 00000000  1000        0 4',
    '   4: 0F02000A:8836 6402000A:D000 01 00000000:00000000 00:00000000 00000000  1000        0 5'
  ].join('\n')
  const remotes = parseProcNetTcp(text, 0x8836)
  assert.deepEqual(remotes, ['127.0.0.1', '127.0.0.1', '10.0.2.100'])
  assert.equal(distinctHosts(remotes), 2)
})

test('counts connections from netstat on Windows and macOS', () => {
  const win = [
    '  Proto  Local Address          Foreign Address        State',
    '  TCP    0.0.0.0:34872          0.0.0.0:0              LISTENING',
    '  TCP    127.0.0.1:34872        127.0.0.1:52011        ESTABLISHED',
    '  TCP    127.0.0.1:52011        127.0.0.1:34872        ESTABLISHED',
    '  TCP    [::1]:34872            [::1]:52020            ESTABLISHED'
  ].join('\r\n')
  assert.deepEqual(parseNetstat(win, 34872), ['127.0.0.1', '::1'])
  const mac = [
    'Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)',
    'tcp4       0      0  127.0.0.1.34872        127.0.0.1.60001        ESTABLISHED',
    'tcp4       0      0  127.0.0.1.60001        127.0.0.1.34872        ESTABLISHED',
    'tcp4       0      0  *.34872                *.*                    LISTEN'
  ].join('\n')
  assert.deepEqual(parseNetstat(mac, 34872), ['127.0.0.1'])
})

test('follows an Orca terminal between reads', () => {
  assert.deepEqual(diffTerminalLines([], ['a', 'b']), ['a', 'b'])
  assert.deepEqual(diffTerminalLines(['a', 'b'], ['a', 'b', 'c', '']), ['c'])
  assert.deepEqual(diffTerminalLines(['x', 'a', 'b'], ['a', 'b', 'c', 'd']), ['c', 'd'])
  assert.deepEqual(diffTerminalLines(['a', 'b', 'c'], ['a', 'b', 'c']), [])
  assert.equal(exitMarkerCode('[rojo-studio] exited with 1'), 1)
  assert.equal(exitMarkerCode(`$ cd x && rojo build; printf '\\n[rojo-studio] exited with %s\\n' "$?"`), null)
  const cmd = terminalCommand('/home/me/My Game', 'rojo', ['serve', 'default.project.json', '--port', '34872'])
  assert.equal(cmd, `cd '/home/me/My Game' && rojo serve default.project.json --port 34872; printf '\\n[rojo-studio] exited with %s\\n' "$?"`)
  assert.equal(commandLine('C:\\Program Files\\rojo.exe', ['serve'], true), '"C:\\Program Files\\rojo.exe" serve')
  assert.equal(commandLine('/opt/rojo', ["it's"], false), `/opt/rojo 'it'\\''s'`)
})
