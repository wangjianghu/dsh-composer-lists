// Performance benchmarks for the pure planning layer. The renumber effect
// runs renumberPlan on every draft commit and every keydown branch walks the
// planner stack, so per-call cost directly caps typing latency.
const path = require('path')

let definition = null
global.window = { __ModuleLoader__: { load (def) { definition = def } } }
global.Node = { TEXT_NODE: 3 }
global.document = { querySelector: () => null, addEventListener: () => {}, removeEventListener: () => {} }
require(path.join(__dirname, 'client.js'))

const noop = () => {}
const stubReact = {
  createElement: (...a) => ({ type: a[0], props: a[1] }),
  useState: (v) => [typeof v === 'function' ? v() : v, noop],
  useEffect: noop,
  useRef: () => ({ current: null }),
  useCallback: (fn) => fn,
}
const mod = definition.factory((id) => {
  if (id === 'react') return stubReact
  if (id === 'react-dom') return { createPortal: (el) => el }
  throw new Error('unexpected require: ' + id)
})
const P = mod._pure

const SETTINGS = {
  indentUnit: 4,
  autoRenumber: true,
  orderedStyles: ['arabic', 'letter', 'circle', 'paren', 'greek', 'arabic'],
  bulletStyles: ['-', '*', '+', '•', '○', '▪'],
}

function buildList (lines) {
  const out = []
  for (let i = 0; i < lines; i++) {
    const level = i % 4
    out.push(' '.repeat(level * 4) + (i % 3 === 2 ? '- ' : '1. ') + `item ${i} with some text`)
  }
  return out.join('\n')
}

function buildMixed (lines) {
  const out = []
  for (let i = 0; i < lines; i++) {
    if (i % 5 === 4) out.push('plain paragraph line ' + i)
    else out.push(' '.repeat((i % 3) * 4) + '9. item ' + i)
  }
  return out.join('\n')
}

function bench (label, text, fn, iterations) {
  fn(text) // warm-up + correctness smoke
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < iterations; i++) fn(text)
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / iterations
  console.log(`${label.padEnd(46)} ${ms.toFixed(3)} ms/call  (${(text.length / 1024).toFixed(0)} KB)`)
  return ms
}

console.log('composer-lists pure-layer benchmarks\n')

// Per-keystroke path: the renumber effect calls renumberPlan on every commit.
bench('renumberPlan warm 50 lines (typical draft)', buildList(50), (t) => P.renumberPlan(t, SETTINGS), 2000)
bench('renumberPlan warm 500 lines', buildList(500), (t) => P.renumberPlan(t, SETTINGS), 400)
bench('renumberPlan warm 2000 lines (stress)', buildList(2000), (t) => P.renumberPlan(t, SETTINGS), 100)
bench('renumberPlan cold 500 lines (all markers off)', buildMixed(500), (t) => P.renumberPlan(t, SETTINGS), 200)

// Gesture planners on a large selection.
bench('togglePlan 500 lines', buildList(500), (t) => P.togglePlan(t, 0, 499, 'ordered', SETTINGS), 200)
bench('indentPlan 500 lines', buildList(500), (t) => P.indentPlan(t, 0, 499, 1, SETTINGS), 200)
bench('indentPlan caret-mode 500 lines', buildList(500), (t) => P.indentPlan(t, 250, 250, 1, SETTINGS, 4000), 200)
bench('arrowJump 500 lines', buildList(500), (t) => P.arrowJump(t, 4000, -1), 200)
bench('backspacePlan 500 lines', buildList(500), (t) => P.backspacePlan(t, 4000, SETTINGS), 200)

// onlyMarkerEdit runs on every commit before renumberPlan.
const bigA = buildList(1000)
const bigB = bigA + '\nextra line changes the suffix'
bench('onlyMarkerEdit 1000 lines (equal)', bigA, (t) => P.onlyMarkerEdit(t, t), 200)
bench('onlyMarkerEdit 1000 lines (tail edit)', bigA, (t) => P.onlyMarkerEdit(t, bigB), 200)

// meaninglessText worst cases: long non-repeating input drives the
// fragment-repetition regex through all its alternatives.
let stress = ''
for (let i = 0; i < 25000; i++) stress += '策划四百'.charAt(i % 4) + String.fromCharCode(97 + (i % 26))
bench('meaninglessText 100 KB adversarial', stress, (t) => P.meaninglessText(t), 20)
bench('meaninglessText 60 KB digits', '0123456789'.repeat(6000), (t) => P.meaninglessText(t), 20)

// parseItem raw throughput.
const oneLine = '    1. item 42 with some text'
{
  const t0 = process.hrtime.bigint()
  const N = 200000
  for (let i = 0; i < N; i++) P.parseItem(oneLine)
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  console.log(`${'parseItem single line'.padEnd(46)} ${(ms / N * 1e6).toFixed(2)} ns/call`)
}
