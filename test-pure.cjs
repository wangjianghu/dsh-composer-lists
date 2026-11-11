// Test harness: load client.js with stubbed module table, exercise _pure.
const path = require('path')

let definition = null
global.window = {
  __ModuleLoader__: { load (def) { definition = def } },
}
global.Node = { TEXT_NODE: 3 }
global.document = { querySelector: () => null, addEventListener: () => {}, removeEventListener: () => {} }

require(path.join(__dirname, 'client.js'))

if (definition === null) throw new Error('client.js did not register with __ModuleLoader__')

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
  indentUnit: 2,
  autoRenumber: true,
  orderedStyles: ['arabic', 'letter', 'circle', 'paren', 'greek', 'arabic'],
  bulletStyles: ['-', '*', '+', '•', '○', '▪'],
}

let failures = 0
let passes = 0
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) {
    failures += 1
    console.error(`FAIL ${label}\n  actual   ${a}\n  expected ${b}`)
  } else {
    passes += 1
    console.log(`ok   ${label}`)
  }
}
const ok = (cond, label) => {
  if (cond !== true) {
    failures += 1
    console.error(`FAIL ${label}`)
  } else {
    passes += 1
    if (!label.startsWith('fuzz')) console.log(`ok   ${label}`)
  }
}
const apply = (text, plan) => text.slice(0, plan.start) + plan.text + text.slice(plan.end)

// --- renderOrderedCore ---
eq(P.renderOrderedCore('arabic', 3), '3.', 'render arabic')
eq(P.renderOrderedCore('letter', 1), 'a.', 'render letter 1')
eq(P.renderOrderedCore('letter', 27), 'aa.', 'render letter 27')
eq(P.renderOrderedCore('greek', 3), 'γ.', 'render greek')
eq(P.renderOrderedCore('paren', 12), '(12)', 'render paren')
eq(P.renderOrderedCore('circle', 3), '③', 'render circle 3')

// --- parseItem: every style ---
eq(P.parseItem('1. a'), { indent: '', indentLen: 0, ordered: true, num: 1, style: 'arabic', bullet: '-', coreLen: 2, rest: ' a', emptyItem: false }, 'parse arabic')
eq(P.parseItem('b. x'), { indent: '', indentLen: 0, ordered: true, num: 2, style: 'letter', bullet: '-', coreLen: 2, rest: ' x', emptyItem: false }, 'parse letter')
eq(P.parseItem('α. x'), { indent: '', indentLen: 0, ordered: true, num: 1, style: 'greek', bullet: '-', coreLen: 2, rest: ' x', emptyItem: false }, 'parse greek')
eq(P.parseItem('(4) x'), { indent: '', indentLen: 0, ordered: true, num: 4, style: 'paren', bullet: '-', coreLen: 3, rest: ' x', emptyItem: false }, 'parse paren')
eq(P.parseItem('③ x'), { indent: '', indentLen: 0, ordered: true, num: 3, style: 'circle', bullet: '-', coreLen: 1, rest: ' x', emptyItem: false }, 'parse circle')
eq(P.parseItem('- x'), { indent: '', indentLen: 0, ordered: false, num: null, style: 'arabic', bullet: '-', coreLen: 1, rest: ' x', emptyItem: false }, 'parse bullet')
eq(P.parseItem('plain'), null, 'parse non-item')

// --- renumberPlan: per-level styles ---
{
  const text = '1. a\n  1. x\n    1. y\n2. b'
  const plan = P.renumberPlan(text, SETTINGS)
  eq(apply(text, plan), '1. a\n  a. x\n    ① y\n2. b', 'renumber normalizes to level styles')
}
{
  const text = '1. a\n  3. x\n2. b'
  const plan = P.renumberPlan(text, SETTINGS)
  eq(apply(text, plan), '1. a\n  a. x\n2. b', 'renumber L2 letter style')
}
{
  const text = '5. a\n6. b'
  const plan = P.renumberPlan(text, SETTINGS)
  eq(apply(text, plan), '1. a\n2. b', 'renumber reset to 1')
}
{
  const text = '1. a\n  a. x\n  a. y\n2. b'
  const plan = P.renumberPlan(text, SETTINGS)
  eq(apply(text, plan), '1. a\n  a. x\n  b. y\n2. b', 'renumber letter sequence')
}
{
  const text = '1. a\n    9. deep\n2. b'
  const plan = P.renumberPlan(text, SETTINGS)
  eq(apply(text, plan), '1. a\n    ① deep\n2. b', 'renumber L3 circle style') // 4-space indent = level 2
}

// --- continuationPlan ---
{
  // Continuation follows the current line's own style (here arabic at L2).
  const r = P.continuationPlan('1. a\n  1. b', 9, 9, SETTINGS)
  eq({ consume: r.consume, text: r.plan.text }, { consume: true, text: '\n  2. ' }, 'continue keeps line style')
}
{
  const r = P.continuationPlan('a. x', 4, 4, SETTINGS)
  eq(r.plan.text, '\nb. ', 'continue letter next')
}
{
  const r = P.continuationPlan('① x', 3, 3, SETTINGS)
  eq(r.plan.text, '\n② ', 'continue circle next')
}
{
  // Empty item joins the previous line: no blank line remains.
  const r = P.continuationPlan('1. a\n2. b\n3. ', 13, 13, SETTINGS)
  eq(r.plan, { start: 9, end: 13, text: '' }, 'empty item exits into previous line')
}
{
  // First-line empty item joins the following line up.
  const r = P.continuationPlan('1. \n2. x', 3, 3, SETTINGS)
  eq(r.plan, { start: 0, end: 4, text: '' }, 'first empty item joins next line')
}
eq(P.continuationPlan('plain', 1, 1, SETTINGS).consume, false, 'plain line not consumed')

// --- backspacePlan: whole-marker deletion / level promotion ---
{
  const r = P.backspacePlan('1. a\n2. bc', 8, SETTINGS)
  eq({ consume: r.consume, plan: r.plan, mode: r.mode }, { consume: true, plan: { start: 5, end: 8, text: '' }, mode: 'delete' }, 'backspace deletes marker only')
}
{
  const r = P.backspacePlan('1. a\n2. ', 8, SETTINGS)
  eq({ consume: r.consume, plan: r.plan, mode: r.mode }, { consume: true, plan: { start: 4, end: 8, text: '' }, mode: 'exit' }, 'backspace empty item joins previous')
}
eq(P.backspacePlan('1. abc', 3, SETTINGS).consume, true, 'backspace at marker end')
eq(P.backspacePlan('1. abc', 5, SETTINGS).consume, false, 'backspace mid-content native')
eq(P.backspacePlan('plain', 3, SETTINGS).consume, false, 'backspace plain native')

// --- togglePlan: level styles + on/off cycling ---
eq(apply('a\nb', P.togglePlan('a\nb', 0, 1, 'ordered', SETTINGS)), '1. a\n2. b', 'toggle ordered on L1')
eq(apply('1. a\n2. b', P.togglePlan('1. a\n2. b', 0, 1, 'ordered', SETTINGS)), 'a\nb', 'toggle ordered off')
eq(apply('a\n  b', P.togglePlan('a\n  b', 0, 1, 'ordered', SETTINGS)), '1. a\n  a. b', 'toggle ordered per level')
eq(apply('x', P.togglePlan('x', 0, 0, 'bullet', SETTINGS)), '- x', 'toggle bullet on')
eq(apply('- x', P.togglePlan('- x', 0, 0, 'bullet', SETTINGS)), 'x', 'toggle bullet off')
eq(apply('* x', P.togglePlan('* x', 0, 0, 'bullet', SETTINGS)), 'x', 'toggle any bullet off')
eq(apply('1. x', P.togglePlan('1. x', 0, 0, 'bullet', SETTINGS)), '- x', 'ordered to bullet')

// --- indentPlan: level styles follow the shift ---
eq(apply('1. a', P.indentPlan('1. a', 0, 0, 1, SETTINGS)), '  a. a', 'indent demotes to L2 letter')
eq(apply('  a. a', P.indentPlan('  a. a', 0, 0, -1, SETTINGS)), '1. a', 'outdent promotes to L1 arabic')
eq(apply('1. a\n2. b', P.indentPlan('1. a\n2. b', 0, 1, 1, SETTINGS)), '  a. a\n  b. b', 'indent block renumbers as L2')
eq(apply('- x', P.indentPlan('- x', 0, 0, 1, SETTINGS)), '  * x', 'indent bullet follows level symbol')
eq(P.indentPlan('plain', 0, 0, 1, SETTINGS), null, 'indent plain line skipped')
eq(apply('1. a\nplain\n2. b', P.indentPlan('1. a\nplain\n2. b', 0, 2, 1, SETTINGS)), '  a. a\nplain\n  a. b', 'indent separate blocks number independently')
eq(apply('1. a\n  9. x\n2. b', P.indentPlan('1. a\n  9. x\n2. b', 1, 1, 1, SETTINGS)), '1. a\n    ① x\n2. b', 'indent nested item shifts two levels')

// --- indentPlan with a caret: level change keeps the caret position ---
{
  // Caret mid-content ('a'|bc): Tab demotes the line and the caret stays
  // between a and bc — the plan text ends exactly at the caret's content
  // offset (plan.start + plan.text.length is the new caret).
  const text = '1. a\n2. abc'
  const plan = P.indentPlan(text, 1, 1, 1, SETTINGS, 9)
  eq(apply(text, plan), '1. a\n  a. abc', 'caret Tab: line demotes')
  eq(plan.end, 9, 'caret Tab: replacement ends at the caret')
  eq(plan.start + plan.text.length, 11, 'caret Tab: new caret = same content offset (a|bc)')
}
{
  const text = '  a. abc'
  const plan = P.indentPlan(text, 0, 0, -1, SETTINGS, 7)
  eq(apply(text, plan), '1. abc', 'caret Shift+Tab: line promotes')
  eq(plan.start + plan.text.length, 5, 'caret Shift+Tab: new caret = same content offset (a|bc)')
}
{
  // Caret between marker and space: content offset clamps to 0, caret lands
  // right after the new marker.
  const text = '1. a'
  const plan = P.indentPlan(text, 0, 0, 1, SETTINGS, 2)
  eq(apply(text, plan), '  a. a', 'caret inside marker: clamps to marker end')
  eq(plan.start + plan.text.length, 5, 'caret inside marker: new caret after new marker')
}
{
  // Collapsed scope stops at the caret line; the following sibling renumbers
  // through the auto-renumber reaction instead of this plan.
  const text = '1. a\n2. b\n3. c'
  const plan = P.indentPlan(text, 1, 1, 1, SETTINGS, 6)
  eq(apply(text, plan), '1. a\n  a. b\n3. c', 'caret Tab: later sibling left to auto-renumber')
}

// --- line helpers ---
eq(P.lineBounds('ab\ncd\nef', 4), { start: 3, end: 5 }, 'lineBounds')
eq(P.lineRange('ab\ncd\nef', 1, 2), { start: 3, end: 8 }, 'lineRange')

// --- arrowJump: marker prefix is one hop for ← / → ---
eq(P.arrowJump('1. abc', 3, -1), 0, '← from marker right to line start in one hop')
eq(P.arrowJump('1. abc', 0, 1), 3, '→ from line start past marker in one hop')
eq(P.arrowJump('1. abc', 2, -1), null, '← mid-content native')
eq(P.arrowJump('1. abc', 3, 1), null, '→ from marker right native')
eq(P.arrowJump('1. abc', 0, -1), null, '← from line start native')
eq(P.arrowJump('plain', 2, -1), null, 'plain line has no marker hop')
eq(P.arrowJump('  - x', 4, -1), 0, '← hop covers indent plus bullet')
eq(P.arrowJump('  - x', 0, 1), 4, '→ hop lands after bullet and indent')
eq(P.arrowJump('1. a\n  b. x', 10, -1), 5, '← on L2 jumps to that line start')
eq(P.arrowJump('(12) x', 5, -1), 0, '← hop over paren marker')

// --- marker-scope plans: replacement ends at the marker, not the line end ---
{
  const plan = P.togglePlan('task text here', 0, 0, 'bullet', SETTINGS)
  eq({ start: plan.start, end: plan.end, text: plan.text }, { start: 0, end: 0, text: '- ' }, 'toggle plain replaces only the prefix')
}
{
  const plan = P.indentPlan('1. a\n2. b', 0, 1, 1, SETTINGS)
  eq({ end: plan.end, text: plan.text }, { end: 8, text: '  a. a\n  b. ' }, 'indent block ends at last marker')
}

// --- meaningless-text filter ---
eq(P.meaninglessText('策划四百'), true, 'meaningless: too short')
eq(P.meaninglessText('哈哈哈哈哈哈哈'), true, 'meaningless: single repeated char')
eq(P.meaninglessText('123456789'), true, 'meaningless: digits only')
eq(P.meaninglessText('!!!!????####'), true, 'meaningless: symbols only')
eq(P.meaninglessText('asdfasdf'), true, 'meaningless: repeated fragment')
eq(P.meaninglessText('策划四百策划四百'), true, 'meaningless: repeated CJK fragment')
eq(P.meaninglessText('帮我写一份周报，包含本周进展和下周计划'), false, 'meaningful CJK passes')
eq(P.meaninglessText('Write a weekly report with progress and plans'), false, 'meaningful EN passes')

// ====================================================================
// Regression & adversarial suite (2026-11 round)
// ====================================================================

// --- renderOrderedCore: alphabet math and overflow fallbacks ---
eq(P.renderOrderedCore('letter', 26), 'z.', 'letter 26')
eq(P.renderOrderedCore('letter', 27), 'aa.', 'letter 27 rolls to aa')
eq(P.renderOrderedCore('letter', 28), 'ab.', 'letter 28')
eq(P.renderOrderedCore('letter', 52), 'az.', 'letter 52')
eq(P.renderOrderedCore('letter', 702), 'zz.', 'letter 702 bijective base-26')
eq(P.renderOrderedCore('greek', 24), 'ω.', 'greek 24')
eq(P.renderOrderedCore('greek', 25), '25.', 'greek beyond ω falls back to arabic')
eq(P.renderOrderedCore('circle', 20), '⑳', 'circle 20')
eq(P.renderOrderedCore('circle', 21), '㉑', 'circle 21 second range')
eq(P.renderOrderedCore('circle', 50), '㊿', 'circle 50 last')
eq(P.renderOrderedCore('circle', 51), '51.', 'circle beyond 50 falls back')
eq(P.renderOrderedCore('arabic', 0), '0.', 'arabic 0 renders as-is')
eq(P.renderOrderedCore('arabic', -2), '-2.', 'arabic negative renders as-is')
eq(P.renderOrderedCore('arabic', 1.5), '1.5.', 'arabic non-integer renders as-is')
eq(P.renderOrderedCore('unknown', 3), '3.', 'unknown style falls back to arabic')

// --- parseItem: every accepted shape plus look-alike rejections ---
eq(P.parseItem('1) x'), { indent: '', indentLen: 0, ordered: true, num: 1, style: 'arabic', bullet: '-', coreLen: 2, rest: ' x', emptyItem: false }, 'parse arabic close paren')
eq(P.parseItem('12. x').coreLen, 3, 'parse two-digit arabic coreLen')
eq(P.parseItem('A. x').num, 1, 'parse uppercase letter normalizes to 1')
eq(P.parseItem('Z. x').num, 26, 'parse letter Z is 26')
eq(P.parseItem('1.').emptyItem, true, 'bare marker is an empty item')
eq(P.parseItem('- ').emptyItem, true, 'bare bullet is an empty item')
eq(P.parseItem('(12)').emptyItem, true, 'bare paren marker empty item')
eq(P.parseItem('①').emptyItem, true, 'bare circled marker empty item')
eq(P.parseItem('1.x'), null, 'marker without spacing is not an item')
eq(P.parseItem('--'), null, 'double dash is not an item')
eq(P.parseItem('--x'), null, 'double dash prefix rejected')
eq(P.parseItem('– x').bullet, '–', 'en dash bullet accepted')
eq(P.parseItem('0. x').num, 0, 'zero parses as item (renumber fixes it)')
eq(P.parseItem('\t1. x').indentLen, 1, 'tab indent counts one char')
eq(P.parseItem('      1. x').indentLen, 6, 'six-space indent')

// --- renumberPlan: never fights the user, normalizes multi-item blocks ---
eq(P.renumberPlan('5. x', SETTINGS), null, 'lone hand-numbered item untouched')
eq(P.renumberPlan('5. x\nplain', SETTINGS), null, 'plain neighbor does not form a block')
eq(P.renumberPlan('- x\n- y', SETTINGS), null, 'bullets untouched by auto renumber')
eq(apply('1. a\nb. x\n2. c', P.renumberPlan('1. a\nb. x\n2. c', SETTINGS)), '1. a\n2. x\n3. c', 'mixed styles normalized in one block')
eq(apply('0. a\n0. b', P.renumberPlan('0. a\n0. b', SETTINGS)), '1. a\n2. b', 'zero numbers renumbered')
{
  // Marker-scope shape: replacement ends at the last marker, text carries
  // full lines between but only the marker prefix of the last line.
  const plan = P.renumberPlan('5. a\n9. b', SETTINGS)
  eq({ start: plan.start, end: plan.end, text: plan.text }, { start: 0, end: 8, text: '1. a\n2. ' }, 'renumber plan marker scope')
}

// --- onlyMarkerEdit: hand marker edits suspend auto-renumber ---
eq(P.onlyMarkerEdit('1. a', '1. a'), true, 'identical drafts are marker-only')
eq(P.onlyMarkerEdit('1. a', '2. a'), true, 'hand digit edit suspended')
eq(P.onlyMarkerEdit('12. a', '1. a'), true, 'hand digit delete suspended')
eq(P.onlyMarkerEdit('1. a\n2. b', '1. a\n3. b'), true, 'later-line digit edit suspended')
eq(P.onlyMarkerEdit('1. a', '1. ab'), false, 'content edit renumbers')
eq(P.onlyMarkerEdit('1. a\n2. b', '1. a\n2. c'), false, 'later-line content edit renumbers')
eq(P.onlyMarkerEdit('a\nb', 'a\nb\nc'), false, 'line insertion is not a marker edit')
eq(P.onlyMarkerEdit('a\n1. x', 'a\nx'), false, 'marker deletion is not a marker edit')

// --- continuationPlan: every style, selection, exit join ---
eq(P.continuationPlan('- a\n- b', 4, 4, SETTINGS).plan.text, '\n- ', 'continue bullet')
eq(P.continuationPlan('(3) x', 5, 5, SETTINGS).plan.text, '\n(4) ', 'continue paren')
eq(P.continuationPlan('α. x', 4, 4, SETTINGS).plan.text, '\nβ. ', 'continue greek')
eq(P.continuationPlan('z. x', 4, 4, SETTINGS).plan.text, '\naa. ', 'continue letter rolls over')
eq(P.continuationPlan('1. abc', 2, 5, SETTINGS).plan, { start: 2, end: 5, text: '\n2. ' }, 'continue replaces selection')
eq(P.continuationPlan('1. abc', 5, 5, SETTINGS).plan, { start: 5, end: 5, text: '\n2. ' }, 'continue splits at caret')
eq(P.continuationPlan('1. ', 3, 3, SETTINGS).plan, { start: 0, end: 3, text: '' }, 'exit only item empties draft')
eq(P.continuationPlan('1. a\n2. \n3. b', 8, 8, SETTINGS).plan, { start: 4, end: 8, text: '' }, 'exit middle empty item')

// --- backspacePlan: marker-only deletion shapes ---
eq(P.backspacePlan('1.', 2, SETTINGS).plan, { start: 0, end: 2, text: '' }, 'bare marker deleted whole')
eq(apply('1.\tx', P.backspacePlan('1.\tx', 3, SETTINGS).plan), 'x', 'tab spacing deleted with marker')
eq(apply('1. x', P.backspacePlan('1. x', 2, SETTINGS).plan), 'x', 'caret between marker and space deletes both')
eq(P.backspacePlan('1. a\n2. bc', 9, SETTINGS).consume, false, 'caret in content native')

// --- backspacePlan: level promotion (L2+ marker backspace promotes a level) ---
{
  const r = P.backspacePlan('1. a\n  b. x', 10, SETTINGS)
  eq({ consume: r.consume, mode: r.mode }, { consume: true, mode: 'promote' }, 'L2 marker backspace promotes')
  eq(apply('1. a\n  b. x', r.plan), '1. a\n2. x', 'user example: b. promotes to 2.')
}
eq(apply('  b. x', P.backspacePlan('  b. x', 5, SETTINGS).plan), '1. x', 'lone L2 promotes to 1.')
eq(apply('  - x', P.backspacePlan('  - x', 4, SETTINGS).plan), '- x', 'L2 bullet promotes to L1 symbol')
eq(apply('    - x', P.backspacePlan('    - x', 6, SETTINGS).plan), '  * x', 'L3 bullet promotes to L2 symbol')
eq(apply('1. a\n  b. x\n    ① y', P.backspacePlan('1. a\n  b. x\n    ① y', 18, SETTINGS).plan), '1. a\n  a. x\n  b. y', 'L3 promotes to L2 and sibling renumbers')
eq(apply('1. a\n  b. x\n9. c', P.backspacePlan('1. a\n  b. x\n9. c', 10, SETTINGS).plan), '1. a\n2. x\n9. c', 'promote scope stops at the caret line')
eq(P.backspacePlan('1. a\n  b. x', 7, SETTINGS).mode, 'none', 'caret mid-marker is native')

// --- promote covers EMPTY level-2+ items (fresh Tab-indented marker lines) ---
{
  // The reported flow: '1. xxx' → Shift+Enter → Tab gives an empty L2 marker
  // line; Backspace at its marker must promote it to an empty L1 item.
  const r = P.backspacePlan('1. a\n  b. ', 9, SETTINGS)
  eq({ consume: r.consume, mode: r.mode }, { consume: true, mode: 'promote' }, 'empty L2 item promotes (user flow)')
  eq(apply('1. a\n  b. ', r.plan), '1. a\n2. ', 'empty L2 b. promotes to empty 2.')
}
{
  const r = P.backspacePlan('1. a\n  - ', 9, SETTINGS)
  eq(r.mode, 'promote', 'empty L2 bullet promotes, not exits')
  eq(apply('1. a\n  - ', r.plan), '1. a\n- ', 'empty L2 bullet promotes to L1 symbol')
}
eq(P.backspacePlan('1. a\n2. ', 8, SETTINGS).mode, 'exit', 'empty L1 item still exits')

// --- promote trigger: any non-zero indent, even off the unit grid ---
{
  // Hand-typed 2-space child under a 4-space unit: must still promote.
  const S4 = { ...SETTINGS, indentUnit: 4 }
  const r = P.backspacePlan('1. a\n  b. x', 10, S4)
  eq({ consume: r.consume, mode: r.mode }, { consume: true, mode: 'promote' }, 'off-grid 2-space indent promotes under unit 4')
  eq(apply('1. a\n  b. x', r.plan), '1. a\n2. x', 'off-grid promote lands the caret line as L1')
}
{
  const S4 = { ...SETTINGS, indentUnit: 4 }
  eq(apply('      b. x', P.backspacePlan('      b. x', 9, S4).plan), '  1. x', '6-space indent under unit 4 drops one unit to L1')
}

// --- togglePlan: mixed selections, empty lines, subsets ---
eq(apply('1. a\n- b', P.togglePlan('1. a\n- b', 0, 1, 'ordered', SETTINGS)), '1. a\n2. b', 'mixed to ordered')
eq(apply('x\n- y', P.togglePlan('x\n- y', 0, 1, 'ordered', SETTINGS)), '1. x\n2. y', 'plain and bullet to ordered')
eq(apply('', P.togglePlan('', 0, 0, 'ordered', SETTINGS)), '1. ', 'toggle on empty draft starts a list')
eq(apply('1. a\n2. b\n3. c', P.togglePlan('1. a\n2. b\n3. c', 1, 2, 'bullet', SETTINGS)), '1. a\n- b\n- c', 'toggle subset keeps other lines')
eq(apply('a. x\nb. y', P.togglePlan('a. x\nb. y', 0, 1, 'ordered', SETTINGS)), 'x\ny', 'any ordered kind toggles off')
eq(apply('  x', P.togglePlan('  x', 0, 0, 'bullet', SETTINGS)), '  * x', 'toggle keeps existing indent')

// --- indentPlan: level clamps and no-op guard ---
eq(apply('      1. x', P.indentPlan('      1. x', 0, 0, -1, SETTINGS)), '    ① x', 'outdent L3 restyles to L2 circle')
eq(apply('          ▪ x', P.indentPlan('          ▪ x', 0, 0, 1, SETTINGS)), '            ▪ x', 'indent past cap grows indent, marker stays L6')
eq(apply('  - ', P.indentPlan('  - ', 0, 0, 1, SETTINGS)), '    + ', 'indent empty item restyles bullet')
eq(P.indentPlan('1. x', 0, 0, -1, SETTINGS), null, 'outdent at top level is a no-op (native Tab)')
eq(apply('a. x', P.indentPlan('a. x', 0, 0, -1, SETTINGS)), '1. x', 'outdent at top still normalizes style')

// --- lineIndexOf ---
eq(P.lineIndexOf('ab\ncd\nef', 0), 0, 'lineIndexOf 0')
eq(P.lineIndexOf('ab\ncd\nef', 2), 0, 'lineIndexOf newline belongs to its line')
eq(P.lineIndexOf('ab\ncd\nef', 3), 1, 'lineIndexOf next line start')
eq(P.lineIndexOf('ab\ncd\nef', 8), 2, 'lineIndexOf clamps past end')
eq(P.lineIndexOf('', 0), 0, 'lineIndexOf empty text')

// --- meaninglessText: exact boundaries ---
eq(P.meaninglessText('abcdef'), false, 'exactly six chars passes')
eq(P.meaninglessText('abcde'), true, 'five chars too short')
eq(P.meaninglessText('ab cd ef'), false, 'whitespace stripped before measuring')
eq(P.meaninglessText('ababab'), true, 'two-char fragment repeated')
eq(P.meaninglessText('aabbcc'), false, 'six distinct chars not repeated')
eq(P.meaninglessText('一二三四五六'), false, 'six distinct CJK pass')
eq(P.meaninglessText('12345678901234567890'), true, 'digits only however long')

// --- renumber idempotency on tricky inputs ---
for (const text of ['1. a\n1. a\n1. a', '1. a\n  9. b\n    5. c\n2. d', 'a. x\nb. y', '(2) p\n(9) q']) {
  const once = apply(text, P.renumberPlan(text, SETTINGS))
  eq(P.renumberPlan(once, SETTINGS), null, `renumber idempotent: ${JSON.stringify(text)}`)
}

// ====================================================================
// Deterministic fuzz: no planner may throw or produce out-of-range plans
// ====================================================================
{
  let seed = 42
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 2 ** 32
  }
  const PIECES = ['', ' ', 'x', '1.', '2. ', '9. x', 'a. x', 'z. y', '- y', '* ', '• b', 'plain text', '  indent', '(3) z', '① w', 'α. v', '3) q', '\t', '0. zero', '5.']
  const validPlan = (text, plan, label) => {
    if (plan === null) return
    ok(Number.isInteger(plan.start) && Number.isInteger(plan.end), `${label} integer bounds`)
    ok(plan.start >= 0 && plan.end <= text.length && plan.start <= plan.end, `${label} within text`)
    ok(typeof plan.text === 'string', `${label} string payload`)
  }
  const ROUNDS = 400
  for (let n = 0; n < ROUNDS; n++) {
    const lineCount = 1 + Math.floor(rnd() * 8)
    const lines = []
    for (let i = 0; i < lineCount; i++) lines.push(PIECES[Math.floor(rnd() * PIECES.length)])
    const text = lines.join('\n')
    const caret = Math.floor(rnd() * (text.length + 1))
    const a = Math.floor(rnd() * lines.length)
    const b = Math.floor(rnd() * lines.length)
    const lo = Math.min(a, b)
    const hi = Math.max(a, b)
    const kind = rnd() < 0.5 ? 'bullet' : 'ordered'
    const dir = rnd() < 0.5 ? 1 : -1
    let threw = null
    try {
      const r0 = P.renumberPlan(text, SETTINGS)
      validPlan(text, r0, `fuzz renumber #${n}`)
      validPlan(text, P.togglePlan(text, lo, hi, kind, SETTINGS), `fuzz toggle #${n}`)
      validPlan(text, P.indentPlan(text, lo, hi, dir, SETTINGS), `fuzz indent #${n}`)
      const cp = P.continuationPlan(text, caret, caret, SETTINGS)
      validPlan(text, cp.plan, `fuzz continue #${n}`)
      const bp = P.backspacePlan(text, caret, SETTINGS)
      validPlan(text, bp.plan, `fuzz backspace #${n}`)
      // Arrow hop: null or an in-bounds offset.
      const hop = P.arrowJump(text, caret, dir)
      ok(hop === null || (hop >= 0 && hop <= text.length), `fuzz arrowJump #${n}`)
      const hopBack = P.arrowJump(text, caret, -dir)
      ok(hopBack === null || (hopBack >= 0 && hopBack <= text.length), `fuzz arrowJump back #${n}`)
      // Caret-mode indent: plan bounds plus a caret that stays inside the
      // resulting text (insertText parks it at end-of-text).
      const cip = P.indentPlan(text, lo, hi, dir, SETTINGS, caret)
      validPlan(text, cip, `fuzz indent caret #${n}`)
      if (cip !== null) {
        const newText = apply(text, cip)
        ok(cip.start + cip.text.length <= newText.length, `fuzz indent caret in-range #${n}`)
      }
      ok(typeof P.onlyMarkerEdit(text, r0 === null ? text : apply(text, r0)) === 'boolean', `fuzz onlyMarkerEdit #${n}`)
      if (r0 !== null) ok(P.renumberPlan(apply(text, r0), SETTINGS) === null, `fuzz renumber idempotent #${n}`)
    } catch (error) {
      threw = error
    }
    ok(threw === null, `fuzz no throw #${n} (${JSON.stringify(text)})`)
  }
  console.log(`ok   fuzz ×${ROUNDS} rounds (planner bounds, idempotency, no-throw)`)
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log(`\nall ${passes} tests passed`)
