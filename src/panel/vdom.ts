// A very small keyed virtual DOM for the panel. Re-rendering the whole view on every state
// change keeps the code simple; patching (instead of replacing) keeps focus, text selection,
// scroll positions and running CSS transitions intact.

export type Props = Record<string, unknown> & { key?: string | number }
export type VElement = { tag: string; props: Props; children: VNode[]; key?: string | number }
export type VRaw = { raw: Element; key?: string | number }
export type VNode = VElement | VRaw | string
type Child = VNode | null | undefined | false | Child[]

export function h(tag: string, props: Props | null = null, ...children: Child[]): VElement {
  const flat: VNode[] = []
  const add = (c: Child) => {
    if (c === null || c === undefined || c === false) return
    if (Array.isArray(c)) c.forEach(add)
    else flat.push(typeof c === 'number' ? String(c) : c)
  }
  children.forEach(add)
  const p = props ?? {}
  return { tag, props: p, children: flat, key: p.key }
}

/** Inserts an element the caller owns (e.g. a log view it appends to directly). */
export function raw(el: Element, key?: string): VRaw {
  return { raw: el, key }
}

const SVG_NS = 'http://www.w3.org/2000/svg'
const SVG_TAGS = new Set(['svg', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'g', 'ellipse'])

type Bound = Node & { __v?: VNode; __on?: Record<string, EventListener> }

function keyOf(node: VNode): string | number | undefined {
  return typeof node === 'string' ? undefined : node.key
}

function create(v: VNode): Node {
  if (typeof v === 'string') {
    const t = document.createTextNode(v) as Bound
    t.__v = v
    return t
  }
  if ('raw' in v) return v.raw
  const el = (SVG_TAGS.has(v.tag) ? document.createElementNS(SVG_NS, v.tag) : document.createElement(v.tag)) as Element & Bound
  setProps(el, {}, v.props)
  for (const child of v.children) el.appendChild(create(child))
  el.__v = v
  return el
}

function setProps(el: Element & Bound, old: Props, next: Props) {
  const isSvg = el.namespaceURI === SVG_NS
  for (const name of Object.keys(old)) {
    if (name === 'key' || name in next) continue
    if (name.startsWith('on')) {
      const ev = name.slice(2).toLowerCase()
      if (el.__on?.[ev]) el.removeEventListener(ev, el.__on[ev])
      if (el.__on) delete el.__on[ev]
    } else if (name === 'class') el.removeAttribute('class')
    else el.removeAttribute(name)
  }
  for (const [name, value] of Object.entries(next)) {
    if (name === 'key') continue
    if (name.startsWith('on') && typeof value === 'function') {
      const ev = name.slice(2).toLowerCase()
      el.__on ??= {}
      if (el.__on[ev] !== value) {
        if (el.__on[ev]) el.removeEventListener(ev, el.__on[ev])
        el.addEventListener(ev, value as EventListener)
        el.__on[ev] = value as EventListener
      }
      continue
    }
    if (name === 'value' && !isSvg) {
      const input = el as HTMLInputElement
      if (input.value !== String(value ?? '')) input.value = String(value ?? '')
      continue
    }
    if (name === 'checked' && !isSvg) {
      ;(el as HTMLInputElement).checked = !!value
      continue
    }
    if (name === 'style' && typeof value === 'object' && value) {
      const style = (el as HTMLElement).style
      for (const [k, v] of Object.entries(value as Record<string, string>)) {
        if (style.getPropertyValue(k) !== v) style.setProperty(k, v)
      }
      continue
    }
    if (value === false || value === null || value === undefined) {
      if (el.hasAttribute(name)) el.removeAttribute(name)
    } else {
      const text = value === true ? '' : String(value)
      if (el.getAttribute(name) !== text) el.setAttribute(name, text)
    }
  }
}

function same(a: VNode, b: VNode): boolean {
  if (typeof a === 'string' || typeof b === 'string') return typeof a === 'string' && typeof b === 'string'
  if ('raw' in a || 'raw' in b) return 'raw' in a && 'raw' in b && a.raw === b.raw
  return a.tag === b.tag && a.key === b.key
}

function update(node: Bound, v: VNode) {
  const old = node.__v
  if (typeof v === 'string') {
    if ((node as Text).data !== v) (node as Text).data = v
    node.__v = v
    return
  }
  if ('raw' in v) return
  setProps(node as Element & Bound, old && typeof old !== 'string' && !('raw' in old) ? old.props : {}, v.props)
  patchChildren(node as Element, v.children)
  node.__v = v
}

/** Makes `parent`'s children match `next`, reusing nodes by key (or position). */
export function patchChildren(parent: Element, next: VNode[]) {
  const existing = Array.from(parent.childNodes) as Bound[]
  const byKey = new Map<string | number, Bound>()
  const unkeyed: Bound[] = []
  for (const node of existing) {
    const v = node.__v
    const k = v === undefined ? undefined : keyOf(v)
    if (k !== undefined) byKey.set(k, node)
    else unkeyed.push(node)
  }
  const used = new Set<Node>()
  let index = 0
  for (const v of next) {
    const k = keyOf(v)
    let node: Bound | undefined
    if (typeof v !== 'string' && 'raw' in v) node = v.raw as Bound
    else if (k !== undefined) {
      const hit = byKey.get(k)
      if (hit && hit.__v !== undefined && same(hit.__v, v)) node = hit
    } else {
      while (unkeyed.length) {
        const candidate = unkeyed.shift() as Bound
        if (candidate.__v !== undefined && same(candidate.__v, v)) {
          node = candidate
          break
        }
      }
    }
    if (node && !used.has(node)) update(node, v)
    else node = create(v) as Bound
    used.add(node)
    const at = parent.childNodes[index]
    if (at !== node) parent.insertBefore(node, at ?? null)
    index++
  }
  for (const node of Array.from(parent.childNodes)) {
    if (!used.has(node)) parent.removeChild(node)
  }
}
