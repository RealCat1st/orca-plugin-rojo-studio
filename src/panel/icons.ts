// Inline stroke icons (24×24 grid, drawn for this plugin). They use currentColor, so they follow
// the theme and the text colour around them.
import { h, type VElement } from './vdom'

const PATHS: Record<string, string[]> = {
  play: ['M7 4.5v15l12-7.5z'],
  stop: ['M7 7h10v10H7z'],
  hammer: ['M14 4l6 6', 'M17 7l-9.5 9.5a2.1 2.1 0 0 1-3-3L14 4', 'M12 4h5'],
  map: ['M9 4 3 6.5v13L9 17l6 2.5 6-2.5v-13L15 7 9 4z', 'M9 4v13', 'M15 7v12.5'],
  tree: ['M5 4v15', 'M5 8h6', 'M5 15h6', 'M14 6h6v4h-6z', 'M14 13h6v4h-6z'],
  folder: ['M3.5 6.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z'],
  file: ['M6 3.5h8l4 4V20a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 6 20z', 'M14 3.5V8h4'],
  copy: ['M8 8h11v11H8z', 'M16 8V5H5v11h3'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  download: ['M12 4v11', 'M7 10.5l5 5 5-5', 'M5 19.5h14'],
  refresh: ['M19.5 12a7.5 7.5 0 1 1-2.2-5.3', 'M19.5 4.5v4h-4'],
  settings: ['M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z', 'M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3.9a7 7 0 0 0-2-1.2L14.2 3h-4.4l-.4 2.6a7 7 0 0 0-2 1.2l-2.3-.9-2 3.4 2 1.5a7 7 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-.9a7 7 0 0 0 2 1.2l.4 2.6h4.4l.4-2.6a7 7 0 0 0 2-1.2l2.3.9 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z'],
  plus: ['M12 5v14', 'M5 12h14'],
  minus: ['M5 12h14'],
  trash: ['M5 7h14', 'M9.5 7V4.5h5V7', 'M7 7l1 12.5h8L17 7'],
  external: ['M14 4.5h5.5V10', 'M19.5 4.5 11 13', 'M18 14v5.5H4.5V6H10'],
  chevron: ['M9 6l6 6-6 6'],
  alert: ['M12 4 2.8 19.5h18.4z', 'M12 10v4.5', 'M12 17.2v.1'],
  info: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z', 'M12 11v5.5', 'M12 7.8v.1'],
  error: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z', 'M9 9l6 6', 'M15 9l-6 6'],
  terminal: ['M4 5.5h16v13H4z', 'M7.5 9.5 10.5 12l-3 2.5', 'M12.5 15h4'],
  globe: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z', 'M3.5 12h17', 'M12 3.5c2.5 2.6 3.5 5.4 3.5 8.5s-1 5.9-3.5 8.5c-2.5-2.6-3.5-5.4-3.5-8.5s1-5.9 3.5-8.5z'],
  laptop: ['M5 6h14v9H5z', 'M3 18.5h18'],
  plug: ['M9 3.5V8', 'M15 3.5V8', 'M6.5 8h11v3a5.5 5.5 0 0 1-11 0z', 'M12 16.5v4'],
  box: ['M12 3.5 20 7.5v9L12 20.5 4 16.5v-9z', 'M4 7.5l8 4 8-4', 'M12 11.5v9'],
  layers: ['M12 4 3.5 8.5 12 13l8.5-4.5z', 'M3.5 12.5 12 17l8.5-4.5', 'M3.5 16.5 12 21l8.5-4.5'],
  search: ['M10.5 4.5a6 6 0 1 0 0 12 6 6 0 0 0 0-12z', 'M15 15l5 5'],
  x: ['M6 6l12 12', 'M18 6 6 18'],
  rocket: ['M14 4.5c3-1 5.5-1 5.5-1s0 2.5-1 5.5L13 14.5 9.5 11z', 'M9.5 11 6 11.5 4 14l4 .5', 'M13 14.5l-.5 3.5-2.5 2-.5-4', 'M15.5 8.5h.01'],
  script: ['M8 4.5h9.5V17a2.5 2.5 0 0 1-2.5 2.5H6.5A2.5 2.5 0 0 1 4 17v-1.5h9V17a2.5 2.5 0 0 0 2.5 2.5', 'M8 4.5A2.5 2.5 0 0 0 5.5 7v8.5', 'M10 9h5', 'M10 12h5'],
  module: ['M5 5h14v14H5z', 'M9 9h6v6H9z'],
  cube: ['M12 3.5 20 8v8l-8 4.5L4 16V8z', 'M12 12.5 20 8', 'M12 12.5 4 8', 'M12 12.5v8'],
  value: ['M5 7.5h14', 'M5 12h10', 'M5 16.5h6'],
  service: ['M4.5 5h15v4.5h-15z', 'M4.5 14.5h15V19h-15z', 'M7.5 7.25h.01', 'M7.5 16.75h.01'],
  datamodel: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z', 'M8 12l3 3 5-6'],
  wifi: ['M4 9.5a12 12 0 0 1 16 0', 'M7 13a7.5 7.5 0 0 1 10 0', 'M10 16.5a3 3 0 0 1 4 0', 'M12 19.5h.01'],
  clock: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z', 'M12 7.5V12l3 2'],
  sparkle: ['M12 3.5l1.8 5.2L19 10.5l-5.2 1.8L12 17.5l-1.8-5.2L5 10.5l5.2-1.8z', 'M18.5 16v4', 'M16.5 18h4'],
  eye: ['M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z', 'M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z'],
  wrench: ['M14.5 4a4.5 4.5 0 0 0 5.5 5.5L10 19.5a2.1 2.1 0 0 1-3-3L17 6.5', 'M14.5 4l-1 3.5 3 3 3.5-1']
}

const FILLED = new Set(['play', 'stop'])

export function icon(name: string, size = 16, extraClass = ''): VElement {
  const paths = PATHS[name] ?? PATHS.info
  const filled = FILLED.has(name)
  return h(
    'svg',
    {
      class: `icon ${extraClass}`.trim(),
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: filled ? 'currentColor' : 'none',
      stroke: 'currentColor',
      'stroke-width': filled ? 1.2 : 1.7,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
      focusable: 'false'
    },
    paths.map((d) => h('path', { d }))
  )
}
