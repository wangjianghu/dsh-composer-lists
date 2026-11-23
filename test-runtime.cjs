// Runtime integration tests: drive the REAL Runtime component (key handler +
// auto-renumber reaction) the way the DSH composer would.
//
// client.js keeps `onKey` and the renumber effect inside a React component, so
// test-pure.cjs (pure planners) cannot reach them. This harness mounts the
// component through `ctx.slots.register` with:
//   - a minimal React runtime (hook slots keyed by call order; effects run
//     after each render when their deps changed, exactly like React);
//   - a fake DOM good enough for the plugin's probes (blockText walk,
//     selection anchors, block indexes, listeners, rAF);
//   - a fake composer whose behaviour is copied from the running DSH source
//     (dsh-client-ui-conversation: facade.ts, editor/runtime.ts,
//     editor/span-map.ts, editor/projection.ts):
//       * insertText(text, span): revision CAS, then "select [start,end) and
//         insert" — the caret ALWAYS lands at start + text.length, and every
//         successful call is its own undo entry (tag = paste);
//       * setDraft(text): whole-draft replace, one paragraph per line, caret
//         at the end, merged into the undo history (no new entry);
//       * draftRev advances only when the draft TEXT changes;
//       * native typing merges into the open undo entry;
//       * effects (the renumber reaction) run once after the whole key event.
//
// Every scenario below encodes user-visible behaviour promised by README.md:
// draft text, caret position, and "the reaction never drags the caret away
// from the line being edited, and never fights Cmd+Z".

const path = require('path')

let definition = null
global.window = { __ModuleLoader__: { load (def) { definition = def } } }
require(path.join(__dirname, 'client.js'))
if (definition === null) throw new Error('client.js did not register with __ModuleLoader__')

// ---------------------------------------------------------------------------
// Fake DOM
// ---------------------------------------------------------------------------

class FakeNode {
  constructor () { this.parentNode = null }
  get isConnected () {
    let node = this
    while (node.parentNode !== null) node = node.parentNode
    return node === documentRoot
  }
  get previousSibling () {
    const parent = this.parentNode
    if (parent === null) return null
    const index = parent.childNodes.indexOf(this)
    return index > 0 ? parent.childNodes[index - 1] : null
  }
  remove () {
    const parent = this.parentNode
    if (parent === null) return
    const index = parent.childNodes.indexOf(this)
    if (index >= 0) parent.childNodes.splice(index, 1)
    this.parentNode = null
  }
}
FakeNode.TEXT_NODE = 3
FakeNode.ELEMENT_NODE = 1

class FakeText extends FakeNode {
  constructor (data) { super(); this.nodeType = 3; this.nodeName = '#text'; this.data = data }
  get textContent () { return this.data }
}

/** Minimal selector support: tag, .class, [a="v"], [a^="v"] (one compound). */
/** A selector list ("a, b") matches when ANY of its compounds matches. */
function parseSelector (selector) {
  return String(selector).split(',').map(part => parseCompound(part.trim()))
}

function parseCompound (selector) {
  const compound = { tag: null, classes: [], attrs: [] }
  let rest = selector
  const tag = /^[a-zA-Z][\w-]*/.exec(rest)
  if (tag !== null) { compound.tag = tag[0].toUpperCase(); rest = rest.slice(tag[0].length) }
  while (rest.length > 0) {
    const cls = /^\.([\w-]+)/.exec(rest)
    if (cls !== null) { compound.classes.push(cls[1]); rest = rest.slice(cls[0].length); continue }
    const attr = /^\[([\w-]+)(?:(\^?=)"?([^"\]]*)"?)?\]/.exec(rest)
    if (attr !== null) { compound.attrs.push({ name: attr[1], op: attr[2], value: attr[3] }); rest = rest.slice(attr[0].length); continue }
    throw new Error('unsupported selector: ' + selector)
  }
  return compound
}

function matchesCompound (element, compound) {
  if (compound.tag !== null && element.nodeName !== compound.tag) return false
  const classes = String(element.attrs.class ?? '').split(/\s+/).filter(c => c !== '')
  for (const cls of compound.classes) if (!classes.includes(cls)) return false
  for (const attr of compound.attrs) {
    const actual = element.attrs[attr.name]
    if (actual === undefined) return false
    if (attr.op === '=' && actual !== attr.value) return false
    if (attr.op === '^=' && !actual.startsWith(attr.value)) return false
  }
  return true
}

class FakeElement extends FakeNode {
  constructor (name, attrs = {}) {
    super()
    this.nodeType = 1
    this.nodeName = name.toUpperCase()
    this.attrs = { ...attrs }
    this.childNodes = []
  }
  get children () { return this.childNodes.filter(node => node.nodeType === 1) }
  get textContent () { return this.childNodes.map(node => node.textContent).join('') }
  getAttribute (name) { return name in this.attrs ? this.attrs[name] : null }
  setAttribute (name, value) { this.attrs[name] = String(value) }
  get classList () {
    const self = this
    const list = () => String(self.attrs.class ?? '').split(/\s+/).filter(c => c !== '')
    return {
      add (cls) { const set = new Set(list()); set.add(cls); self.attrs.class = [...set].join(' ') },
      remove (cls) { const set = new Set(list()); set.delete(cls); self.attrs.class = [...set].join(' ') },
    }
  }
  append (...nodes) { for (const node of nodes) { node.remove(); node.parentNode = this; this.childNodes.push(node) } }
  insertAt (index, ...nodes) {
    const at = Math.max(0, Math.min(index, this.childNodes.length))
    for (const node of nodes) { node.remove(); node.parentNode = this }
    this.childNodes.splice(at, 0, ...nodes)
  }
  querySelectorAll (selector) {
    const compounds = parseSelector(selector)
    const out = []
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 1) {
          if (compounds.some(compound => matchesCompound(child, compound))) out.push(child)
          walk(child)
        }
      }
    }
    walk(this)
    return out
  }
  querySelector (selector) { return this.querySelectorAll(selector)[0] ?? null }
  contains (node) {
    for (let at = node; at !== null && at !== undefined; at = at.parentNode) if (at === this) return true
    return false
  }
  closest (selector) {
    const compounds = parseSelector(selector)
    for (let at = this; at !== null; at = at.parentNode) {
      if (at.nodeType === 1 && compounds.some(compound => matchesCompound(at, compound))) return at
    }
    return null
  }
  getBoundingClientRect () { return { left: 400, top: 500, width: 26, height: 26 } }
}

const documentRoot = new FakeElement('#document')
const documentListeners = []
const rafQueue = new Map()
let rafSeq = 0

class FakeRange {
  constructor () { this.start = null; this.end = null }
  selectNodeContents (node) { this.start = { node, offset: 0 }; this.end = { node, offset: node.childNodes.length } }
  collapse () { this.end = this.start }
  setStartAfter (node) {
    const parent = node.parentNode
    const point = { node: parent, offset: parent.childNodes.indexOf(node) + 1 }
    this.start = point
    this.end = point
  }
  compareBoundaryPoints (_type, other) {
    const sign = offsetOfPoint(this.end) - offsetOfPoint(other.start)
    return sign < 0 ? -1 : sign > 0 ? 1 : 0
  }
}

global.Range = { END_TO_START: 2 }
global.requestAnimationFrame = (fn) => { rafSeq += 1; rafQueue.set(rafSeq, fn); return rafSeq }
global.cancelAnimationFrame = (id) => { rafQueue.delete(id) }

const document = {
  nodeType: 9,
  hidden: false,
  body: new FakeElement('body'),
  addEventListener (type, fn, capture) { documentListeners.push({ type, fn, capture: capture === true }) },
  removeEventListener (type, fn, capture) {
    const at = documentListeners.findIndex(entry => entry.type === type && entry.fn === fn && entry.capture === (capture === true))
    if (at >= 0) documentListeners.splice(at, 1)
  },
  dispatch (type, event) { for (const entry of [...documentListeners]) if (entry.type === type) entry.fn(event) },
  listenerCount (type) { return documentListeners.filter(entry => entry.type === type).length },
  querySelector (selector) { return document.body.querySelector(selector) },
  createRange () { return new FakeRange() },
}
global.document = document
documentRoot.append(document.body)
global.Node = FakeNode

/** Browser selection: anchor/focus are DOM points inside a composer. */
let selection = null
global.window.getSelection = () => ({
  get isCollapsed () { return selection !== null && selection.anchorNode === selection.focusNode && selection.anchorOffset === selection.focusOffset },
  get rangeCount () { return selection === null ? 0 : 1 },
  get anchorNode () { return selection === null ? null : selection.anchorNode },
  get anchorOffset () { return selection === null ? 0 : selection.anchorOffset },
  get focusNode () { return selection === null ? null : selection.focusNode },
  get focusOffset () { return selection === null ? 0 : selection.focusOffset },
  getRangeAt () {
    const range = new FakeRange()
    range.start = { node: selection.anchorNode, offset: selection.anchorOffset }
    range.end = { node: selection.focusNode, offset: selection.focusOffset }
    return range
  },
  removeAllRanges () { selection = null },
  addRange (range) { selection = { anchorNode: range.start.node, anchorOffset: range.start.offset, focusNode: range.end.node, focusOffset: range.end.offset } },
  modify (_alter, direction) {
    const hosts_ = liveHosts()
    const current = offsetOfPoint({ node: selection.anchorNode, offset: selection.anchorOffset })
    placeCaret(hosts_[0], current + (direction === 'backward' ? -1 : 1))
  },
})

const storage = new Map()
global.window.localStorage = {
  getItem: key => storage.has(key) ? storage.get(key) : null,
  setItem: (key, value) => { storage.set(key, String(value)) },
}

// ---------------------------------------------------------------------------
// Composer projection: detect text, DOM points, detect offsets
// ---------------------------------------------------------------------------

function detectLen (node) {
  if (node.nodeType === 3) return node.data.length
  if (node.nodeName === 'BR') return node.getAttribute('data-placeholder') !== null ? 0 : 1
  return node.childNodes.reduce((sum, child) => sum + detectLen(child), 0)
}

/** Walk the composer like the host's $composerLayout: text, <br>, block gaps. */
function layout (editable) {
  const blocks = []
  let pos = 0
  editable.children.forEach((block, index) => {
    if (index > 0) pos += 1
    const start = pos
    const leaves = []
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) {
          leaves.push({ node: child, start: pos, len: child.data.length })
          pos += child.data.length
        } else if (child.nodeName === 'BR') {
          if (child.getAttribute('data-placeholder') === null) {
            leaves.push({ node: child, start: pos, len: 1, br: true })
            pos += 1
          }
        } else walk(child)
      }
    }
    walk(block)
    blocks.push({ node: block, start, end: pos, leaves })
  })
  const text = blocks
    .map(block => block.leaves.map(leaf => leaf.br === true ? '\n' : leaf.node.data).join(''))
    .join('\n')
  return { blocks, text, length: text.length }
}

function composerOf (node) {
  for (let at = node; at !== null && at !== undefined; at = at.parentNode) {
    if (at.nodeType === 1 && at.getAttribute('data-composer-input') !== null) return at
  }
  return null
}

/** Detect offset of one DOM point (text node offset or element child index). */
function offsetOfPoint (point) {
  const editable = composerOf(point.node)
  if (editable === null) return 0
  const { blocks } = layout(editable)
  if (point.node.nodeType === 3) {
    for (const block of blocks) {
      const leaf = block.leaves.find(entry => entry.node === point.node)
      if (leaf !== undefined) return leaf.start + Math.min(point.offset, leaf.len)
    }
    return 0
  }
  const block = blocks.find(entry => entry.node === point.node)
  if (block === undefined) return 0
  let offset = block.start
  for (let i = 0; i < point.offset && i < point.node.childNodes.length; i += 1) offset += detectLen(point.node.childNodes[i])
  return offset
}

/**
 * DOM point resolving one detect offset the way the host's resolvePoint does:
 * inside a text segment → text point; a <br>'s own offset → the element point
 * on its leading side; a paragraph gap → the end of the block before it; the
 * document end → the end of the last block.
 */
function resolveOffset (editable, offset) {
  const { blocks, length } = layout(editable)
  if (offset < 0 || offset > length) return null
  if (blocks.length === 0) return { node: editable, offset: 0 }
  for (const block of blocks) {
    for (const leaf of block.leaves) {
      if (offset < leaf.start + leaf.len) {
        if (leaf.br === true) return { node: block.node, offset: block.node.childNodes.indexOf(leaf.node) }
        return { node: leaf.node, offset: offset - leaf.start }
      }
    }
    if (offset <= block.end) {
      if (block.leaves.length === 0) return { node: block.node, offset: 0 }
      return { node: block.node, offset: block.node.childNodes.length }
    }
  }
  return null
}

/**
 * Where the browser puts the caret for one detect offset. `atBlockStart`
 * settles the paragraph-gap ambiguity (the end of the block above vs the
 * start of the block below).
 */
function caretPoint (editable, offset, { atBlockStart = false } = {}) {
  const { blocks, length } = layout(editable)
  const at = Math.max(0, Math.min(offset, length))
  if (blocks.length === 0) return { node: editable, offset: 0 }
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (atBlockStart && at === block.end && index + 1 < blocks.length) continue
    if (at === block.start) {
      const first = block.leaves[0]
      if (first === undefined) return { node: block.node, offset: 0 } // caret inside an empty paragraph
      if (first.br === true) return { node: block.node, offset: block.node.childNodes.indexOf(first.node) }
      return { node: first.node, offset: 0 }
    }
    if (at <= block.end) {
      if (block.leaves.length === 0) return { node: block.node, offset: 0 } // the only place to be in an empty paragraph
      // The end of a text leaf wins: a caret right before a <br> sits there.
      const textLeaf = block.leaves.find(leaf => leaf.br !== true && at >= leaf.start && at <= leaf.start + leaf.len)
      if (textLeaf !== undefined) return { node: textLeaf.node, offset: at - textLeaf.start }
      const br = block.leaves.find(leaf => leaf.br === true && at === leaf.start)
      if (br !== undefined) return { node: block.node, offset: block.node.childNodes.indexOf(br.node) }
      const last = block.leaves[block.leaves.length - 1]
      return { node: block.node, offset: block.node.childNodes.indexOf(last.node) + 1 }
    }
  }
  const lastBlock = blocks[blocks.length - 1]
  return { node: lastBlock.node, offset: lastBlock.node.childNodes.length }
}

/** Where the caret rests right after `text` was inserted at `start`. */
function caretAfterInsert (editable, start, text) {
  const at = start + text.length
  const { blocks } = layout(editable)
  if (text !== '' && !text.endsWith('\n')) {
    for (const block of blocks) {
      const leaf = block.leaves.find(entry => entry.br !== true && at > entry.start && at <= entry.start + entry.len)
      if (leaf !== undefined) return { node: leaf.node, offset: at - leaf.start }
    }
  }
  // Right after a <br>: the next text leaf at 0, else the element point.
  for (const block of blocks) {
    const leaf = block.leaves.find(entry => entry.br !== true && entry.start === at)
    if (leaf !== undefined) return { node: leaf.node, offset: 0 }
  }
  return caretPoint(editable, at)
}

// ---------------------------------------------------------------------------
// Fake composer (host semantics copied from the running DSH source)
// ---------------------------------------------------------------------------

const liveHosts = () => hosts.filter(host => host.editable.isConnected)
const hosts = []

function spanOf (text) {
  const span = new FakeElement('span', { 'data-lexical-text': 'true' })
  span.append(new FakeText(text))
  return span
}

const placeholderBr = () => new FakeElement('br', { 'data-placeholder': '' })

function serializeNode (node) {
  if (node.nodeType === 3) return { kind: 'text', data: node.data }
  if (node.nodeName === 'BR') return { kind: 'br', placeholder: node.getAttribute('data-placeholder') !== null }
  return { kind: node.nodeName, attrs: { ...node.attrs }, children: node.childNodes.map(serializeNode) }
}

function deserializeNode (node) {
  if (node.kind === 'text') return new FakeText(node.data)
  return new FakeElement(node.kind, node.attrs ?? {})
}

function buildNode (spec) {
  const node = deserializeNode(spec)
  for (const child of spec.children ?? []) node.append(buildNode(child))
  return node
}

function describePoint (editable, point) {
  const path = []
  let node = point.node
  while (node !== editable && node !== null) {
    const parent = node.parentNode
    path.unshift(parent.childNodes.indexOf(node))
    node = parent
  }
  return { path, offset: point.offset }
}

function pointFromDescription (editable, described) {
  let node = editable
  for (const index of described.path) node = node.childNodes[index]
  return { node, offset: described.offset }
}

class ComposerHost {
  /**
   * @param form 'paragraphs' — one <p> per line (setDraft / restored draft);
   *   'single' — ONE <p> whose line breaks are <br> (typed / plugin-inserted).
   */
  constructor ({ text = '', form = 'paragraphs' } = {}) {
    this.card = new FakeElement('div', { 'data-composer-card': '' })
    this.tools = new FakeElement('div', { class: 'tools' })
    this.editable = new FakeElement('div', {
      contenteditable: 'true', role: 'textbox', 'aria-multiline': 'true', 'data-composer-input': '',
    })
    this.card.append(this.editable, this.tools)
    document.body.append(this.card)
    this.rev = 0
    this.phase = 'plain'
    this.occurrences = []
    this.undoStack = []
    this.redoStack = []
    this.typingOpen = false // the previous entry was native typing (merge window)
    this.edits = [] // every inputActions.insertText call, in order
    this.subscribers = new Set()
    this.fill(text)
    hosts.push(this)
    this.actions = {
      captureInsertion: () => {
        const span = this.span()
        return { start: span.start, end: span.end, draftRev: this.rev }
      },
      insertText: (text, span) => {
        const ok = this.insertText(text, span)
        this.edits.push({ text, start: span.start, end: span.end, ok })
        return ok
      },
      setDraft: (text) => { this.setDraft(text) },
    }
  }

  /** Rebuild the whole document: one paragraph per line, caret at the end. */
  fill (text) {
    for (const block of [...this.editable.children]) block.remove()
    const lines = String(text).split('\n')
    for (const line of lines) {
      const paragraph = new FakeElement('p')
      if (line === '') paragraph.append(placeholderBr())
      else paragraph.append(spanOf(line))
      this.editable.append(paragraph)
    }
    if (lines.length === 1 && lines[0] === '') this.fill_singleEmpty = true
    const point = caretPoint(this.editable, this.text().length)
    this.select(point)
  }

  select (point) {
    selection = { anchorNode: point.node, anchorOffset: point.offset, focusNode: point.node, focusOffset: point.offset }
  }

  text () { return layout(this.editable).text }

  state () {
    return { draft: this.text(), draftRev: this.rev, phase: this.phase, occurrences: this.occurrences }
  }

  /** Ordered detect span of the browser selection; absent → document end. */
  span () {
    if (selection === null || composerOf(selection.anchorNode) !== this.editable) {
      const at = this.text().length
      return { start: at, end: at }
    }
    const anchor = offsetOfPoint({ node: selection.anchorNode, offset: selection.anchorOffset })
    const focus = offsetOfPoint({ node: selection.focusNode, offset: selection.focusOffset })
    return { start: Math.min(anchor, focus), end: Math.max(anchor, focus) }
  }

  caret () { return this.span().start }

  frozen () { return this.phase !== 'plain' && this.phase !== 'claimed' }

  snapshot () {
    const own = selection !== null && composerOf(selection.anchorNode) === this.editable
    return {
      blocks: this.editable.children.map(block => serializeNode(block)),
      sel: own
        ? { anchor: describePoint(this.editable, { node: selection.anchorNode, offset: selection.anchorOffset }), focus: describePoint(this.editable, { node: selection.focusNode, offset: selection.focusOffset }) }
        : null,
    }
  }

  restore (snapshot) {
    for (const block of [...this.editable.children]) block.remove()
    for (const spec of snapshot.blocks) this.editable.append(buildNode(spec))
    if (snapshot.sel !== null) {
      const anchor = pointFromDescription(this.editable, snapshot.sel.anchor)
      const focus = pointFromDescription(this.editable, snapshot.sel.focus)
      selection = { anchorNode: anchor.node, anchorOffset: anchor.offset, focusNode: focus.node, focusOffset: focus.offset }
    }
  }

  /** One editor update: apply, then revision / history bookkeeping. */
  commit (mutate, { tag }) {
    const beforeText = this.text()
    const before = this.snapshot()
    mutate()
    if (this.text() === beforeText) return false
    this.rev += 1
    if (tag === 'historic') {
      // handled by undo()/redo()
    } else if (tag === 'history-merge' || (tag === 'type' && this.typingOpen)) {
      // merged into the open entry: nothing to push
    } else {
      this.undoStack.push(before)
      this.redoStack = []
    }
    this.typingOpen = tag === 'type'
    for (const subscriber of this.subscribers) subscriber()
    return true
  }

  /** The host's $replaceDetectSpanWithText: select [start,end), insert. */
  applyRange (start, end, text, { tag = 'paste' } = {}) {
    const length = this.text().length
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > length) return false
    this.commit(() => {
      const point = replaceDetectRange(this.editable, start, end, text)
      if (point !== null) this.select(point)
    }, { tag })
    // The host reports "the range mapped and the edit applied" even when the
    // text is unchanged (a marker rewritten with itself only moves the caret).
    return true
  }

  insertText (text, span) {
    if (this.frozen()) return false
    if (span.draftRev !== this.rev) return false
    return this.applyRange(span.start, span.end, text.replace(/[\uE100-\uE11D\uFFFC]/gu, ''))
  }

  /** Native typing over the current selection. */
  type (text) {
    const span = this.span()
    return this.applyRange(span.start, span.end, text, { tag: 'type' })
  }

  /** Replace the draft exactly the way the host's setDraft does. */
  setDraft (text) {
    const clean = String(text).replace(/[\uE100-\uE11D\uFFFC]/gu, '')
    if (clean === this.text()) return
    this.commit(() => { this.fill(clean) }, { tag: 'history-merge' })
  }

  undo () {
    if (this.undoStack.length === 0) return false
    const target = this.undoStack.pop()
    this.redoStack.push(this.snapshot())
    this.commit(() => { this.restore(target) }, { tag: 'historic' })
    this.typingOpen = false
    return true
  }

  redo () {
    if (this.redoStack.length === 0) return false
    const target = this.redoStack.pop()
    this.undoStack.push(this.snapshot())
    this.commit(() => { this.restore(target) }, { tag: 'historic' })
    this.typingOpen = false
    return true
  }

  dispose () {
    this.card.remove()
    const at = hosts.indexOf(this)
    if (at >= 0) hosts.splice(at, 1)
  }
}

function placeCaret (host, offset, options) {
  host.select(caretPoint(host.editable, offset, options))
}

/**
 * Replace the detect range [start,end) with `text` inside the composer DOM.
 * Returns the DOM point where the caret rests after the insertion.
 */
function replaceDetectRange (editable, start, end, text) {
  const a = resolveOffset(editable, start)
  const b = resolveOffset(editable, end)
  if (a === null || b === null) return null
  const locate = (point) => {
    if (point.node.nodeType === 3) {
      const span = point.node.parentNode
      return { block: span.parentNode, index: span.parentNode.childNodes.indexOf(span), node: point.node, offset: point.offset }
    }
    return { block: point.node, index: point.offset, node: null, offset: 0 }
  }
  const pa = locate(a)
  const pb = locate(b)
  const drop = (node) => node.remove()
  const blockA = pa.block
  if (blockA === pb.block) {
    if (pa.node !== null && pb.node !== null && pa.node === pb.node) {
      pa.node.data = pa.node.data.slice(0, pa.offset) + pb.node.data.slice(pb.offset)
    } else {
      if (pa.node !== null) pa.node.data = pa.node.data.slice(0, pa.offset)
      if (pb.node !== null) pb.node.data = pb.node.data.slice(pb.offset)
      const from = pa.node !== null ? pa.index + 1 : pa.index
      const to = pb.node !== null ? pb.index : pb.index
      for (let i = to - 1; i >= from; i -= 1) drop(blockA.childNodes[i])
    }
  } else {
    // Across paragraphs: keep A's head and B's tail, merge B into A.
    if (pa.node !== null) {
      pa.node.data = pa.node.data.slice(0, pa.offset)
      for (let i = blockA.childNodes.length - 1; i > pa.index; i -= 1) drop(blockA.childNodes[i])
    } else {
      for (let i = blockA.childNodes.length - 1; i >= pa.index; i -= 1) drop(blockA.childNodes[i])
    }
    const blocks = editable.children
    const ia = blocks.indexOf(blockA)
    const ib = blocks.indexOf(pb.block)
    for (let i = ib - 1; i > ia; i -= 1) drop(blocks[i])
    if (pb.node !== null) pb.node.data = pb.node.data.slice(pb.offset)
    for (let i = pb.index - 1; i >= 0; i -= 1) drop(pb.block.childNodes[i])
    for (const child of [...pb.block.childNodes]) blockA.append(child)
    pb.block.remove()
  }
  // Insert `text` where the range began.
  const insertIndex = pa.node !== null ? pa.index + 1 : pa.index
  const pieces = []
  text.split('\n').forEach((piece, i) => {
    if (i > 0) pieces.push(new FakeElement('br'))
    if (piece !== '') pieces.push(spanOf(piece))
  })
  const placeholder = blockA.childNodes.length === 1 && blockA.childNodes[0].nodeName === 'BR' && blockA.childNodes[0].getAttribute('data-placeholder') !== null
  if (placeholder) drop(blockA.childNodes[0])
  if (pa.node !== null) {
    const remainder = pa.node.data.slice(pa.offset)
    pa.node.data = pa.node.data.slice(0, pa.offset)
    if (text.indexOf('\n') === -1) {
      // Plain text joins the text node it landed in (one Lexical text node).
      pa.node.data = pa.node.data + text + remainder
    } else {
      const tail = remainder === '' ? [] : [spanOf(remainder)]
      blockA.insertAt(insertIndex, ...pieces, ...tail)
    }
  } else {
    const at = Math.min(insertIndex, blockA.childNodes.length)
    blockA.insertAt(at, ...pieces)
  }
  // Tidy: drop empty text spans; an emptied paragraph keeps a placeholder.
  for (const span of [...blockA.querySelectorAll('span')]) {
    if (span.textContent === '') span.remove()
  }
  if (blockA.childNodes.length === 0) blockA.append(placeholderBr())
  // A paragraph holding just one <br> IS the host's empty-paragraph form
  // (the plugin's blockText projects it as '' too): never model it as a
  // paragraph with a lone line break, which the projections would disagree on.
  if (blockA.childNodes.length === 1 && blockA.childNodes[0].nodeName === 'BR') {
    blockA.childNodes[0].remove()
    blockA.append(placeholderBr())
  }
  return caretAfterInsert(editable, start, text)
}

// ---------------------------------------------------------------------------
// Minimal React (hook slots keyed by call order; effects flush after render)
// ---------------------------------------------------------------------------

function createReact () {
  const hooks = []
  let cursor = 0
  let dirty = false
  let pendingEffects = []
  const sameDeps = (a, b) => a !== undefined && b !== undefined && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  const slot = () => {
    const index = cursor
    cursor += 1
    if (hooks[index] === undefined) hooks[index] = {}
    return [index, hooks[index]]
  }
  return {
    dirty: () => dirty,
    markDirty: () => { dirty = true },
    createElement (type, props, ...children) { return { type, props: props ?? {}, children } },
    useState (initial) {
      const [, hook] = slot()
      if (!('value' in hook)) hook.value = typeof initial === 'function' ? initial() : initial
      return [hook.value, (next) => { hook.value = typeof next === 'function' ? next(hook.value) : next; dirty = true }]
    },
    useRef (initial) {
      const [, hook] = slot()
      if (!('current' in hook)) hook.current = initial
      return hook
    },
    useEffect (effect, deps) {
      const [index, hook] = slot()
      if (hook.mounted === true && sameDeps(hook.deps, deps)) return
      pendingEffects.push(() => {
        if (hooks[index]?.cleanup !== undefined) hooks[index].cleanup()
        const cleanup = effect()
        hooks[index] = { mounted: true, deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined }
      })
    },
    useCallback (callback, deps) {
      const [, hook] = slot()
      if (!('callback' in hook) || !sameDeps(hook.deps, deps)) { hook.callback = callback; hook.deps = deps }
      return hook.callback
    },
    render (component, props, onTree) {
      let guard = 0
      do {
        cursor = 0
        pendingEffects = []
        dirty = false
        this.tree = component(props)
        if (onTree !== undefined) onTree(this.tree) // refs attach before effects, as in React
        const effects = pendingEffects
        for (const effect of effects) effect()
        guard += 1
      } while (dirty && guard < 50)
      return this.tree
    },
    unmount () {
      for (const hook of hooks) { if (hook.cleanup !== undefined) hook.cleanup(); hook.cleanup = undefined; hook.mounted = false }
      pendingEffects = []
    },
  }
}

/** Every element of a rendered tree that passes `test`, in document order. */
function collect (element, test, out = []) {
  if (element === null || typeof element !== 'object') return out
  if (test(element)) out.push(element)
  for (const child of element.children ?? []) {
    if (Array.isArray(child)) child.forEach(entry => collect(entry, test, out))
    else collect(child, test, out)
  }
  return out
}

/** Materialize the plugin's buttons (and their root) into the fake DOM. */
function attach (element, parent) {
  if (element === null || typeof element !== 'object') return
  const children = element.children ?? []
  if (typeof element.type === 'function') { children.forEach(child => attach(child, parent)); return }
  if (typeof element.type !== 'string' || !/^(div|button)$/.test(element.type)) return
  const node = new FakeElement(String(element.type), { ...(element.props.class !== undefined ? { class: element.props.class } : {}) })
  if (element.props.ref !== undefined && element.props.ref !== null) element.props.ref.current = node
  parent.append(node)
  for (const child of children) {
    if (Array.isArray(child)) child.forEach(entry => attach(entry, node))
    else attach(child, node)
  }
}

// ---------------------------------------------------------------------------
// Mount: Runtime + composer, with key/type/caret/undo drivers
// ---------------------------------------------------------------------------

const mounted = []

function mount ({ text = '', form = 'paragraphs', settings = {}, host: sharedHost = null } = {}) {
  storage.set('dsh.composerLists.settings', JSON.stringify({
    v: 2, indentUnit: 2, autoRenumber: true, showOptimize: true,
    orderedStyles: ['arabic', 'letter', 'circle', 'paren', 'greek', 'arabic'],
    bulletStyles: ['-', '*', '+', '•', '○', '▪'], ...settings,
  }))
  const react = createReact()
  const mod = definition.factory((id) => {
    if (id === 'react') return react
    if (id === 'react-dom') return { createPortal: element => element }
    throw new Error('unexpected require: ' + id)
  })
  let renderSlot = null
  const t = key => key
  mod.apply({
    locale: { register: () => () => {}, bind: () => t },
    slots: {
      inject: (_name, fn) => fn(),
      register: (_def, render) => { renderSlot = render; return () => {} },
    },
    effect: fn => fn(),
  })
  if (renderSlot === null) throw new Error('plugin did not register its composer slot')
  const host = sharedHost ?? new ComposerHost({ text, form })
  if (sharedHost === null && form === 'single') host.toSingleParagraph()
  host.subscribers.add(() => react.markDirty())
  const props = { useInput: selector => selector(host.state()), inputActions: host.actions, t }
  let rootMounted = false
  const rerender = () => {
    const element = renderSlot(props)
    react.render(element.type, element.props, tree => {
      if (rootMounted === true) return // the root element persists across renders
      rootMounted = true
      attach(tree, host.tools)
    })
  }
  rerender()
  const session = {
    host, react, edits: () => host.edits,
    /** Dispatch one keydown through the document capture listener, then flush. */
    key (key, { shift = false, ctrl = false, meta = false, alt = false, code = '', target = null, flush = true } = {}) {
      const event = {
        key, shiftKey: shift, ctrlKey: ctrl, metaKey: meta, altKey: alt, code,
        repeat: false, isComposing: false, keyCode: 0, defaultPrevented: false,
        target: target ?? host.editable,
        preventDefault () { this.defaultPrevented = true },
        stopPropagation () {},
      }
      document.dispatch('keydown', event)
      if (flush === true) rerender()
      return event
    },
    type (chars) { host.type(chars); rerender() },
    caret (offset, options) { if (offset !== undefined) placeCaret(host, offset, options); return host.caret() },
    draft: () => host.text(),
    /**
     * One history step. `signal` is how the user triggered it: 'key'
     * (Cmd+Z / Cmd+Shift+Z, seen by the capture listener first), 'menu'
     * (Edit menu → a beforeinput history* event), or 'none'.
     */
    undo ({ signal = 'key' } = {}) {
      // As in the browser: the capture listener sees the chord, Lexical undoes
      // in the same event, and only then does React render.
      if (signal === 'key') session.key('z', { meta: true, flush: false })
      if (signal === 'menu') document.dispatch('beforeinput', { inputType: 'historyUndo', target: host.editable })
      host.undo()
      rerender()
    },
    redo ({ signal = 'key' } = {}) {
      if (signal === 'key') session.key('z', { meta: true, shift: true, flush: false })
      if (signal === 'menu') document.dispatch('beforeinput', { inputType: 'historyRedo', target: host.editable })
      host.redo()
      rerender()
    },
    beforeInput (inputType) {
      document.dispatch('beforeinput', { inputType, target: host.editable, preventDefault () { this.defaultPrevented = true }, defaultPrevented: false })
      rerender()
    },
    flush: rerender,
    /** The plugin's rendered buttons, in document order (optimize, gear). */
    buttons: () => collect(react.tree, element => element.type === 'button'),
    replace (start, end, text) { host.applyRange(start, end, text, { tag: 'type' }); rerender() },
    unmount () { react.unmount(); if (sharedHost === null) host.dispose() },
  }
  mounted.push(session)
  return session
}

/** Rebuild the draft as ONE paragraph whose line breaks are <br> nodes. */
ComposerHost.prototype.toSingleParagraph = function () {
  const lines = this.text().split('\n')
  for (const block of [...this.editable.children]) block.remove()
  const paragraph = new FakeElement('p')
  lines.forEach((line, index) => {
    if (index > 0) paragraph.append(new FakeElement('br'))
    if (line !== '') paragraph.append(spanOf(line))
  })
  this.editable.append(paragraph)
  this.select(caretPoint(this.editable, this.text().length))
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

module.exports = { mount, mounted, placeCaret, ComposerHost, layout, caretPoint, offsetOfPoint, resolveOffset, FakeElement, spanOf, collect }

if (require.main !== module) {
  // Imported as a harness library (property tests live in test-properties.cjs).
} else {
// ---------------------------------------------------------------------------
// Scenarios. Every expectation is user-visible behaviour README.md promises:
// draft text, caret offset, and how many editor edits one key costs.
// ---------------------------------------------------------------------------

let failures = 0
let passes = 0
const fail = (label, detail) => { failures += 1; console.error(`FAIL ${label}\n${detail}`) }
const pass = (label) => { passes += 1; console.log(`ok   ${label}`) }
const show = value => JSON.stringify(value)

function eq (actual, expected, label) {
  const a = show(actual)
  const b = show(expected)
  if (a !== b) fail(label, `  actual   ${a}\n  expected ${b}`)
  else pass(label)
}
const ok = (cond, label, detail = '') => { if (cond !== true) fail(label, detail ? '  ' + detail : ''); else pass(label) }

/** One key press, then the draft / caret / edit-count expectations. */
function press (session, label, key, modifiers, expected) {
  const before = session.edits().length
  const event = session.key(key, modifiers)
  const edits = session.edits().slice(before)
  const actual = { draft: session.draft(), caret: session.caret(), edits: edits.length }
  const want = { draft: expected.draft, caret: expected.caret, edits: expected.edits ?? 1 }
  const a = show(actual)
  const b = show(want)
  if (a !== b) {
    fail(label, `  actual   ${a}\n  expected ${b}\n  edit log ${show(edits.map(e => [e.text, e.start, e.end, e.ok]))}`)
  } else pass(label)
  return event
}

const cleanup = () => { for (const session of [...mounted]) session.unmount(); mounted.length = 0 }

// --- A. README core flows in both DOM forms ------------------------------
for (const form of ['paragraphs', 'single']) {
  const s = mount({ text: '1. a', form })
  press(s, `A1 continue [${form}]`, 'Enter', { shift: true }, { draft: '1. a\n2. ', caret: 8 })
  press(s, `A2 empty item exits [${form}]`, 'Enter', { shift: true }, { draft: '1. a\n\n', caret: 6 })
  press(s, `A3 blank grows by one [${form}]`, 'Enter', { shift: true }, { draft: '1. a\n\n\n', caret: 7 })
  s.unmount()
}
{
  const s = mount({ text: 'plain text', form: 'single' })
  const event = s.key('Enter', { shift: true })
  ok(event.defaultPrevented === false, 'A4 Shift+Enter on a plain line stays native')
  eq(s.edits().length, 0, 'A4 plain line costs no edit')
  s.unmount()
}

// --- B. Shift+Enter with later siblings (the main list flow) --------------
for (const form of ['paragraphs', 'single']) {
  const s = mount({ text: '1. a\n2. c', form })
  s.caret(4)
  press(s, `B1 continue in the middle of a list [${form}]`, 'Enter', { shift: true }, { draft: '1. a\n2. \n3. c', caret: 8, edits: 2 })
  s.type('b')
  eq(s.draft(), '1. a\n2. b\n3. c', `B1 typed text lands on the new line [${form}]`)
  s.unmount()
}
{
  const s = mount({ text: '1. a\n2. b\n3. c' })
  s.caret(4)
  press(s, 'B2 three-item list shifts two later items', 'Enter', { shift: true }, { draft: '1. a\n2. \n3. b\n4. c', caret: 8, edits: 2 })
  s.unmount()
  const mid = mount({ text: '1. ab\n2. c' })
  mid.caret(4) // between a|b
  press(mid, 'B3 continue from inside the content', 'Enter', { shift: true }, { draft: '1. a\n2. b\n3. c', caret: 8, edits: 2 })
  mid.unmount()
  const last = mount({ text: '1. a\n2. b' })
  last.caret(9)
  press(last, 'B4 continue on the last item needs no renumber', 'Enter', { shift: true }, { draft: '1. a\n2. b\n3. ', caret: 13, edits: 1 })
  last.unmount()
  const bullet = mount({ text: '- a\n- c' })
  bullet.caret(3)
  press(bullet, 'B5 bullet lists share the flow', 'Enter', { shift: true }, { draft: '- a\n- \n- c', caret: 6, edits: 1 })
  bullet.unmount()
}

// --- C. Hand-written marker styles converge without moving the caret -------
{
  const s = mount({ text: '- f\n1) m' })
  s.caret(8)
  press(s, 'C1 continue on a hand-written "1)" line', 'Enter', { shift: true }, { draft: '- f\n1. m\n2. ', caret: 12, edits: 1 })
  s.unmount()
  const lone = mount({ text: 'a. x' })
  lone.caret(4)
  press(lone, 'C2 a lone letter-style item becomes 1./2. in one edit', 'Enter', { shift: true }, { draft: '1. x\n2. ', caret: 8, edits: 1 })
  lone.unmount()
}

// --- D. Exiting a list in the middle ------------------------------------
{
  const s = mount({ text: '1. a\n2. \n3. b' })
  s.caret(8)
  press(s, 'D1 middle exit leaves blank + caret line and restarts the tail', 'Enter', { shift: true }, { draft: '1. a\n\n\n1. b', caret: 6, edits: 2 })
  s.unmount()
  // A hand-edited number is the one un-converged state that persists.
  const nested = mount({ text: '1. a\n2. f\n  a. \n3. d' })
  nested.replace(5, 7, 'b.')
  eq(nested.draft(), '1. a\nb. f\n  a. \n3. d', 'D2 setup: a hand-written letter marker survives')
  nested.caret(14)
  press(nested, 'D2 exit converges earlier and later lines in the same gesture', 'Enter', { shift: true }, { draft: '1. a\n2. f\n\n\n1. d', caret: 11, edits: 2 })
  eq(nested.edits().length, 2, 'D2 the reaction stays idle afterwards')
  nested.unmount()
  const blanks = mount({ text: '1. a\n2. \n\n\nX' })
  blanks.caret(8)
  press(blanks, 'D3 exit swallows old blank lines', 'Enter', { shift: true }, { draft: '1. a\n\n\nX', caret: 6, edits: 1 })
  blanks.unmount()
}

// --- E. Tab / Shift+Tab keep the caret on the tabbed line ----------------
{
  const s = mount({ text: '1. a\n2. b\n3. c' })
  s.caret(9)
  press(s, 'E1 Tab in the middle of a list', 'Tab', {}, { draft: '1. a\n  a. b\n2. c', caret: 11, edits: 2 })
  press(s, 'E2 Shift+Tab promotes back', 'Tab', { shift: true }, { draft: '1. a\n2. b\n3. c', caret: 9, edits: 2 })
  s.caret(14)
  press(s, 'E3 Tab on the last item', 'Tab', {}, { draft: '1. a\n2. b\n  a. c', caret: 16, edits: 1 })
  s.unmount()
}

// --- F. Backspace: promote / delete --------------------------------------
{
  const s = mount({ text: '1. a\n  b. x\n  c. y' })
  s.caret(9)
  press(s, 'F1 promote keeps the caret after the new marker', 'Backspace', {}, { draft: '1. a\n2. x\n  a. y', caret: 8, edits: 2 })
  s.unmount()
  const empty = mount({ text: '1. a\n  b. ' })
  empty.caret(9)
  press(empty, 'F2 empty second-level item promotes', 'Backspace', {}, { draft: '1. a\n2. ', caret: 8, edits: 1 })
  empty.unmount()
  const lone = mount({ text: '1. a\n2. b\n3. c' })
  lone.caret(7)
  press(lone, 'F3 deleting a middle marker leaves a lone numbered line alone', 'Backspace', {}, { draft: '1. a\nb\n3. c', caret: 5, edits: 1 })
  lone.unmount()
  const tail = mount({ text: '1. a\n2. b\n3. c\n4. d' })
  tail.caret(7)
  press(tail, 'F4 deleting a middle marker renumbers the multi-item tail', 'Backspace', {}, { draft: '1. a\nb\n1. c\n2. d', caret: 5, edits: 2 })
  tail.unmount()
}

// --- G. Cmd+Z / redo against the auto-renumber reaction ------------------
{
  const s = mount({ text: '1. a\n2. b\n3. c\n4. d' })
  s.replace(4, 9, '') // the user selects item 2 with its line break and deletes it
  eq(s.draft(), '1. a\n2. c\n3. d', 'G1 deleting a middle item renumbers the tail')
  eq(s.caret(), 8, 'G1 the renumber leaves the caret on the line after the deletion')
  const before = s.edits().length
  s.undo()
  eq(s.draft(), '1. a\n3. c\n4. d', 'G2 Cmd+Z #1 reverts the renumber (and is not redone)')
  eq(s.edits().length, before, 'G2 undo triggers no reaction edit')
  s.undo()
  eq(s.draft(), '1. a\n2. b\n3. c\n4. d', 'G3 Cmd+Z #2 restores the deleted item')
  eq(s.edits().length, before, 'G3 still no reaction edit')
  s.redo()
  eq(s.draft(), '1. a\n2. c\n3. d', 'G4 redo re-applies the deletion and re-converges')
  s.unmount()
}
{
  const s = mount({ text: '1. a\n2. b\n3. c\n4. d' })
  s.replace(4, 9, '')
  const before = s.edits().length
  s.undo({ signal: 'menu' }) // Edit ▸ Undo arrives as beforeinput historyUndo
  eq(s.draft(), '1. a\n3. c\n4. d', 'G5 menu undo also suspends the reaction')
  eq(s.edits().length, before, 'G5 menu undo triggers no reaction edit')
  s.caret(s.draft().length)
  s.type('x')
  eq(s.draft(), '1. a\n2. c\n3. dx', 'G6 the next real edit renumbers again')
  s.unmount()
}
{
  const s = mount({ text: '1. a\n2. \n3. b' })
  s.caret(8)
  press(s, 'G7 exit with tail fix', 'Enter', { shift: true }, { draft: '1. a\n\n\n1. b', caret: 6, edits: 2 })
  const before = s.edits().length
  s.undo()
  eq(s.draft(), '1. a\n2. \n1. b', 'G7 undo #1 reverts the exit only')
  eq(s.edits().length, before, 'G7 undo #1 triggers no reaction edit')
  s.undo()
  eq(s.draft(), '1. a\n2. \n3. b', 'G7 undo #2 reverts the tail fix')
  eq(s.edits().length, before, 'G7 undo #2 triggers no reaction edit')
  s.unmount()
}
{
  // A hand-edited number is still suspended both ways.
  const s = mount({ text: '1. a\n2. b' })
  s.replace(5, 6, '7')
  eq(s.draft(), '1. a\n7. b', 'G8 hand-numbering is left alone')
  s.caret(s.draft().length)
  s.type('x')
  eq(s.draft(), '1. a\n2. bx', 'G8 the next content edit renumbers')
  // Pasting a whole item line is not a hand marker edit: it renumbers.
  const paste = mount({ text: '1. a\n2. c' })
  paste.replace(5, 5, 'b. x\n')
  eq(paste.draft(), '1. a\n2. x\n3. c', 'G9 a pasted item line joins the numbering')
  paste.unmount()
  s.unmount()
}

// --- H. Only OUR composer is driven --------------------------------------
{
  const a = mount({ text: 'x' })
  const b = mount({ text: '1. a' })
  b.key('Enter', { shift: true })
  eq(a.draft(), 'x', 'H1 a second composer is left untouched')
  eq(a.edits().length, 0, 'H1 the foreign composer makes no edit')
  eq(b.draft(), '1. a\n2. ', 'H1 the composer that received the key continues its list')
  a.unmount()
  b.unmount()
}
{
  const s = mount({ text: 'x' })
  const alien = new FakeElement('div', { contenteditable: 'true' })
  alien.append(spanOf('1. item'))
  document.body.insertAt(0, alien) // BEFORE the composer in document order
  placeCaret(s.host, 1)
  const backspace = s.key('Backspace', { target: alien })
  eq(s.draft(), 'x', 'H2 Shift/Backspace in ANOTHER editor never edits the composer draft')
  ok(backspace.defaultPrevented === false, 'H2 the other editor keeps its native key')
  const enter = s.key('Enter', { shift: true, target: alien })
  eq(s.draft(), 'x', 'H2 Shift+Enter in another editor never edits the composer draft')
  ok(enter.defaultPrevented === false, 'H2 Shift+Enter stays native in the other editor')
  s.replace(0, 1, '1. a\n2. b\n3. c')
  s.replace(4, 9, '')
  eq(s.draft(), '1. a\n2. c', 'H3 auto-renumber still finds its composer behind another editor')
  alien.remove()
  s.unmount()
}
{
  const s = mount({ text: '1. a' })
  const twin = mount({ text: '', host: s.host }) // the same slot registered twice
  s.caret(4)
  press(s, 'H4 a duplicate registration stays inert', 'Enter', { shift: true }, { draft: '1. a\n2. ', caret: 8, edits: 1 })
  eq(document.listenerCount('keydown'), 1, 'H4 exactly one keydown listener drives the composer')
  twin.unmount()
  s.unmount()
}

// --- K. Toggle off a doubly-marked line keeps the content behind the caret --
{
  const s = mount({ text: '  * * b' })
  s.caret(4)
  press(s, 'K1 toggle off: the inner marker goes, the content stays', '*', { shift: true, meta: true, code: 'Digit8' }, { draft: '  * b', caret: 4, edits: 1 })
  press(s, 'K2 toggle off again removes the last marker', '*', { shift: true, meta: true, code: 'Digit8' }, { draft: '  b', caret: 2, edits: 1 })
  s.unmount()
  const sel = mount({ text: '- 1. a' })
  sel.caret(1)
  sel.key('a', { meta: true })
  sel.replace(0, 6, '- 1. a') // (selection toggles are covered by the pure suite)
  sel.unmount()
}

// --- I. Prompt optimize: abort, unlock, single flight --------------------
function stubFetch ( behaviour ) {
  const state = { calls: 0, signal: null }
  global.fetch = (url, options) => {
    state.calls += 1
    state.signal = options.signal
    return behaviour(options)
  }
  return state
}
const pendingForever = options => new Promise((_, reject) => {
  options.signal.addEventListener('abort', () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error) })
})

async function optimizeScenarios () {
  {
    const s = mount({ text: '写一份周报，包含本周进展和下周计划' })
    const net = stubFetch(pendingForever)
    const [optimizeButton] = s.buttons()
    eq(s.host.editable.getAttribute('contenteditable'), 'true', 'I0 composer editable before optimize')
    const flight = optimizeButton.props.onClick()
    eq(net.calls, 1, 'I1 one request per click')
    eq(s.host.editable.getAttribute('contenteditable'), 'false', 'I1 composer locked while optimizing')
    s.key('Escape')
    eq(net.signal.aborted, true, 'I2 Escape aborts the in-flight request')
    await flight
    eq(s.host.editable.getAttribute('contenteditable'), 'true', 'I3 composer unlocked after the abort')
    eq(s.draft(), '写一份周报，包含本周进展和下周计划', 'I3 the draft survives an aborted optimize')
    s.unmount()
  }
  {
    // The browser moves focus to <body> when the locked surface stops being focusable.
    const s = mount({ text: '写一份周报，包含本周进展和下周计划' })
    const net = stubFetch(pendingForever)
    const [optimizeButton] = s.buttons()
    const flight = optimizeButton.props.onClick()
    s.key('Escape', { target: document.body })
    eq(net.signal.aborted, true, 'I4 Escape still aborts when focus fell to the page')
    await flight
    eq(s.host.editable.getAttribute('contenteditable'), 'true', 'I4 composer unlocked')
    s.unmount()
  }
  {
    const s = mount({ text: '写一份周报，包含本周进展和下周计划' })
    const net = stubFetch(pendingForever)
    const [optimizeButton] = s.buttons()
    const first = optimizeButton.props.onClick()
    const second = optimizeButton.props.onClick() // same closure, before React re-rendered
    eq(net.calls, 1, 'I5 a second click never starts a second request')
    s.key('Escape')
    await Promise.all([first, second])
    s.unmount()
  }
  {
    const s = mount({ text: '写一份周报，包含本周进展和下周计划' })
    const net = stubFetch(pendingForever)
    const [optimizeButton] = s.buttons()
    const flight = optimizeButton.props.onClick()
    s.unmount() // the session switches (or the plugin is disabled) mid-flight
    eq(net.signal.aborted, true, 'I6 unmount aborts the orphan request')
    await flight
    eq(s.host.editable.isConnected, false, 'I6 (the disposed composer is gone)')
    delete global.fetch
  }
  {
    const reply = { ok: true, text: '1. 写周报\n- 包含本周进展' }
    const s = mount({ text: '写一份周报，包含本周进展' })
    stubFetch(async () => ({ ok: true, json: async () => reply }))
    const [optimizeButton] = s.buttons()
    await optimizeButton.props.onClick()
    s.flush()
    eq(s.draft(), reply.text, 'I7 the optimized text replaces the draft')
    eq(s.host.editable.getAttribute('contenteditable'), 'true', 'I7 composer unlocked')
    const [restoreButton] = s.buttons()
    await restoreButton.props.onClick()
    s.flush()
    eq(s.draft(), '写一份周报，包含本周进展', 'I7 the restore button brings the original back')
    delete global.fetch
    s.unmount()
  }
  {
    const s = mount({ text: '写一份周报，包含本周进展和下周计划' })
    stubFetch(async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }))
    let first = s.buttons()[0]
    const realError = console.error
    console.error = () => {} // the failure is expected here; its log is noise
    await first.props.onClick()
    console.error = realError
    s.flush()
    eq(s.draft(), '写一份周报，包含本周进展和下周计划', 'I8 a failed optimize keeps the draft')
    eq(s.host.editable.getAttribute('contenteditable'), 'true', 'I8 composer unlocked after a failure')
    first = s.buttons()[0]
    ok(String(first.props.class).includes('clp-error'), 'I8 the failure shows on the button')
    delete global.fetch
    s.unmount()
  }
}

// --- J. Random key sequences never throw, never loop ----------------------
{
  let seed = 20261123
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 }
  // Cmd+Shift+7/8 toggles arrive with the physical e.code (the key itself is '&' / '*').
  const KEYS = [
    ['Enter', { shift: true }], ['Backspace', {}], ['Tab', {}], ['Tab', { shift: true }],
    ['&', { shift: true, meta: true, code: 'Digit7' }], ['*', { shift: true, meta: true, code: 'Digit8' }],
    ['ArrowLeft', {}], ['ArrowRight', {}], ['Home', {}], ['b', { shift: true, meta: true }],
  ]
  const STARTS = ['1. a\n2. b\n3. c', '- a\n  - b', '1. a\n2. \n3. b', 'a. x\nplain', '  1. deep', '1. a\n\n2. b']
  let steps = 0
  let maxEdits = 0
  let problems = 0
  for (let round = 0; round < 60; round += 1) {
    const s = mount({ text: STARTS[Math.floor(rnd() * STARTS.length)], form: rnd() < 0.5 ? 'paragraphs' : 'single' })
    for (let n = 0; n < 12; n += 1) {
      if (rnd() < 0.25) s.caret(Math.floor(rnd() * (s.draft().length + 1)), { atBlockStart: rnd() < 0.5 })
      const before = s.edits().length
      const key = KEYS[Math.floor(rnd() * KEYS.length)]
      try { s.key(key[0], key[1]) } catch (error) { problems += 1; fail(`J random #${round}.${n} threw`, String(error && error.stack)) }
      const count = s.edits().length - before
      maxEdits = Math.max(maxEdits, count)
      if (s.draft().includes('\uFFFC')) { problems += 1; fail(`J random #${round}.${n} leaked U+FFFC`) }
      const caret = s.caret()
      if (caret === null || caret < 0 || caret > s.draft().length) { problems += 1; fail(`J random #${round}.${n} caret out of range`, show([caret, s.draft()])) }
      if (s.edits().some(edit => edit.ok === false)) { problems += 1; fail(`J random #${round}.${n} refused edit`, show(s.edits().slice(before))) }
      steps += 1
    }
    s.unmount()
  }
  eq(problems, 0, `J random sequences (${steps} key presses, at most ${maxEdits} edits per key)`)
}

optimizeScenarios().then(() => {
  cleanup()
  eq(document.listenerCount('keydown'), 0, 'Z every listener is removed on unmount')
  eq(document.listenerCount('beforeinput'), 0, 'Z beforeinput listener removed on unmount')
  eq(document.listenerCount('pointerdown'), 0, 'Z pointerdown listener removed on unmount')
  console.log(`\n${passes} passed, ${failures} failed`)
  process.exit(failures > 0 ? 1 : 0)
}).catch((error) => {
  console.error('runtime test harness crashed:', error)
  process.exit(1)
})
}
