/**
 * dsh-composer-lists — browser half.
 *
 * Automatic ordered/unordered list editing inside the DSH message composer,
 * following the composer's native keymap decisions:
 *
 *   Enter            → submit (native, untouched)
 *   Cmd/Ctrl+Enter   → accelerated submit (native, untouched)
 *   Shift+Enter      → line break; when the caret line is a list item, the
 *                      new line continues the list (next number / same
 *                      bullet, same indent). An empty item exits the list
 *                      by de-marker-ing into an empty plain line, so a
 *                      second break blanks a line after the list.
 *   Tab / Shift+Tab  → on list lines only: indent / outdent one level
 *   Cmd/Ctrl+Shift+8 → toggle unordered list on the caret line / selection
 *   Cmd/Ctrl+Shift+7 → toggle ordered list on the caret line / selection
 *                      (a collapsed caret keeps its content offset; the
 *                      renumbering the toggle implies on the surrounding
 *                      block folds into the same edit, so the auto-renumber
 *                      reaction never moves the caret afterwards)
 *
 * Ordered numbers are renumbered automatically after deletions or pastes.
 * Keyboard-only by design: the runtime renders no UI (a null component
 * mounted through the composer slot), so the composer is not crowded.
 *
 * All edits go through the session slot's `inputActions.insertText`
 * (one call = one undo step) in detect coordinates. Before any edit we
 * rebuild the detect projection from the editor DOM and require it to equal
 * the published `InputState.draft`; when the draft carries reference chips,
 * command chips or quotes the two projections diverge and the plugin stays
 * hands-off (insertText would simply fail, but we prefer not to guess).
 *
 * Three invariants the key handler and the auto-renumber reaction keep:
 *
 *   caret   insertText always parks the caret at the END of the inserted
 *           text. So every gesture is applied as an edit SET whose caret
 *           edit goes LAST and ends at the caret (lines after it renumber
 *           first); the reaction is folded into the same set. A reaction
 *           that has nothing ending at the caret (a line was just deleted)
 *           re-parks it with a content-neutral edit after the first changed
 *           marker instead of leaving it on the block's tail.
 *   undo    each insertText is its own undo entry, so the reaction must
 *           never answer Cmd+Z: the restored draft is exactly the state the
 *           user went back to, and re-fixing it made undo a no-op forever.
 *   scope   the key handler is a document-level capture listener: it only
 *           claims the composer its own button lives in (the host InputBar
 *           card), never another editor on the page, and one driver per
 *           composer even when the slot is registered twice.
 */
window.__ModuleLoader__.load({
  id: 'dsh-composer-lists',
  factory (require) {
    const React = require('react')
    const { createElement: h, useState, useEffect, useRef, useCallback } = React
    const { createPortal } = require('react-dom')

    // ------------------------------------------------------------------
    // Pure list-text helpers (also exercised by tests via _pure below).
    // ------------------------------------------------------------------

    /** Plugin version, mirrored into package.json — shown in the settings popover title. */
    const PLUGIN_VERSION = '1.4.0'

    /** Ordered marker styles: arabic `1.`, letter `a.`, greek `α.`, paren `(1)`, circle `①`. */
    const ORDERED_STYLES = ['arabic', 'letter', 'greek', 'paren', 'circle']
    /** Default per-level ordered styles (level 0 = `1.`, 1 = `a.`, 2 = `①`, …). */
    const DEFAULT_ORDERED = ['arabic', 'letter', 'circle', 'paren', 'greek', 'arabic']
    /** Default per-level bullet characters. */
    const DEFAULT_BULLETS = ['-', '*', '+', '•', '○', '▪']
    const BULLET_CHARS = ['-', '*', '+', '•', '○', '▪', '–']
    const LEVELS = DEFAULT_ORDERED.length

    const GREEK_LETTERS = 'αβγδεζηθικλμνξοπρστυφχψω'.split('')
    const CIRCLED_NUMBERS = (() => {
      const chars = []
      for (let u = 0x2460; u <= 0x2473; u += 1) chars.push(String.fromCodePoint(u))
      for (let u = 0x3251; u <= 0x325F; u += 1) chars.push(String.fromCodePoint(u))
      for (let u = 0x32B1; u <= 0x32BF; u += 1) chars.push(String.fromCodePoint(u))
      return chars
    })()

    /** `n` (1-based) rendered as one ordered marker core of the given style. */
    function renderOrderedCore (style, n) {
      if (n < 1 || !Number.isInteger(n)) return `${n}.`
      if (style === 'paren') return `(${n})`
      if (style === 'circle') {
        const c = CIRCLED_NUMBERS[n - 1]
        return c !== undefined ? c : `${n}.`
      }
      if (style === 'greek') {
        const c = GREEK_LETTERS[n - 1]
        return c !== undefined ? `${c}.` : `${n}.`
      }
      if (style === 'letter') {
        let v = n
        let s = ''
        while (v > 0) {
          const r = (v - 1) % 26
          s = String.fromCharCode(97 + r) + s
          v = Math.floor((v - 1) / 26)
        }
        return `${s}.`
      }
      return `${n}.`
    }

    /** 0-based nesting level of an item with `indentLen` leading spaces. */
    function levelOf (indentLen, unit) {
      return Math.max(0, Math.floor(indentLen / Math.max(2, unit)))
    }

    /**
     * Parse one draft line as a list item. Ordered markers recognize every
     * style (`1.` `1)` `a.` `α.` `(1)` `①`) plus the bullet characters.
     * @returns {null|{indent:string,indentLen:number,ordered:boolean,num:number|null,
     *   style:string,bullet:string,coreLen:number,rest:string,emptyItem:boolean}}
     */
    const LIST_RE = new RegExp(
      '^(\\s*)(?:'
      + '(\\d+)([.)])' // arabic
      + '|\\((\\d+)\\)' // paren
      + '|([\\u2460-\\u2473\\u3251-\\u325F\\u32B1-\\u32BF])' // circled
      + '|([a-zA-Z])([.)])' // letter
      + '|([\\u03B1\\u03B2\\u03B3\\u03B4\\u03B5\\u03B6\\u03B7\\u03B8\\u03B9\\u03BA\\u03BB\\u03BC\\u03BD\\u03BE\\u03BF\\u03C0\\u03C1\\u03C2\\u03C3\\u03C4\\u03C5\\u03C6\\u03C7\\u03C8\\u03C9])([.)])' // greek
      + '|([-*+\u2022\u25CB\u25AA\u2013])' // bullets
      + ')(?:[ \\t]|$)',
    )

    function parseItem (line) {
      const m = LIST_RE.exec(line)
      if (m === null) return null
      const indent = m[1] ?? ''
      let ordered = false
      let num = null
      let style = 'arabic'
      let bullet = '-'
      let coreLen = 0
      if (m[2] !== undefined) {
        ordered = true; num = Number(m[2]); style = 'arabic'
        coreLen = indent.length + m[2].length + 1
      } else if (m[4] !== undefined) {
        ordered = true; num = Number(m[4]); style = 'paren'
        coreLen = indent.length + m[4].length + 2
      } else if (m[5] !== undefined) {
        ordered = true; num = CIRCLED_NUMBERS.indexOf(m[5]) + 1; style = 'circle'
        coreLen = indent.length + 1
      } else if (m[6] !== undefined) {
        ordered = true; num = m[6].toLowerCase().charCodeAt(0) - 96; style = 'letter'
        coreLen = indent.length + 2
      } else if (m[8] !== undefined) {
        ordered = true; num = GREEK_LETTERS.indexOf(m[8]) + 1; style = 'greek'
        coreLen = indent.length + 2
      } else {
        bullet = m[10]
        coreLen = indent.length + 1
      }
      const rest = line.slice(coreLen)
      return {
        indent,
        indentLen: indent.length,
        ordered,
        num,
        style,
        bullet,
        coreLen,
        rest,
        emptyItem: rest.trim() === '',
      }
    }

    /** Line indexes [start, end) of the (0-based) line containing `offset`. */
    function lineBounds (text, offset) {
      const at = Math.max(0, Math.min(offset, text.length))
      const start = text.lastIndexOf('\n', at - 1) + 1
      let end = text.indexOf('\n', at)
      if (end < 0) end = text.length
      return { start, end }
    }

    /** Char range covering whole lines [a, b] of `text` (0-based, inclusive). */
    function lineRange (text, a, b) {
      const lines = text.split('\n')
      let start = 0
      for (let k = 0; k < a && k < lines.length; k++) start += lines[k].length + 1
      let end = start
      for (let k = a; k <= b && k < lines.length; k++) end += lines[k].length + (k < b ? 1 : 0)
      return { start, end }
    }

    function lineIndexOf (text, offset) {
      let index = 0
      let at = -1
      while (true) {
        const next = text.indexOf('\n', at + 1)
        if (next < 0 || next >= offset) return index
        index += 1
        at = next
      }
    }

    /** Char offset where each line of `lines` starts inside its joined text. */
    function lineStarts (lines) {
      const starts = new Array(lines.length)
      let at = 0
      for (let k = 0; k < lines.length; k += 1) {
        starts[k] = at
        at += lines[k].length + 1
      }
      return starts
    }

    /**
     * Rewrite the markers of every list block in `lines[i..j]`: ordered
     * numbers sequential per indent level in that level's configured style,
     * resetting when the list returns to a shallower level; where `force`
     * applies (an explicit level change) single-item blocks normalize too
     * and bullet chars follow each level's configured symbol. `force` is
     * `true` (every line), `false` (none) or the LAST line index up to which
     * it applies — so one pass can restyle the shifted lines and still
     * produce what the auto-renumber reaction would settle on for the rest
     * of the block. `lone` names ONE single-item block line (by index) whose
     * ordered marker also normalizes to the level's first marker — the line
     * an exit left behind.
     * Only `lines[i..j]` is parsed: callers pass sub-ranges of big drafts.
     * @returns {{out:string[], changed:number[]}}
     */
    function renumberLines (lines, i, j, settings, force, lone) {
      const unit = settings.indentUnit
      const forced = force === true
        ? () => true
        : typeof force === 'number' ? index => index <= force : () => false
      const items = new Array(lines.length)
      for (let k = Math.max(0, i); k <= Math.min(j, lines.length - 1); k += 1) items[k] = parseItem(lines[k])
      const out = lines.slice()
      const changed = []
      let k = i
      while (k <= j) {
        if (items[k] == null) { k += 1; continue }
        let e = k
        while (e + 1 <= j && items[e + 1] != null) e += 1
        const it0 = items[k]
        if (e > k || forced(k) || (lone !== undefined && e === k && it0.ordered)) {
          const counters = new Map()
          const stack = []
          for (let m = k; m <= e; m++) {
            const it = items[m]
            while (stack.length > 0 && stack[stack.length - 1] > it.indentLen) {
              counters.delete(stack.pop())
            }
            if (stack.length === 0 || stack[stack.length - 1] < it.indentLen) stack.push(it.indentLen)
            const level = Math.min(LEVELS - 1, levelOf(it.indentLen, unit))
            if (it.ordered) {
              const next = (counters.get(it.indentLen) ?? 0) + 1
              counters.set(it.indentLen, next)
              const core = renderOrderedCore(settings.orderedStyles[level], next)
              if (core !== lines[m].slice(it.indentLen, it.coreLen)) {
                out[m] = it.indent + core + ' ' + it.rest.replace(/^[ \t]/, '')
                changed.push(m)
              }
            } else if (forced(m) && settings.bulletStyles[level] !== it.bullet) {
              out[m] = it.indent + settings.bulletStyles[level] + ' ' + it.rest.replace(/^[ \t]/, '')
              changed.push(m)
            }
          }
        }
        k = e + 1
      }
      return { out, changed }
    }

    /**
     * Content-driven renumbering (typing, deleting, pasting): blocks with at
     * least two items, ordered markers only. Marker-scope replacement keeps
     * the caret near the edit instead of the block end. `lone` optionally
     * names one leftover single-item line whose marker restarts at 1.
     * @returns {null|{start:number,end:number,text:string}}
     */
    function renumberPlan (text, settings, lone) {
      const lines = text.split('\n')
      const { out, changed } = renumberLines(lines, 0, lines.length - 1, settings, false, lone)
      if (changed.length === 0) return null
      return scopePlan(lines, changed[0], changed[changed.length - 1], out)
    }

    /**
     * Whether the previous→next draft change is confined to one line's marker
     * prefix (the user editing a number/bullet by hand). Renumbering is
     * suspended for such edits so the caret never jumps under their cursor.
     */
    function onlyMarkerEdit (prev, next) {
      if (prev === next) return true
      let p = 0
      const n = Math.min(prev.length, next.length)
      while (p < n && prev.charAt(p) === next.charAt(p)) p += 1
      let s = 0
      while (s < n - p && prev.charAt(prev.length - 1 - s) === next.charAt(next.length - 1 - s)) s += 1
      const mid = prev.slice(p, prev.length - s)
      // Whatever was inserted must stay inside the same marker too: a whole
      // line pasted at a line start diffs as "nothing removed, an item
      // added" and is NOT a hand edit of the neighbour's marker.
      if (mid.includes('\n') || next.slice(p, next.length - s).includes('\n')) return false
      const lineStart = prev.lastIndexOf('\n', p - 1) + 1
      const lineEndPrev = prev.indexOf('\n', p)
      const it = parseItem(prev.slice(lineStart, lineEndPrev < 0 ? prev.length : lineEndPrev))
      if (it === null) return false
      if (p - lineStart > it.coreLen) return false
      // The line must still be an item afterwards: deleting a whole marker
      // turns its line plain, and the surrounding block should renumber
      // instead of staying suspended.
      const lineEndNext = next.indexOf('\n', p)
      const nextLine = next.slice(next.lastIndexOf('\n', p - 1) + 1, lineEndNext < 0 ? next.length : lineEndNext)
      const nextItem = parseItem(nextLine)
      if (nextItem === null) return false
      // A level change (indent grew or shrank) rewrites the whole line
      // prefix — that is a Tab / marker-backspace gesture, not a hand edit;
      // renumbering the surrounding block must still run.
      if (nextItem.indentLen !== it.indentLen) return false
      return true
    }

    /** Strip one marker (and its spacing space) from an item line. */
    function stripMarker (line) {
      const it = parseItem(line)
      if (it === null) return line
      return it.indent + it.rest.replace(/^[ \t]/, '')
    }

    /** Rewrite a line's marker, keeping indent and content. */
    function withMarker (line, marker) {
      const it = parseItem(line)
      const indent = it !== null ? it.indent : (line.match(/^[ \t]*/) ?? [''])[0]
      const content = it !== null ? it.rest.replace(/^[ \t]/, '') : line.slice(indent.length)
      return indent + marker + ' ' + content
    }

    /**
     * Length of one line's replaceable prefix: an item's marker plus its one
     * spacing space, or a plain line's leading indent (so converting a plain
     * line replaces its indent rather than stacking a second one).
     */
    function markerEndOf (line) {
      const it = parseItem(line)
      if (it === null) return (line.match(/^[ \t]*/) ?? [''])[0].length
      const spacing = line.charAt(it.coreLen) === ' ' || line.charAt(it.coreLen) === '\t' ? 1 : 0
      return it.coreLen + spacing
    }

    /**
     * Replacement plan covering line a's start through line b's OLD marker
     * end: rewriting only marker prefixes keeps the caret at the marker's
     * right side instead of jumping to the block end. Line b's content after
     * its marker stays in the document untouched.
     * @param {string[]} lines - the text, already split
     * @param {{oldEnd:number,newEnd:number}} [last] - line b's prefix lengths
     *   (old line / new line) when they differ from the plain marker ends
     */
    function scopePlan (lines, a, b, out, last) {
      const starts = lineStarts(lines)
      const pieces = []
      for (let k = a; k < b; k++) pieces.push(out[k])
      pieces.push(out[b].slice(0, last === undefined ? markerEndOf(out[b]) : last.newEnd))
      return { start: starts[a], end: starts[b] + (last === undefined ? markerEndOf(lines[b]) : last.oldEnd), text: pieces.join('\n') }
    }

    function markerScopePlan (text, a, b, out, last) {
      return scopePlan(text.split('\n'), a, b, out, last)
    }

    /**
     * Toggle a list kind over the line range [a, b]: every line already of
     * that kind turns it off; otherwise lines convert, using each level's
     * configured style. Pressing repeatedly cycles on/off.
     *
     * The conversion is then converged to the auto-renumber state (numbers
     * continue across the surrounding block, later siblings shift) inside
     * THIS edit: the renumber reaction's own insertText would park the
     * caret at ITS replacement end, dragging it away from the caret line.
     * With a collapsed `caret` the plan ends exactly at the caret's content
     * offset, so insertText parks it on the same content character (the
     * Tab/Shift+Tab treatment); marker rewrites the convergence needs
     * strictly AFTER the caret line are split into `pre`, which the caller
     * applies first so the caret edit goes last. Rewrites BEFORE the caret
     * line fold into the plan itself — its span may start earlier, the
     * caret target is unaffected.
     * @param {'bullet'|'ordered'} kind
     * @param {number} [caret] collapsed caret offset in `text` coordinates
     * @returns {{pre:{start:number,end:number,text:string}|null,
     *   plan:{start:number,end:number,text:string}}}
     */
    function togglePlan (text, a, b, kind, settings, caret) {
      const unit = settings.indentUnit
      const lines = text.split('\n')
      const last = Math.min(b, lines.length - 1)
      const items = []
      for (let k = a; k <= last; k++) items.push(parseItem(lines[k]))
      const allItems = items.every(it => it !== null)
      let remove = false
      if (allItems && items.length > 0) {
        remove = kind === 'bullet'
          ? items.every(it => !it.ordered)
          : items.every(it => it.ordered)
      }
      const out = lines.slice()
      const counters = new Map()
      let prevIndent = null
      for (let k = a; k <= last; k++) {
        const it = items[k - a]
        if (remove) {
          out[k] = stripMarker(lines[k])
          continue
        }
        const lead = it !== null ? it.indentLen : (lines[k].match(/^[ \t]*/) ?? [''])[0].length
        const level = Math.min(LEVELS - 1, levelOf(lead, unit))
        if (kind === 'bullet') {
          out[k] = withMarker(lines[k], settings.bulletStyles[level])
        } else {
          if (prevIndent === null || lead !== prevIndent) counters.set(lead, 0)
          counters.set(lead, (counters.get(lead) ?? 0) + 1)
          prevIndent = lead
          out[k] = withMarker(lines[k], renderOrderedCore(settings.orderedStyles[level], counters.get(lead)))
        }
      }
      // Converge to what the auto-renumber reaction would settle on; doing
      // it here keeps the reaction idle after the edit.
      const norm = renumberLines(out, 0, out.length - 1, settings, false).out
      let from = a
      for (let k = 0; k < a; k += 1) {
        if (norm[k] !== lines[k]) { from = k; break }
      }
      let firstTrail = -1
      let lastTrail = -1
      for (let k = last + 1; k < lines.length; k += 1) {
        if (norm[k] !== lines[k]) {
          if (firstTrail < 0) firstTrail = k
          lastTrail = k
        }
      }
      // A line stripped of its marker may still READ as an item ("1. 2. x" →
      // "2. x"): its new prefix is then the indent alone, and an inner marker
      // that needs renumbering converges inside the same edit. Re-reading
      // that prefix as a marker duplicated content ("- - x" toggle-off gave
      // "- xx") or made the key a no-op. The inner marker is measured
      // WITHOUT its indent (the indent is not part of what the old line's
      // outer marker replaced), or the plan would swallow the content after
      // the caret ("- - * b", caret after the outer marker, lost "b").
      const stripPrefix = (k) => {
        const outer = markerEndOf(lines[k])
        const indentLen = items[k - a].indentLen
        if (parseItem(out[k]) === null) return { oldEnd: outer, newEnd: indentLen }
        return { oldEnd: outer + markerEndOf(out[k]) - indentLen, newEnd: markerEndOf(norm[k]) }
      }
      if (caret === undefined) {
        // Selection: one marker-scope replacement reaching back/forward to
        // every line the convergence touched; the caret parks after the
        // final marker as before.
        const b = Math.max(last, lastTrail)
        return { pre: null, plan: markerScopePlan(text, from, b, norm, remove && b === last ? stripPrefix(last) : undefined) }
      }
      const lastStart = lineRange(text, last, last).start
      const lastEnd = lineRange(text, last, last).end
      // The handler always passes a caret on line `last`; clamp anyway so
      // an off-line caret can never pull the '\n' past the line end into
      // the replacement (which would overlap `pre`).
      const caretOnLine = Math.min(Math.max(caret, lastStart), lastEnd)
      const prefix = remove ? stripPrefix(last) : { oldEnd: markerEndOf(lines[last]), newEnd: markerEndOf(norm[last]) }
      const oldEnd = lastStart + prefix.oldEnd
      const contentOffset = Math.max(0, caretOnLine - oldEnd)
      const pieces = []
      for (let k = from; k < last; k++) pieces.push(norm[k])
      pieces.push(norm[last].slice(0, Math.min(norm[last].length, prefix.newEnd + contentOffset)))
      return {
        pre: firstTrail >= 0 ? markerScopePlan(text, firstTrail, lastTrail, norm) : null,
        plan: { start: lineRange(text, from, from).start, end: Math.max(caretOnLine, oldEnd), text: pieces.join('\n') },
      }
    }

    /**
     * Indent (`direction = 1`) or outdent (`-1`) the item lines in [a, b]:
     * after the shift, the whole surrounding block re-renders its markers in
     * each level's configured style (a demoted `2.` becomes `a.`, a promoted
     * `a.` becomes `1.`, bullets follow the level symbol). Non-item lines are
     * left untouched; when no line is an item the caller keeps native Tab.
     *
     * With a collapsed `caret` the plan ends at the caret (insertText then
     * parks it on the same content character) and covers the block only up
     * to the caret line; later siblings converge the way the auto-renumber
     * reaction would through `plan.pre` — applied FIRST by the caller, so
     * the caret edit stays last and the reaction stays idle (its own edit
     * would have dragged the caret onto a later line).
     * @returns {null|{start:number,end:number,text:string,pre?:{start:number,end:number,text:string}}}
     */
    function indentPlan (text, a, b, direction, settings, caret) {
      const unit = settings.indentUnit
      const lines = text.split('\n')
      const last = Math.min(b, lines.length - 1)
      const items = lines.map(parseItem)
      let any = false
      for (let k = a; k <= last; k++) {
        if (items[k] !== null) { any = true; break }
      }
      if (!any) return null
      // Extend to the whole list block so sibling markers re-number too.
      let i = a
      while (i > 0 && items[i - 1] !== null) i -= 1
      let j = last
      while (j + 1 < lines.length && items[j + 1] !== null) j += 1
      const shifted = lines.slice()
      for (let k = a; k <= last; k++) {
        const it = items[k]
        if (it === null) continue
        shifted[k] = direction > 0
          ? ' '.repeat(unit) + lines[k]
          : lines[k].slice(Math.min(unit, it.indentLen))
      }
      // ONE pass over the block: lines up to the caret line are restyled as
      // an explicit level change (single items and bullets included); the
      // later ones get exactly what the auto-renumber reaction would settle
      // on, so nothing is left for it to do.
      const { out } = renumberLines(shifted, i, j, settings, caret === undefined ? true : last)
      // A plan that would not change a single line (e.g. outdent at top
      // level with an already-normalized marker) must stay native so Tab
      // keeps its focus-move meaning instead of firing a no-op edit.
      let touched = false
      for (let k = i; k <= last; k += 1) {
        if (out[k] !== lines[k]) { touched = true; break }
      }
      if (!touched) return null
      if (caret === undefined) return markerScopePlan(text, i, j, out)
      // Caret-scoped plan: the last line carries the new prefix plus the
      // SAME content offset the caret had, and the replacement ends at the
      // caret — insertText then parks it exactly there. Clamp the caret to
      // its line so an off-line value can never pull a whole neighbour line
      // into the replacement.
      const lastStart = lineRange(text, last, last).start
      const lastEnd = lineRange(text, last, last).end
      const caretOnLine = Math.min(Math.max(caret, lastStart), lastEnd)
      const oldEnd = lastStart + markerEndOf(lines[last])
      const contentOffset = Math.max(0, caretOnLine - oldEnd)
      const newEnd = markerEndOf(out[last])
      const pieces = []
      for (let k = i; k < last; k++) pieces.push(out[k])
      pieces.push(out[last].slice(0, Math.min(out[last].length, newEnd + contentOffset)))
      const plan = { start: lineRange(text, i, i).start, end: Math.max(caretOnLine, oldEnd), text: pieces.join('\n') }
      // Later siblings (beyond `last`, restyled reaction-style by the same pass).
      let firstTrail = -1
      let lastTrail = -1
      for (let k = last + 1; k <= j; k += 1) {
        if (out[k] !== lines[k]) {
          if (firstTrail < 0) firstTrail = k
          lastTrail = k
        }
      }
      if (firstTrail >= 0) plan.pre = markerScopePlan(text, firstTrail, lastTrail, out)
      return plan
    }

    /**
     * Shift+Enter plan for the caret line: continue the list with the next
     * marker of the same level, or — on an empty item — exit the list by
     * stripping its marker and leaving an EMPTY PLAIN LINE in its place (the
     * caret parks at that line's start). The next Shift+Enter then runs
     * natively and opens a real blank line, so consecutive breaks after a
     * numbered/bulleted line can space out a paragraph (further breaks keep
     * blanking); only when the item is the draft's sole content does the
     * exit clear the draft entirely.
     * @returns {{consume:boolean, plan:{start:number,end:number,text:string}|null,
     *   exited:boolean}}
     */
    function continuationPlan (text, caretStart, caretEnd, settings) {
      caretStart = Math.max(0, Math.min(caretStart, text.length))
      caretEnd = Math.max(0, Math.min(caretEnd, text.length))
      const { start: lineStart, end: lineEnd } = lineBounds(text, caretStart)
      const line = text.slice(lineStart, lineEnd)
      const it = parseItem(line)
      if (it === null) return { consume: false, plan: null, exited: false }
      if (it.emptyItem) {
        // Insertion-type exit, landing the caret BELOW one blank line:
        // rewrite the PRECEDING newline plus the whole empty item — and
        // any run of blank lines that FOLLOWS it — as '\n\n'. Collapsing
        // the trailing blank run keeps the visual result identical to a
        // fresh exit instead of stacking new blanks onto old ones, and the
        // insertion's caret always parks at the end of the inserted text,
        // where the host's selection remapping cannot misplace it. A
        // selection extending past the blank run is replaced with it.
        let end = lineEnd
        while (text.charAt(end) === '\n') {
          const nl = text.indexOf('\n', end + 1)
          const nextEnd = nl < 0 ? text.length : nl
          if (nextEnd > end + 1) break // next line carries content: stop at its boundary
          end = nextEnd // swallow this blank line
        }
        end = Math.max(end, caretEnd)
        const plan = lineStart === 0
          ? { start: 0, end, text: '' } // first line: strip in place, collapsing its blank run too
          : { start: lineStart - 1, end, text: '\n\n' }
        return { consume: true, plan, exited: true }
      }
      // Continue with the current line's own style: the next marker feels
      // right even when the user hand-wrote a non-default style at this level.
      // A number too large for exact arithmetic (22+ digits) restarts at 1
      // instead of rendering scientific notation ("1e+22. ").
      const nextNumber = Number.isSafeInteger(it.num) ? it.num + 1 : 1
      const core = it.ordered
        ? renderOrderedCore(it.style, nextNumber)
        : it.bullet
      const insert = '\n' + it.indent + core + ' '
      return { consume: true, plan: { start: caretStart, end: Math.max(caretEnd, caretStart), text: insert }, exited: false }
    }

    /**
     * The edits that apply `plan` to `text` together with the renumbering it
     * causes, ordered so the caret ends where the user expects it. insertText
     * always parks the caret at the END of the inserted text, so the edit
     * that must own the caret is applied LAST:
     *
     *   main  — covers everything from the first renumbered line before the
     *           caret up to the caret itself. Applying it lands the caret on
     *           the same content character it would have had without the
     *           renumbering. Its span ends at plan.end, so `text` coordinates
     *           stay valid whatever was applied before it.
     *   right — renumbering that lies after the caret (plus nothing else),
     *           in `text` coordinates, rightmost first. Applied BEFORE main.
     *
     * `lone` optionally names the line (in the post-plan text) of a leftover
     * single-item block whose marker restarts at 1 — the item an exit left
     * under the blank line. `known` is that renumber plan when the caller
     * already computed it (the reaction does), saving a second full pass.
     * @param {{start:number,end:number,text:string}} plan
     * @returns {{main:{start:number,end:number,text:string}, right:{start:number,end:number,text:string}[]}}
     */
    function caretAnchoredEdits (text, plan, settings, lone, known) {
      const A = text.slice(0, plan.start) + plan.text + text.slice(plan.end)
      const C = plan.start + plan.text.length // where insertText leaves the caret
      const right = []
      let main = plan
      const renum = known !== undefined ? known : renumberPlan(A, settings, lone)
      if (renum !== null) {
        const T = A.slice(0, renum.start) + renum.text + A.slice(renum.end)
        const aLines = A.split('\n')
        const tLines = T.split('\n')
        // The caret's offset inside its own line survives the renumbering
        // even when that line's marker changes length or style: strictly
        // inside the old marker it keeps its offset (capped by the new one),
        // at the marker's end or past it the content offset is what is kept.
        const k = lineIndexOf(A, C)
        const inLine = C - lineStarts(aLines)[k]
        const startT = lineStarts(tLines)[k]
        const oldPrefix = markerEndOf(aLines[k])
        const newPrefix = markerEndOf(tLines[k])
        const caretT = Math.min(T.length, inLine < oldPrefix
          ? startT + Math.min(inLine, newPrefix)
          : startT + newPrefix + (inLine - oldPrefix))
        if (renum.start < C) {
          const from = Math.min(renum.start, plan.start)
          main = { start: from, end: plan.end, text: T.slice(from, caretT) }
        }
        if (renum.end > C) {
          const delta = plan.text.length - (plan.end - plan.start)
          const endT = T.length - (A.length - renum.end)
          right.push({ start: plan.end, end: renum.end - delta, text: T.slice(caretT, endT) })
        }
      }
      right.sort((p, q) => q.start - p.start)
      return { main, right }
    }

    /**
     * The auto-renumber reaction's edits for `plan`, keeping the caret where
     * the user's own edit left it (`caret`, a detect offset of `text`).
     *   - Something renumbered lies left of the caret: the main edit ends at
     *     the caret, the rest is applied first (see caretAnchoredEdits).
     *   - The caret sits ON the first renumbered line's start — or on the
     *     line break right before it, which is where deleting a whole line
     *     leaves it: one edit renumbers the range and parks the caret at
     *     its END (the block's tail); a second, content-neutral edit — the
     *     first line's new marker rewritten with itself, the Home/⌘←
     *     branch's mechanism — brings it back right after that line's marker.
     *     It changes no text, so it costs no revision and no undo step.
     *   - The caret sits elsewhere before the range: only the first edit
     *     applies.
     * @returns {{start:number,end:number,text:string}[]} applied in order;
     *   each one's coordinates are valid after the previous ones landed
     */
    function reactionEdits (text, plan, settings, caret) {
      if (caret > plan.start && caret <= text.length) {
        const { main, right } = caretAnchoredEdits(text, { start: caret, end: caret, text: '' }, settings, undefined, plan)
        return [...right, main]
      }
      const onRangeStart = caret === plan.start
        || (caret === plan.start - 1 && text.charAt(caret) === '\n')
      if (!onRangeStart) return [plan]
      const T = text.slice(0, plan.start) + plan.text + text.slice(plan.end)
      const tLines = T.split('\n')
      const a = lineIndexOf(text, plan.start)
      const prefix = markerEndOf(tLines[a])
      // Coordinates are in the draft AFTER `plan` applied (same start: the
      // range begins here, and its line keeps its index).
      return [plan, { start: plan.start, end: plan.start + prefix, text: tLines[a].slice(0, prefix) }]
    }

    /**
     * Line (in the post-exit text) of the item an empty-item exit left under
     * its blank line — the first non-empty line at or after the caret's.
     * Undefined when nothing follows. The renumber pass restarts that line's
     * marker at 1 when it is a lone ordered item ("3. b" → "1. b").
     */
    function exitLoneLine (afterText, caret) {
      const lines = afterText.split('\n')
      for (let m = lineIndexOf(afterText, caret); m < lines.length; m += 1) {
        if (lines[m].trim() !== '') return m
      }
      return undefined
    }

    /**
     * Pure decision for ONE Shift+Enter press — the entire keydown-branch
     * logic minus DOM plumbing and the renumber pre-run, so tests can drive
     * whole user sequences. `dom` carries the two DOM probes the branch
     * needs: `anchorBlockEmpty` (the caret's top-level block projects as
     * empty) and `anchorTextAfterContent` (the caret anchors in a text
     * node past its content, inside the previous line's block — the
     * "user put me at the list line's end" signal).
     * @returns {{kind:'insert', plan:{start:number,end:number,text:string},
     *   exited:boolean, renum:boolean}|{kind:'native'}}
     */
    function seDecision (text, spanStart, spanEnd, dom, exitPending, settings) {
      // Caret physically inside an EMPTY block: the user is visually on a
      // blank line. The native break inside an empty paragraph does not
      // accumulate a visible second blank line, and inserting '\n' at
      // either side of the block gap is equivalent — grow it ourselves.
      if (dom.anchorBlockEmpty) {
        return {
          kind: 'insert', renum: false, exited: false,
          plan: { start: Math.min(spanStart, spanEnd), end: Math.max(spanStart, spanEnd), text: '\n' },
        }
      }
      // Reverse gap disambiguation: a caret at the previous block's END
      // right before an empty line can project onto that empty line's
      // start; reattribute it to the previous line — EXCEPT right after
      // our own exit edit (exitPending), while the consecutive-break
      // blanking flow must keep going native-to-ourselves.
      let caretStart = Math.min(spanStart, spanEnd)
      const caretEnd = Math.max(spanStart, spanEnd)
      if (spanStart === spanEnd && caretStart > 0 && text.charAt(caretStart - 1) === '\n') {
        const probe = lineBounds(text, caretStart)
        if (!exitPending && probe.start === caretStart && probe.end === caretStart && dom.anchorTextAfterContent) {
          caretStart -= 1
        }
      }
      const { consume, plan, exited } = continuationPlan(text, caretStart, caretEnd, settings)
      if (consume) return { kind: 'insert', renum: true, exited, plan }
      // Not a list interaction. On an EMPTY line the native break inserts
      // TWO newlines at once next to existing breaks (observed
      // "1. a\n" → "1. a\n\n\n"), jumping the caret two lines — grow the
      // blank by exactly one ourselves.
      const lb = lineBounds(text, caretStart)
      if (lb.start === caretStart && lb.end === caretStart) {
        return {
          kind: 'insert', renum: false, exited: false,
          plan: { start: Math.min(spanStart, spanEnd), end: Math.max(spanStart, spanEnd), text: '\n' },
        }
      }
      return { kind: 'native' }
    }

    /**
     * Backspace plan for one whole-marker deletion: with the collapsed caret
     * right after a marker,
     *   - on a level-2+ item the backspace promotes the line one level and
     *     the caret lands right after the promoted marker on the same line —
     *   - on a level-1 item the marker (plus its spacing space) is removed
     *     in one stroke; on an empty item the whole line goes and the caret
     *     joins the previous line's end.
     * @returns {{consume:boolean, plan:{start:number,end:number,text:string}|null,
     *   mode:'none'|'promote'|'delete'|'exit'}}
     */
    function backspacePlan (text, caret, settings) {
      const { start: lineStart, end: lineEnd } = lineBounds(text, caret)
      const line = text.slice(lineStart, lineEnd)
      const it = parseItem(line)
      if (it === null) return { consume: false, plan: null, mode: 'none' }
      const after = caret - lineStart
      const spacing = line.charAt(it.coreLen) === ' ' || line.charAt(it.coreLen) === '\t' ? 1 : 0
      const atMarkerEnd = after === it.coreLen || after === it.coreLen + spacing
      if (!atMarkerEnd) return { consume: false, plan: null, mode: 'none' }
      // The plain (non-promote) outcome for this line.
      const firstLine = lineStart === 0
      const nextBreak = text.charAt(lineEnd) === '\n' ? lineEnd + 1 : lineEnd
      const plain = it.emptyItem
        ? (firstLine
            ? { start: 0, end: nextBreak, text: '' }
            : { start: lineStart - 1, end: lineEnd, text: '' })
        : { start: lineStart, end: lineStart + it.coreLen + spacing, text: '' }
      // Deleting a level promotes the line instead of stripping its marker —
      // empty items included (a fresh Tab-indented marker line promotes to an
      // empty parent-level item). Any non-zero indent counts: hand-typed
      // 2-space children under a 4-space unit must promote too.
      if (it.indentLen > 0) {
        const promoted = promotePlan(text, caret, settings)
        if (promoted !== null) return { consume: true, plan: promoted, mode: 'promote', fallback: plain }
      }
      return { consume: true, plan: plain, mode: it.emptyItem ? 'exit' : 'delete' }
    }

    /**
     * Level-promotion plan for the caret line (Backspace on a level-2+
     * marker): the line loses one indent unit, its marker restyles for the
     * shallower level, and the preceding list lines renumber to match. The
     * replacement scope stops at THIS line's marker so the caret lands right
     * after the promoted marker on the same line. Later siblings converge the
     * way the auto-renumber reaction would through `plan.pre` — applied
     * first by the caller, so the caret edit stays last.
     * @returns {null|{start:number,end:number,text:string,pre?:{start:number,end:number,text:string}}}
     */
    function promotePlan (text, caret, settings) {
      const unit = Math.max(2, settings.indentUnit)
      const lineIdx = lineIndexOf(text, caret)
      const lines = text.split('\n')
      const it = parseItem(lines[lineIdx])
      if (it === null || it.indentLen <= 0) return null
      const shifted = lines.slice()
      shifted[lineIdx] = lines[lineIdx].slice(Math.min(unit, it.indentLen))
      let i = lineIdx
      while (i > 0 && parseItem(lines[i - 1]) !== null) i -= 1
      let j = lineIdx
      while (j + 1 < lines.length && parseItem(lines[j + 1]) !== null) j += 1
      // One pass: lines up to this one restyle as the explicit level change
      // they are; the later siblings get what the auto-renumber reaction
      // would settle on (they ride on plan.pre).
      const { out } = renumberLines(shifted, i, j, settings, lineIdx)
      const plan = markerScopePlan(text, i, lineIdx, out)
      let firstTrail = -1
      let lastTrail = -1
      for (let k = lineIdx + 1; k <= j; k += 1) {
        if (out[k] !== lines[k]) {
          if (firstTrail < 0) firstTrail = k
          lastTrail = k
        }
      }
      if (firstTrail >= 0) plan.pre = markerScopePlan(text, firstTrail, lastTrail, out)
      return plan
    }

    /**
     * Horizontal caret hop over a marker prefix: one ← from just after the
     * marker reaches the line start (indent included), one → from the line
     * start reaches just past the marker — the marker behaves as one glyph.
     * @returns {number|null} target caret offset in `text`
     */
    function arrowJump (text, caret, direction) {
      const { start: lineStart, end: lineEnd } = lineBounds(text, caret)
      const line = text.slice(lineStart, lineEnd)
      if (parseItem(line) === null) return null
      const end = markerEndOf(line)
      if (end === 0) return null
      const after = caret - lineStart
      if (direction < 0 && after === end) return lineStart
      if (direction > 0 && after === 0) return lineStart + end
      return null
    }

    // ------------------------------------------------------------------
    // Editor DOM plumbing
    // ------------------------------------------------------------------

    const CONTENTEDITABLE_SELECTOR = '[contenteditable="true"]'
    /**
     * Host InputBar markers: the composer card (`data-composer-card`) and its
     * own text surface (`data-composer-input`). The key handler is a
     * document-level capture listener, so it must know WHICH editable is its
     * composer: the page may hold other contenteditable elements (another
     * plugin's editor, an inline rename field, a second composer instance).
     */
    const COMPOSER_CARD_SELECTOR = '[data-composer-card]'
    const COMPOSER_INPUT_SELECTOR = '[data-composer-input]'
    /**
     * Property (on the composer card) naming the runtime instance that
     * drives it. A registry symbol so it is shared ACROSS module instances:
     * a slot registered twice (a local copy next to the npm package) is two
     * closures, and both must not answer one key event.
     */
    const DRIVER = Symbol.for('dsh.composer-lists.driver')
    /** How long after Cmd+Z / the Edit menu a draft change may count as history navigation. */
    const HISTORY_NAV_WINDOW_MS = 2000

    /**
     * Whether any key branch may intercept this key. A cheap pre-filter so
     * ordinary typing and unrelated shortcuts never reach the document-wide
     * trigger-menu query.
     */
    function keyIsInterceptable (e) {
      const key = e.key
      if (key === 'Enter' || key === 'Backspace' || key === 'Tab' || key === 'Home'
        || key === 'ArrowLeft' || key === 'ArrowRight') return true
      return accelerated(e) && e.shiftKey && !e.altKey
        && (key === 'b' || key === 'B' || key === '&' || key === '*'
          || e.code === 'Digit7' || e.code === 'Numpad7' || e.code === 'Digit8' || e.code === 'Numpad8')
    }

    /**
     * Text of one composer block with the detect projection's rules, rebuilt
     * from DOM: Lexical text nodes mount as spans (recursed as text), the
     * atomic chips and quotes carry contenteditable="false" and count as one
     * U+FFFC, and <br> is a line break.
     */
    function blockText (node) {
      // A block whose ONLY content is one <br> — Lexical's empty-paragraph
      // placeholder, whether the <br> sits at the top level or nested in a
      // formatting span — projects as '' (the block gap already carries \n).
      // Top-level and nested placeholders must agree or every line index
      // built on the projection shifts by one.
      if (node.textContent === '' && node.querySelectorAll('br').length === 1) return ''
      const kids = Array.from(node.childNodes)
      let s = ''
      for (const ch of kids) {
        if (ch.nodeType === Node.TEXT_NODE) s += ch.data
        else if (ch.nodeName === 'BR') s += '\n'
        else if (ch.nodeType === Node.ELEMENT_NODE && ch.getAttribute('contenteditable') === 'false') s += '￼'
        else if (ch.nodeType === Node.ELEMENT_NODE) s += blockText(ch)
      }
      return s
    }

    /** The whole editor's detect projection, or null when it cannot be walked. */
    function detectTextOf (editable) {
      if (editable === null || !editable.isConnected) return null
      const blocks = Array.from(editable.children)
      if (blocks.length === 0) return ''
      return blocks.map(blockText).join('\n')
    }

    /**
     * The composer contenteditable this plugin drives: cached from key
     * events, resolved from the runtime's own composer card, or — without a
     * known card — the first contenteditable in the document.
     */
    const editableState = { current: null }

    /**
     * Whether `editable` is the composer the calling runtime belongs to.
     * `scope` is `{card, editable}`; without a scope (pure tests) or when the
     * host DOM is not recognised (`card === null`) every contenteditable is
     * claimed, as before scoping.
     */
    function ownsEditable (editable, scope) {
      if (scope === undefined || scope === null || scope.card === null) return true
      return editable === scope.editable
    }

    function editableFromTarget (target, scope) {
      if (target === null || target === undefined || typeof target.closest !== 'function') return null
      const editable = target.closest(CONTENTEDITABLE_SELECTOR)
      // Never claim ANOTHER editor: its text paired with OUR caret
      // coordinates would edit our draft at the wrong offsets.
      if (editable === null || !ownsEditable(editable, scope)) return null
      editableState.current = editable
      return editable
    }

    function currentEditable (scope) {
      if (scope !== undefined && scope !== null && scope.card !== null) {
        if (scope.editable !== null && scope.editable.isConnected) {
          editableState.current = scope.editable
          return scope.editable
        }
        return null // our composer's surface is gone: stay hands-off
      }
      if (editableState.current !== null && editableState.current.isConnected) return editableState.current
      editableState.current = document.querySelector(CONTENTEDITABLE_SELECTOR)
      return editableState.current
    }

    /**
     * Whether the browser caret sits at its block's very start. The detect
     * projection maps a paragraph gap offset to the END of the previous
     * block, so a caret clicked at a line's start needs this DOM check to
     * tell "start of this line" from "end of the previous line".
     */
    function domCaretAtBlockStart () {
      const sel = window.getSelection()
      if (sel === null || !sel.isCollapsed || sel.rangeCount === 0) return false
      const anchor = sel.anchorNode
      if (anchor === null) return false
      const editable = editableState.current
      if (editable === null) return false
      if (anchor.nodeType === Node.TEXT_NODE) {
        return sel.anchorOffset === 0 && anchor.previousSibling === null
      }
      return sel.anchorOffset === 0
    }

    /**
     * Index (into the editable's direct children) of the top-level block
     * containing the collapsed DOM caret, or -1 when it cannot be located.
     */
    function domAnchorBlockIndex () {
      const sel = window.getSelection()
      if (sel === null || !sel.isCollapsed || sel.rangeCount === 0) return -1
      const editable = editableState.current
      if (editable === null) return -1
      const anchor = sel.anchorNode
      if (anchor === null) return -1
      const blocks = Array.from(editable.children)
      for (let i = 0; i < blocks.length; i += 1) {
        if (blocks[i] === anchor || blocks[i].contains(anchor)) return i
      }
      return -1
    }

    /**
     * Index of the top-level block that the (0-based) projected `lineIdx`
     * of `text` lives in, walking the detect projection block by block.
     */
    function blockIndexOfLine (editable, text, lineIdx) {
      const blocks = Array.from(editable.children)
      let covered = 0
      for (let b = 0; b < blocks.length; b += 1) {
        const lines = blockText(blocks[b]).split('\n').length
        if (lineIdx < covered + lines) return b
        covered += lines
      }
      return -1
    }

    /** Whether the trigger candidate menu is open (its option rows carry these ids). */
    function menuOpen () {
      return document.querySelector('[id^="dsh-slash-option-"]') !== null
    }

    const composing = (e) => e.isComposing === true || e.keyCode === 229
    const accelerated = (e) => e.metaKey === true || e.ctrlKey === true

    /**
     * Move the collapsed caret `delta` characters through the DOM selection.
     * Lexical tracks the native selection inside its contenteditable, so
     * stepping it with Selection.modify is the one path a plugin has.
     */
    function moveCaretBy (delta) {
      const sel = window.getSelection()
      if (sel === null || !sel.isCollapsed || typeof sel.modify !== 'function') return
      const steps = Math.abs(delta)
      for (let i = 0; i < steps; i += 1) {
        sel.modify('move', delta < 0 ? 'backward' : 'forward', 'character')
      }
    }

    // ------------------------------------------------------------------
    // Component
    // ------------------------------------------------------------------

    const SETTINGS_KEY = 'dsh.composerLists.settings'
    const SETTINGS_VERSION = 2
    const DEFAULT_SETTINGS = {
      v: SETTINGS_VERSION,
      indentUnit: 4,
      autoRenumber: true,
      showOptimize: true,
      orderedStyles: [...DEFAULT_ORDERED],
      bulletStyles: [...DEFAULT_BULLETS],
    }

    /**
     * Whether a draft is too meaningless to optimize: too short, no letters
     * or CJK at all, a single repeated character, or a short fragment
     * repeated verbatim ("asdfasdf", "策划四百策划四百").
     */
    function meaninglessText (text) {
      const t = text.replace(/\s/g, '')
      if (t.length < 6) return true
      if (!/[\u4e00-\u9fa5a-zA-Z]/.test(t)) return true
      // At most two distinct characters: a short-circuit scan, not a Set
      // over the whole (up to 64 KB) input — this was the function's main cost.
      const first = t.charAt(0)
      let second = ''
      for (let i = 1; i < t.length; i += 1) {
        const ch = t.charAt(i)
        if (ch === first || ch === second) continue
        if (second === '') { second = ch; continue }
        // A third distinct character: only the repetition patterns remain.
        return /^(.)\1+$/.test(t) || /^(.{1,4}?)\1{1,}$/.test(t)
      }
      return true
    }

    function normalizeSettings (parsed) {
      const next = {
        v: SETTINGS_VERSION,
        indentUnit: [2, 4, 8].includes(parsed?.indentUnit) ? parsed.indentUnit : DEFAULT_SETTINGS.indentUnit,
        autoRenumber: typeof parsed?.autoRenumber === 'boolean' ? parsed.autoRenumber : DEFAULT_SETTINGS.autoRenumber,
        showOptimize: typeof parsed?.showOptimize === 'boolean' ? parsed.showOptimize : DEFAULT_SETTINGS.showOptimize,
        orderedStyles: [...DEFAULT_ORDERED],
        bulletStyles: [...DEFAULT_BULLETS],
      }
      if (Array.isArray(parsed?.orderedStyles)) {
        parsed.orderedStyles.slice(0, LEVELS).forEach((style, i) => {
          if (ORDERED_STYLES.includes(style)) next.orderedStyles[i] = style
        })
      }
      if (Array.isArray(parsed?.bulletStyles)) {
        parsed.bulletStyles.slice(0, LEVELS).forEach((bullet, i) => {
          if (BULLET_CHARS.includes(bullet)) next.bulletStyles[i] = bullet
        })
      }
      // v1 settings carried a single bullet char.
      if (typeof parsed?.bullet === 'string' && BULLET_CHARS.includes(parsed.bullet)) {
        next.bulletStyles[0] = parsed.bullet
      }
      return next
    }

    function loadSettings () {
      try {
        const raw = window.localStorage.getItem(SETTINGS_KEY)
        if (raw === null) return structuredClone(DEFAULT_SETTINGS)
        const parsed = JSON.parse(raw)
        // v2 bumps the default indent to 4; pre-v2 stored values reset once.
        if (parsed?.v !== SETTINGS_VERSION) return structuredClone(DEFAULT_SETTINGS)
        return normalizeSettings(parsed)
      } catch {
        return structuredClone(DEFAULT_SETTINGS)
      }
    }

    function saveSettings (settings) {
      try { window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)) } catch { /* private mode */ }
    }

    /**
     * Runtime mounted once per session through the composer slot: it owns
     * the keydown capture listener and the renumber reaction, and renders
     * exactly one compact settings button in the composer tool row.
     */
    function Runtime (props) {
      const useInput = props.useInput
      const t = props.t
      const tRef = useRef(t)
      tRef.current = t
      // useInput is a SnapshotSelectorHook: it takes a selector, not zero args.
      const input = typeof useInput === 'function' ? useInput((s) => s) : null
      const inputRef = useRef(null)
      inputRef.current = input
      const actionsRef = useRef(null)
      actionsRef.current = props.inputActions
      const [settings, setSettings] = useState(loadSettings)
      const settingsRef = useRef(settings)
      settingsRef.current = settings
      const prevDraftRef = useRef(undefined)
      const [menuRect, setMenuRect] = useState(null)
      const optimizingRef = useRef(false)

      /**
       * WHICH composer this runtime belongs to: the host InputBar card its
       * own button is rendered in, and that card's text surface. Resolved
       * from the button's DOM position and cached while both stay connected.
       * A scope with `card === null` means "host DOM not recognised" and
       * falls back to the historical any-contenteditable lookups.
       */
      const rootRef = useRef(null)
      const composerRef = useRef(null)
      const resolveComposer = useCallback(() => {
        const root = rootRef.current
        // The lookup walks up to the card, so cache it — the MISS too (an
        // unrecognised host DOM must not turn every key into a tree walk.
        // A button re-mounted elsewhere (new root or new parent) re-resolves.
        const parent = root !== null && root.isConnected ? root.parentNode : null
        const cached = composerRef.current
        if (cached !== null && cached.root === root && cached.parent === parent
          && (cached.card === null || (cached.card.isConnected && cached.editable !== null && cached.editable.isConnected))) {
          return cached
        }
        const card = root !== null && typeof root.closest === 'function' ? root.closest(COMPOSER_CARD_SELECTOR) : null
        const editable = card !== null
          ? (card.querySelector(COMPOSER_INPUT_SELECTOR) ?? card.querySelector(CONTENTEDITABLE_SELECTOR))
          : null
        const scope = { root, parent, card, editable }
        composerRef.current = scope
        return scope
      }, [])
      /** This instance's identity in the per-composer driver table. */
      const token = useRef({})
      /** Claim the composer for this instance; false when another one drives it. */
      const claimComposer = useCallback((scope) => {
        const card = scope === undefined || scope === null ? null : scope.card
        if (card === null) return true
        if (card[DRIVER] === undefined) card[DRIVER] = token
        return card[DRIVER] === token
      }, [])
      /**
       * History navigation the next draft change comes from: 'undo' /
       * 'redo' when the user pressed Cmd/Ctrl+Z, Cmd+Shift+Z, Ctrl+Y or used
       * the Edit menu (beforeinput historyUndo/historyRedo), else null. Any
       * other key or input clears it. The renumber reaction must not answer
       * an undo: the restored draft is exactly a state the user deliberately
       * went back to, and re-fixing it would make Cmd+Z a no-op forever.
       */
      const historyNavRef = useRef(null)
      const historyNavAtRef = useRef(0)
      /** The reaction's own last transition, to recognise an undo of it. */
      const lastReactionRef = useRef(null)
      /** The surface locked while a prompt optimization is in flight. */
      const lockRef = useRef(null)

      /**
       * The live draft text rebuilt from the editor DOM. Keyboard handlers
       * read this instead of the React-published `InputState.draft`, which
       * lags one commit behind fast typing — the lag made a Shift+Enter right
       * after typing see a stale line (an "empty item") and swallow the key.
       * Returns null while the editor cannot be walked or holds atomic chips.
       */
      const liveText = useCallback((editable) => {
        const text = detectTextOf(editable)
        if (text === null || text.includes('￼')) return null
        return text
      }, [])

      /**
       * Run one text-plane edit in live-DOM coordinates.
       */
      const applyPlan = useCallback((plan, editable) => {
        if (plan === null || actionsRef.current === null) return false
        const target = editable ?? currentEditable(resolveComposer())
        const state = inputRef.current
        if (target === null || state === null) return false
        if (state.phase !== 'plain' && state.phase !== 'claimed') return false
        const span = actionsRef.current.captureInsertion()
        if (span === undefined) return false
        return actionsRef.current.insertText(plan.text, {
          start: plan.start,
          end: plan.end,
          draftRev: span.draftRev,
        })
      }, [liveText, resolveComposer])

      /** Whole-line selection range + line indexes in live-DOM coordinates. */
      const selectionLines = useCallback((editable) => {
        const actions = actionsRef.current
        if (actions === null) return null
        const text = liveText(editable)
        if (text === null) return null
        const span = actions.captureInsertion()
        if (span === undefined) return null
        const collapsed = span.start === span.end
        let caretProbe = collapsed ? span.start : Math.max(span.start, span.end - 1)
        // A caret on the gap maps to the previous line's end; when the DOM
        // says it is at a block's start, attribute it to the next line.
        if (collapsed && span.start < text.length && text.charAt(span.start) === '\n' && domCaretAtBlockStart()) {
          caretProbe = span.start + 1
        }
        const a = lineIndexOf(text, Math.min(span.start, span.end))
        const b = lineIndexOf(text, caretProbe)
        return { span, a: Math.min(a, b), b: Math.max(a, b), collapsed, text }
      }, [liveText])

      // Keyboard: Shift+Enter continuation, Backspace marker deletion, Tab
      // indent, Cmd/Ctrl+Shift+7/8 — all on the live DOM text.
      useEffect(() => {
        // True while the caret still rests where our own empty-item exit edit
        // left it: the next Shift+Enter keeps blanking natively. Any user
        // caret placement (pointer, arrows, typing) clears it so a caret
        // deliberately moved to a list line's end continues the list again.
        let exitPending = false
        const exitPendingClearingKey = /^(Arrow(Left|Right|Up|Down)|Home|End|Page(Up|Down)|Backspace|Delete|Tab)$/
        // Effect lifetime + pending caret-descent frame, cancelled on cleanup
        // so a hot-reloaded/unmounted Runtime never touches the DOM again.
        let disposed = false
        let descentRaf = 0
        /**
         * Apply caret-anchored edits: the right-side ones first (rightmost
         * first, all in text coordinates), the caret edit last — the edit
         * applied last is where insertText parks the caret. Reports whether
         * anything landed and whether the caret edit itself did.
         */
        const applyEdits = (edits, editable) => {
          let applied = 0
          for (const edit of edits.right) if (applyPlan(edit, editable)) applied += 1
          const okMain = applyPlan(edits.main, editable)
          return { any: okMain || applied > 0, okMain }
        }
        // The composer is ONE paragraph whose line breaks are first literal
        // '\n' text and later — after the host's normalization pass — <br>
        // nodes; the selection the edit left behind maps to BEFORE the
        // trailing <br>, i.e. the END of the list line (log-proven). The
        // caret must only move DOWN through breaks, so after an exit edit:
        // poll until normalization has produced the trailing <br> (or an
        // empty following block appears), then move the caret past it and
        // re-assert for a few frames against host selection restores. Stop
        // as soon as the user takes over (exitPending cleared).
        const queueCaretDescent = () => {
          let tries = 0
          const step = () => {
            if (!exitPending || disposed || document.hidden || tries >= 20) return
            tries += 1
            const editable = currentEditable(resolveComposer())
            if (editable === null || !editable.isConnected) return
            const anchorBlock = domAnchorBlockIndex()
            if (anchorBlock < 0) { descentRaf = requestAnimationFrame(step); return }
            const blocks = Array.from(editable.children)
            const cur = blocks[anchorBlock]
            if (cur === undefined) return
            const curText = blockText(cur)
            const next = blocks[anchorBlock + 1]
            const sel = window.getSelection()
            if (sel === null || !sel.isCollapsed || sel.rangeCount === 0) return
            const target = document.createRange()
            if (next !== undefined && blockText(next) === '') {
              target.selectNodeContents(next)
              target.collapse(true)
            } else if (next === undefined && curText.endsWith('\n')) {
              const brs = cur.querySelectorAll('br')
              const br = brs.length > 0 ? brs[brs.length - 1] : null
              if (br === null) {
                // Normalization ('\n' text → <br>) has not run yet: wait.
                descentRaf = requestAnimationFrame(step)
                return
              }
              target.setStartAfter(br)
              target.collapse(true)
            } else {
              return
            }
            const curRange = sel.getRangeAt(0)
            if (curRange.compareBoundaryPoints(Range.END_TO_START, target) >= 0) {
              // Already parked on the blank line; keep re-asserting a bit
              // in case the host restores its own selection.
              descentRaf = requestAnimationFrame(step)
              return
            }
            sel.removeAllRanges()
            sel.addRange(target)
            descentRaf = requestAnimationFrame(step)
          }
          descentRaf = requestAnimationFrame(step)
        }
        // TEMPORARY diagnostics removed (v1.2.0): the exit-caret bug was
        // located with per-Shift+Enter console logs and fixed.
        /** The history chord the user pressed, if any: 'undo' | 'redo'. */
        const historyNavOf = (e) => {
          if (!(e.metaKey || e.ctrlKey) || e.altKey) return null
          const lower = e.key.toLowerCase()
          if (lower === 'z') return e.shiftKey ? 'redo' : 'undo'
          if (lower === 'y' && e.ctrlKey) return 'redo'
          return null
        }
        /**
         * Keys aimed at the frozen composer while a prompt optimization is
         * in flight. Every such key is swallowed and Escape aborts. This MUST
         * run before the contenteditable lookup: the lock has already turned
         * the surface contenteditable="false", so that lookup no longer
         * matches it (Escape could never reach the abort).
         */
        const handleFrozenKey = (e) => {
          const locked = lockRef.current !== null ? lockRef.current.editable : null
          const inside = locked !== null && (e.target === locked
            || (typeof locked.contains === 'function' && locked.contains(e.target)))
          // Another editable holds the focus (a dialog input, another
          // editor): its own Escape is none of our business.
          const elsewhere = e.target !== null && e.target !== undefined
            && typeof e.target.closest === 'function'
            && e.target.closest('input, textarea, select, [contenteditable="true"]') !== null
          if (!inside && !(e.key === 'Escape' && !elsewhere)) return false
          if (e.key === 'Escape' && abortRef.current !== null) abortRef.current.abort()
          e.preventDefault()
          e.stopPropagation()
          return true
        }
        const onKey = (e) => {
          const state = inputRef.current
          const actions = actionsRef.current
          if (state === null || actions === null) return
          if (state.phase !== 'plain' && state.phase !== 'claimed') return
          if (composing(e)) return
          if (optimizingRef.current && handleFrozenKey(e)) return
          const scope = resolveComposer()
          if (!claimComposer(scope)) return
          const editable = editableFromTarget(e.target, scope)
          if (editable === null) return
          if (e.key !== 'Enter'
            && (exitPendingClearingKey.test(e.key) || e.key.length === 1)) exitPending = false
          // Submit (plain Enter) clears the draft: the stale exitPending
          // must not leak into the next message's first Shift+Enter.
          if (e.key === 'Enter' && !e.shiftKey) exitPending = false
          // Remember an undo/redo chord: the draft change it is about to
          // cause must not be answered by the renumber reaction. Every other
          // key clears the signal.
          historyNavRef.current = historyNavOf(e)
          if (historyNavRef.current !== null) historyNavAtRef.current = Date.now()
          // Only keys a branch below may intercept yield to an open trigger
          // menu; every other key (plain typing, Cmd shortcuts) skips the
          // document-wide menu query entirely.
          if (keyIsInterceptable(e) && menuOpen()) return

          const key = e.key
          if (key === 'Enter' && e.shiftKey && !e.altKey && !accelerated(e)) {
            const span = actions.captureInsertion()
            if (span === undefined) return
            const text = liveText(editable)
            if (text === null) return
            // DOM probes fed to the pure per-press decision (seDecision):
            // the caret's top-level block emptiness, and whether the caret
            // anchors in a text node past content inside the previous
            // line's block ("user placed me at the list line's end").
            const anchorBlock = domAnchorBlockIndex()
            const sel = window.getSelection()
            // seDecision consults this probe only to disambiguate a caret on
            // a line break; anywhere else skip the block walk it costs.
            const caretMin = Math.min(span.start, span.end)
            const onLineBreak = caretMin > 0 && text.charAt(caretMin - 1) === '\n'
            const anchorTextAfterContent = onLineBreak && sel !== null && sel.isCollapsed
              && sel.anchorNode !== null
              && sel.anchorNode.nodeType === Node.TEXT_NODE
              && sel.anchorOffset > 0
              && anchorBlock >= 0
              && anchorBlock === blockIndexOfLine(editable, text, lineIndexOf(text, caretMin - 1))
            const decision = seDecision(text, span.start, span.end, {
              anchorBlockEmpty: anchorBlock >= 0 && blockText(editable.children[anchorBlock]) === '',
              anchorTextAfterContent,
            }, exitPending, settingsRef.current)
            if (decision.kind === 'native') return
            const { plan, exited, renum: withRenum } = decision
            if (!withRenum) {
              // Blank-line growth: a bare '\n' with no renumbering.
              const okBlank = actions.insertText(plan.text, {
                start: plan.start, end: plan.end, draftRev: span.draftRev,
              })
              if (okBlank) {
                e.preventDefault()
                e.stopPropagation()
              }
              return
            }
            // Apply the renumbering this insertion causes TOGETHER with it,
            // caret edit LAST: insertText parks the caret at the end of the
            // inserted text, so the edit that must own the caret goes last
            // and everything right of it goes first. preventDefault only
            // once an edit landed — a refused edit (phase change / rev CAS)
            // must never swallow the keypress. An exit also restarts the
            // lone ordered item it leaves under the blank line.
            const afterText = text.slice(0, plan.start) + plan.text + text.slice(plan.end)
            const lone = exited ? exitLoneLine(afterText, plan.start + plan.text.length) : undefined
            const landed = applyEdits(caretAnchoredEdits(text, plan, settingsRef.current, lone), editable)
            if (landed.any) {
              e.preventDefault()
              e.stopPropagation()
            }
            exitPending = exited && landed.okMain
            if (exitPending) queueCaretDescent()
            return
          }
          if (key === 'Backspace' && !e.altKey && !e.metaKey && !e.ctrlKey) {
            const span = actions.captureInsertion()
            if (span === undefined || span.start !== span.end) return
            const text = liveText(editable)
            if (text === null) return
            const { consume, plan: bsPlan, mode, fallback } = backspacePlan(text, span.start, settingsRef.current)
            if (!consume) return
            // Edits land first, preventDefault only once one did (see the
            // Shift+Enter branch). Promote may fall back to the plain plan.
            let landed
            if (mode === 'promote') {
              // Level promotion: the plan renormalizes the block up to this
              // line and its scope drops the caret right after the promoted
              // marker; later siblings ride on plan.pre (applied first).
              landed = applyEdits({ main: bsPlan, right: bsPlan.pre === undefined ? [] : [bsPlan.pre] }, editable)
              if (!landed.okMain) {
                // The caret edit was refused (phase change / rev CAS): never
                // swallow the key — fall back to the plain marker deletion.
                console.error('[composer-lists] promote edit refused; falling back to plain marker deletion')
                if (fallback === undefined) {
                  if (landed.any) {
                    e.preventDefault()
                    e.stopPropagation()
                  }
                  return
                }
                if (landed.any) {
                  // The trailing renumber already landed; it lies after this
                  // line, so the plain plan's coordinates are still intact.
                  landed = { any: true, okMain: applyPlan(fallback, editable) }
                } else {
                  landed = applyEdits(caretAnchoredEdits(text, fallback, settingsRef.current), editable)
                }
              }
            } else {
              // The deletion runs LAST so the caret lands on the deletion
              // point; the renumbering it causes is folded around the caret.
              landed = applyEdits(caretAnchoredEdits(text, bsPlan, settingsRef.current), editable)
            }
            if (landed.any) {
              e.preventDefault()
              e.stopPropagation()
            }
            return
          }
          if (accelerated(e) && e.shiftKey && !e.altKey && (key === 'b' || key === 'B')) {
            // Bold toggle: wrap or unwrap the selection with **. Plain ⌘B is
            // the desktop menu accelerator (sidebar toggle) and never reaches
            // the page, so the composer intercepts ⌘⇧B instead.
            const span = actions.captureInsertion()
            const text = liveText(editable)
            if (span === undefined || text === null) return
            const sel = text.slice(span.start, span.end)
            const plan = sel.length >= 4 && sel.startsWith('**') && sel.endsWith('**')
              ? { start: span.start, end: span.end, text: sel.slice(2, -2) }
              : {
                  start: span.start,
                  end: span.end,
                  text: sel === '' ? `**${tRef.current('boldText')}**` : `**${sel}**`,
                }
            if (actions.insertText(plan.text, { start: plan.start, end: plan.end, draftRev: span.draftRev })) {
              e.preventDefault()
              e.stopPropagation()
            }
            return
          }
          if ((key === 'ArrowLeft' || key === 'ArrowRight')
            && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
            // The marker prefix is one hop for horizontal caret moves: ← from
            // just after the marker reaches the line start in one press, →
            // from the line start reaches past the marker. Together with the
            // ⌘← branch below, markers never need to be stepped through.
            const span = actions.captureInsertion()
            const text = liveText(editable)
            if (span === undefined || span.start !== span.end || text === null) return
            // Gap disambiguation for both directions: a caret resting on a
            // paragraph gap projects to the previous line's end; when the DOM
            // says it is at a block's start, attribute it to that line so ←
            // stays native at the line start instead of hopping the previous
            // line's marker.
            let caret = span.start
            if (caret < text.length && text.charAt(caret) === '\n' && domCaretAtBlockStart()) caret += 1
            const target = arrowJump(text, caret, key === 'ArrowLeft' ? -1 : 1)
            if (target === null || target === caret) return
            e.preventDefault()
            e.stopPropagation()
            moveCaretBy(target - caret)
            return
          }
          if ((key === 'ArrowLeft' && e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey)
            || (key === 'Home' && !e.metaKey && !e.ctrlKey && !e.altKey)) {
            // Line-start jump lands right after the list marker, not before
            // it: rewrite the marker with itself (a no-content-change edit)
            // so the caret settles after it. Pressing again from there keeps
            // the native jump to the true line start.
            const span = actions.captureInsertion()
            const text = liveText(editable)
            if (span === undefined || span.start !== span.end || text === null) return
            // A caret on a paragraph gap maps to the previous line's end in
            // the projection; the DOM check attributes it to the line it
            // visually starts (same disambiguation as selectionLines).
            let caret = span.start
            if (caret < text.length && text.charAt(caret) === '\n' && domCaretAtBlockStart()) caret += 1
            const { start: lineStart } = lineBounds(text, caret)
            const lineIdx = lineIndexOf(text, caret)
            const line = text.split('\n')[lineIdx]
            if (line === undefined || parseItem(line) === null) return
            if (caret - lineStart === markerEndOf(line)) return // already after the marker
            const plan = markerScopePlan(text, lineIdx, lineIdx, text.split('\n'))
            if (actions.insertText(plan.text, { start: plan.start, end: plan.end, draftRev: span.draftRev })) {
              e.preventDefault()
              e.stopPropagation()
            }
            return
          }
          if (key === 'Tab' && !e.altKey && !accelerated(e)) {
            const sel = selectionLines(editable)
            if (sel === null) return
            const plan = indentPlan(sel.text, sel.a, sel.b, e.shiftKey ? -1 : 1, settingsRef.current,
              sel.collapsed ? Math.max(sel.span.start, sel.span.end) : undefined)
            if (plan === null) return // no item lines: keep native Tab
            // Later siblings renumber first (plan.pre); the caret edit last.
            const landed = applyEdits({ main: plan, right: plan.pre === undefined ? [] : [plan.pre] }, editable)
            if (!landed.any) return // edit refused: keep native Tab
            e.preventDefault()
            e.stopPropagation()
            return
          }
          if (e.shiftKey && accelerated(e) && !e.altKey && (e.code === 'Digit7' || e.code === 'Numpad7'
            || e.code === 'Digit8' || e.code === 'Numpad8')) {
            const sel = selectionLines(editable)
            if (sel === null) return
            const kind = e.code === 'Digit7' || e.code === 'Numpad7' ? 'ordered' : 'bullet'
            // Collapsed caret: the plan ends at the caret's content offset,
            // so the toggle parks it on the same content character.
            const caret = sel.collapsed ? Math.max(sel.span.start, sel.span.end) : undefined
            const { pre, plan } = togglePlan(sel.text, sel.a, sel.b, kind, settingsRef.current, caret)
            // Renumbering past the caret line goes FIRST — the caret edit
            // must be the last insertText, which is where the caret parks.
            const preApplied = pre !== null && applyPlan(pre, editable)
            if (!applyPlan(plan, editable)) {
              if (!preApplied) return // edit refused: keep the native key
              e.preventDefault()
              e.stopPropagation()
              return
            }
            e.preventDefault()
            e.stopPropagation()
            return
          }
        }
        const onBeforeInput = (e) => {
          if (optimizingRef.current
            && e.target instanceof Node && editableState.current !== null
            && editableState.current.contains(e.target)) {
            e.preventDefault()
          }
          // The Edit menu's undo/redo arrives as a beforeinput event; any
          // other input means the next draft change is a real edit.
          const type = e.inputType
          historyNavRef.current = type === 'historyUndo' ? 'undo' : type === 'historyRedo' ? 'redo' : null
          if (historyNavRef.current !== null) historyNavAtRef.current = Date.now()
        }
        const onPointerDown = () => { exitPending = false }
        // One driver per composer: a slot registered twice (local + npm copy)
        // must not let two instances answer the same key event.
        const { card } = resolveComposer()
        if (!claimComposer({ card, editable: null })) return
        document.addEventListener('keydown', onKey, true)
        document.addEventListener('beforeinput', onBeforeInput, true)
        document.addEventListener('pointerdown', onPointerDown, true)
        return () => {
          disposed = true
          if (card !== null && card[DRIVER] === token) delete card[DRIVER]
          if (descentRaf !== 0) cancelAnimationFrame(descentRaf)
          document.removeEventListener('keydown', onKey, true)
          document.removeEventListener('beforeinput', onBeforeInput, true)
          document.removeEventListener('pointerdown', onPointerDown, true)
        }
      }, [applyPlan, selectionLines, liveText, resolveComposer, claimComposer])
      // Automatic renumbering after content changes.
      useEffect(() => {
        const prev = prevDraftRef.current
        prevDraftRef.current = input === null ? undefined : input.draft
        if (!settingsRef.current.autoRenumber) return
        if (input === null || input.phase !== 'plain') return
        if (input.occurrences.length > 0) return
        const scope = resolveComposer()
        if (!claimComposer(scope)) return // another instance drives this composer
        const editable = currentEditable(scope)
        if (editable === null) return
        if (detectTextOf(editable) !== input.draft) return
        if (input.draft.startsWith('>') || input.draft.includes('\n> ')) return // quote node may be present
        if (prev !== undefined && onlyMarkerEdit(prev, input.draft)) return
        // An undo walks back to a draft that existed before — exactly the
        // state the user wants. Re-fixing it would redo the undone edit and
        // make Cmd+Z a no-op forever (the reaction's own edit sits on top of
        // the user's in the undo stack). Redo is left alone: it re-converges.
        const nav = historyNavRef.current
        historyNavRef.current = null
        const last = lastReactionRef.current
        const undoing = (nav === 'undo' && Date.now() - historyNavAtRef.current < HISTORY_NAV_WINDOW_MS)
          || (last !== null && prev === last.to && input.draft === last.from)
        if (undoing) {
          lastReactionRef.current = null
          return
        }
        const actions = actionsRef.current
        if (actions === null) return
        const plan = renumberPlan(input.draft, settingsRef.current)
        if (plan === null) return
        // Keep the caret where the user's edit left it instead of at the end
        // of the renumbered range: apply the reaction caret-anchored too.
        const span = actions.captureInsertion()
        const caret = span !== undefined && span.start === span.end ? span.start : plan.start
        for (const edit of reactionEdits(input.draft, plan, settingsRef.current, caret)) {
          if (!applyPlan(edit, editable)) return
        }
        lastReactionRef.current = {
          from: input.draft,
          to: input.draft.slice(0, plan.start) + plan.text + input.draft.slice(plan.end),
        }
      }, [input?.draft, input?.draftRev, input?.phase, input?.occurrences, resolveComposer, claimComposer, applyPlan])

      const gearRef = useRef(null)
      const openSettings = useCallback(() => {
        const rect = gearRef.current?.getBoundingClientRect()
        if (rect === undefined) return
        setMenuRect(current => current === null ? { left: rect.left, bottom: rect.top - 8 } : null)
      }, [])
      const closeSettings = useCallback(() => { setMenuRect(null) }, [])
      const updateSettings = useCallback((patch) => {
        setSettings(prev => {
          const next = normalizeSettings({ ...prev, ...patch })
          saveSettings(next)
          return next
        })
      }, [])

      // Prompt polish: POST the draft to the Host half's optimize route and
      // swap the draft for the model's structured rewrite. The button is a
      // three-state control: sparkles (idle) → pulsing (busy) → undo (the
      // rewrite is live; one click restores the original). Any manual edit to
      // the rewritten draft retires the undo state so restoring can never
      // swallow the user's own changes.
      const [optimizing, setOptimizing] = useState(false)
      const [original, setOriginal] = useState(null)
      const [optimized, setOptimized] = useState(null)
      const [optimizeError, setOptimizeError] = useState(null)
      const [toast, setToast] = useState(null)
      const toastTimerRef = useRef(null)
      const abortRef = useRef(null)
      useEffect(() => {
        if (toast === null) return
        if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current)
        toastTimerRef.current = setTimeout(() => { setToast(null) }, 4000)
        return () => { if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current) }
      }, [toast])
      const errorTimerRef = useRef(null)
      const undoable = original !== null && optimized !== null && input !== null && input.draft === optimized
      const optimize = useCallback(async () => {
        const state = inputRef.current
        if (state === null || actionsRef.current === null) return
        // The ref guards re-entry (not the render-time `optimizing`): two
        // clicks landing before React re-renders must not start two flights.
        if (optimizingRef.current) return
        if (state.phase !== 'plain' && state.phase !== 'claimed') return
        const text = state.draft
        if (text.trim() === '') return
        if (meaninglessText(text)) {
          setOptimizeError('tooShort')
          setToast(tRef.current('tooShort'))
          return
        }
        if (state.occurrences.length > 0) {
          setOptimizeError('toastChips')
          setToast(tRef.current('toastChips'))
          return
        }
        // A new flight retires the previous one's error and toast.
        setOptimizeError(null)
        setToast(null)
        optimizingRef.current = true
        setOptimizing(true)
        // Freeze the editor at the browser level: IME composition events
        // (insertCompositionText) are not cancelable, so keydown/beforeinput
        // interception alone cannot stop typing. Toggle contenteditable and
        // restore exactly the element (and attribute value) we locked.
        const locked = currentEditable(resolveComposer())
        if (locked !== null) {
          // The host owns editability and may have made the surface
          // read-only meanwhile: put back what was there, not a hard "true".
          lockRef.current = { editable: locked, previous: locked.getAttribute('contenteditable') }
          locked.setAttribute('contenteditable', 'false')
          locked.classList.add('clp-optimizing')
        }
        // Hard timeout: a hung model stream would otherwise keep the editor
        // locked forever; Escape aborts early (see the keydown handler).
        const controller = new AbortController()
        abortRef.current = controller
        let timedOut = false
        const timer = setTimeout(() => { timedOut = true; controller.abort() }, 90_000)
        try {
          const resp = await fetch('/composer-lists/optimize', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text }),
            signal: controller.signal,
          })
          const data = await resp.json().catch(() => null)
          if (!resp.ok || data?.ok !== true || typeof data?.text !== 'string') {
            throw new Error(typeof data?.error === 'string' ? data.error : `HTTP ${resp.status}`)
          }
          // The editor is locked, so any draft change during the flight
          // (session switch, external restore) means this rewrite no longer
          // belongs in the composer — drop it instead of clobbering. Read
          // the actions at result time so they pair with the state compared.
          if (inputRef.current === null || actionsRef.current === null || inputRef.current.draft !== text) {
            setToast(tRef.current('cancelled'))
            return
          }
          setOriginal(text)
          setOptimized(data.text)
          actionsRef.current.setDraft(data.text)
        } catch (error) {
          const aborted = error !== null && typeof error === 'object' && error.name === 'AbortError'
          if (!aborted) console.error('[composer-lists] optimize failed:', error)
          const message = aborted
            ? (timedOut ? tRef.current('timeout') : tRef.current('cancelled'))
            : error instanceof Error ? error.message : String(error)
          setOptimizeError(message)
          setToast(tRef.current('optimizeFailed') + ': ' + message)
        } finally {
          clearTimeout(timer)
          abortRef.current = null
          const lock = lockRef.current
          lockRef.current = null
          if (lock !== null && lock.editable.isConnected) {
            lock.editable.setAttribute('contenteditable', lock.previous === null ? 'true' : lock.previous)
            lock.editable.classList.remove('clp-optimizing')
          }
          optimizingRef.current = false
          setOptimizing(false)
        }
      }, [])
      // Unmounting mid-flight (session switch, plugin disabled): abort the
      // orphan request, so its own finally unlocks the resident surface now
      // instead of when the hard timeout fires.
      useEffect(() => () => { if (abortRef.current !== null) abortRef.current.abort() }, [])
      const restore = useCallback(() => {
        const actions = actionsRef.current
        const state = inputRef.current
        if (actions === null || state === null || original === null) return
        // Never swap the draft of a frozen composer (a submission in flight).
        if (state.phase !== 'plain' && state.phase !== 'claimed') return
        actions.setDraft(original)
        setOriginal(null)
        setOptimized(null)
      }, [original])

      const draftEmpty = input === null || input.draft.trim() === ''
      // Keep a failed optimize visible on the button briefly, then retire it.
      useEffect(() => {
        if (optimizeError === null) return
        if (errorTimerRef.current !== null) clearTimeout(errorTimerRef.current)
        errorTimerRef.current = setTimeout(() => { setOptimizeError(null) }, 4000)
        return () => { if (errorTimerRef.current !== null) clearTimeout(errorTimerRef.current) }
      }, [optimizeError])
      const errorTitle = optimizeError === 'toastChips' ? t('toastChips')
        : optimizeError === 'tooShort' ? t('tooShort')
          : optimizeError

      return h('div', { class: 'clp-root', ref: rootRef },
        h('style', null, `${CSS}\n:root { --clp-opt-text: ${JSON.stringify(t('optimizing'))}; }`),
        settings.showOptimize && h('button', {
          type: 'button',
          class: 'clp-btn' + (optimizeError !== null ? ' clp-error' : ''),
          title: optimizeError !== null
            ? `${t('optimizeFailed')}: ${errorTitle}`
            : undoable ? t('restore') : t('optimize'),
          'aria-label': undoable ? t('restore') : t('optimize'),
          disabled: optimizing || (!undoable && draftEmpty),
          onMouseDown: (e) => { e.preventDefault() },
          onClick: undoable ? restore : optimize,
        }, undoable
          ? undoIcon()
          : sparklesIcon(optimizing ? 'clp-pulse' : undefined)),
        toast !== null && createPortal(h('div', {
          class: 'clp-toast', role: 'status',
          onClick: () => { setToast(null) },
        }, toast), document.body),
        h('button', {
          type: 'button',
          class: 'clp-btn',
          ref: gearRef,
          title: t('settings'),
          'aria-label': t('settings'),
          onMouseDown: (e) => { e.preventDefault() }, // keep the editor selection
          onClick: openSettings,
        }, gearIcon()),
        menuRect !== null && h(SettingsPopover, {
          t, settings, updateSettings, position: menuRect, close: closeSettings,
        }),
      )
    }

    // ------------------------------------------------------------------
    // Settings UI
    // ------------------------------------------------------------------

    function gearIcon () {
      return h('svg', {
        viewBox: '0 0 16 16', width: 15, height: 15, fill: 'none', stroke: 'currentColor',
        'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        'aria-hidden': true, style: { display: 'block' },
      }, h('path', { d: 'M8 5.6A2.4 2.4 0 1 0 8 10.4 2.4 2.4 0 0 0 8 5.6Z' }),
      h('path', { d: 'M12.9 9.9a1.2 1.2 0 0 0 .24 1.32l.04.04a1.2 1.2 0 1 1-1.7 1.7l-.04-.04a1.2 1.2 0 0 0-1.32-.24 1.2 1.2 0 0 0-.72 1.1v.12a1.2 1.2 0 1 1-2.4 0v-.06a1.2 1.2 0 0 0-.78-1.1 1.2 1.2 0 0 0-1.32.24l-.04.04a1.2 1.2 0 1 1-1.7-1.7l.04-.04a1.2 1.2 0 0 0 .24-1.32 1.2 1.2 0 0 0-1.1-.72H2.5a1.2 1.2 0 1 1 0-2.4h.06a1.2 1.2 0 0 0 1.1-.78 1.2 1.2 0 0 0-.24-1.32l-.04-.04a1.2 1.2 0 1 1 1.7-1.7l.04.04a1.2 1.2 0 0 0 1.32.24h.06a1.2 1.2 0 0 0 .72-1.1V2.5a1.2 1.2 0 1 1 2.4 0v.06a1.2 1.2 0 0 0 .72 1.1 1.2 1.2 0 0 0 1.32-.24l.04-.04a1.2 1.2 0 1 1 1.7 1.7l-.04.04a1.2 1.2 0 0 0-.24 1.32v.06a1.2 1.2 0 0 0 1.1.72h.12a1.2 1.2 0 1 1 0 2.4h-.06a1.2 1.2 0 0 0-1.1.72Z' }))
    }

    /** One four-point sparkle centered at (x,y) with radius r (filled). */
    function sparklePath (x, y, r) {
      return `M${x} ${y - r} Q${x} ${y} ${x + r} ${y} Q${x} ${y} ${x} ${y + r} Q${x} ${y} ${x - r} ${y} Q${x} ${y} ${x} ${y - r}Z`
    }

    /**
     * Sparkles glyph: big star in the theme's brand color (the
     * --dsw-alias-brand-primary token flips with light/dark automatically),
     * small companion in amber — both keep contrast in either theme.
     */
    function sparklesIcon (className) {
      return h('svg', {
        viewBox: '0 0 16 16', width: 15, height: 15,
        'aria-hidden': true, class: className, style: { display: 'block' },
      },
      h('path', { d: sparklePath(7.6, 9.4, 5.4), fill: 'var(--dsw-alias-brand-primary)' }),
      h('path', { d: sparklePath(12.8, 3.6, 2.4), fill: '#e8a10a' }))
    }

    function undoIcon () {
      return h('svg', {
        viewBox: '0 0 16 16', width: 15, height: 15, fill: 'none', stroke: 'currentColor',
        'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        'aria-hidden': true, style: { display: 'block' },
      }, h('path', { d: 'M3 7h6.5a3.5 3.5 0 1 1 0 7H6' }),
      h('path', { d: 'M5.5 4.5 3 7l2.5 2.5' }))
    }

    /** Style option labels are language-neutral (the rendered marker itself). */
    const STYLE_SAMPLES = {
      arabic: renderOrderedCore('arabic', 1),
      letter: renderOrderedCore('letter', 1),
      greek: renderOrderedCore('greek', 1),
      paren: renderOrderedCore('paren', 1),
      circle: renderOrderedCore('circle', 1),
    }

    /** One keyboard cap. */
    const kbd = (label, key) => h('kbd', { class: 'clp-kbd', key }, label)
    const kbdSep = (label, key) => h('span', { class: 'clp-kbd-sep', key }, label)

    /** A key group joined by `+`, optionally a second group after `/`. */
    function keyCaps (keys, altKeys) {
      const parts = []
      keys.forEach((label, i) => {
        if (i > 0) parts.push(kbdSep('+', `p${i}`))
        parts.push(kbd(label, `k${i}`))
      })
      if (altKeys !== undefined) {
        parts.push(kbdSep('/', 'slash'))
        altKeys.forEach((label, i) => {
          if (i > 0) parts.push(kbdSep('+', `a${i}`))
          parts.push(kbd(label, `ak${i}`))
        })
      }
      return h('span', { class: 'clp-keys-caps' }, parts)
    }

    /**
     * Settings popover with two tabs (settings / shortcuts), portaled to the
     * document body and anchored above the gear button (the composer sits at
     * the viewport bottom, so the popover grows upward).
     */
    function SettingsPopover ({ t, settings, updateSettings, position, close }) {
      const [tab, setTab] = useState('settings')
      useEffect(() => {
        const onDown = (e) => {
          if (!e.target.closest?.('.clp-popover') && !e.target.closest?.('.clp-btn')) close()
        }
        const onKey = (e) => { if (e.key === 'Escape') close() }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [close])
      const levelRows = []
      for (let level = 0; level < LEVELS; level += 1) {
        levelRows.push(h('div', { key: level, class: 'clp-level' },
          h('span', { class: 'clp-level-label' }, `${t('level')} ${level + 1}`),
          h('select', {
            class: 'clp-select', value: settings.orderedStyles[level],
            onChange: (e) => {
              const styles = [...settings.orderedStyles]
              styles[level] = e.target.value
              updateSettings({ orderedStyles: styles })
            },
          }, ORDERED_STYLES.map(style => h('option', {
            key: style, value: style,
          }, STYLE_SAMPLES[style]))),
          h('select', {
            class: 'clp-select', value: settings.bulletStyles[level],
            onChange: (e) => {
              const styles = [...settings.bulletStyles]
              styles[level] = e.target.value
              updateSettings({ bulletStyles: styles })
            },
          }, BULLET_CHARS.map(b => h('option', { key: b, value: b }, b)))))
      }
      const keyRows = [
        { keys: ['Shift', 'Enter'], desc: t('keyContinue') },
        { keys: ['Shift', 'Enter'], desc: t('keyExit') },
        { keys: ['Backspace'], desc: t('keyBackspace') },
        { keys: ['←', '→'], desc: t('keyArrow') },
        { keys: ['Tab'], altKeys: ['Shift', 'Tab'], desc: t('keyLevel') },
        { keys: ['⌘', '⇧', '7'], desc: t('keyOrdered') },
        { keys: ['⌘', '⇧', '8'], desc: t('keyBullet') },
        { keys: ['⌘', '⇧', 'B'], desc: t('keyBold') },
        { keys: ['⌘', '←'], desc: t('keyLineStart') },
      ].map((row, i) => h('div', { key: i, class: 'clp-keys-row' },
        keyCaps(row.keys, row.altKeys),
        h('span', { class: 'clp-keys-desc' }, row.desc)))
      return createPortal(h('div', {
        class: 'clp-popover',
        style: {
          left: `${Math.max(8, Math.min(position.left, window.innerWidth - 340))}px`,
          bottom: `${Math.max(8, window.innerHeight - position.bottom)}px`,
        },
        role: 'dialog', 'aria-label': t('settings'),
      },
      h('div', { class: 'clp-title' }, t('title'), h('span', { class: 'clp-title-ver' }, ` v${PLUGIN_VERSION}`)),
      h('div', { class: 'clp-tabs', role: 'tablist' },
        h('button', {
          type: 'button', role: 'tab',
          class: 'clp-tab' + (tab === 'settings' ? ' clp-tab-on' : ''),
          onClick: () => { setTab('settings') },
        }, t('tabSettings')),
        h('button', {
          type: 'button', role: 'tab',
          class: 'clp-tab' + (tab === 'keys' ? ' clp-tab-on' : ''),
          onClick: () => { setTab('keys') },
        }, t('tabKeys'))),
      tab === 'settings'
        ? h('div', { class: 'clp-tab-body' },
          h('div', { class: 'clp-group-head' },
            h('span', { class: 'clp-group-title' }, t('groupBasic')),
            h('span', { class: 'clp-group-desc' }, t('groupBasicDesc'))),
          h('div', { class: 'clp-row' },
            h('span', { class: 'clp-row-label' }, t('indentUnit')),
            h('div', { class: 'clp-seg' }, [2, 4, 8].map(v => h('button', {
              key: String(v), type: 'button',
              class: 'clp-seg-btn' + (v === settings.indentUnit ? ' clp-seg-on' : ''),
              onClick: () => { updateSettings({ indentUnit: v }) },
            }, String(v))))),
          h('label', { class: 'clp-row clp-check' },
            h('input', {
              type: 'checkbox', checked: settings.autoRenumber,
              onChange: (e) => { updateSettings({ autoRenumber: e.target.checked }) },
            }),
            h('span', { class: 'clp-row-label' }, t('autoRenumber'))),
          h('label', { class: 'clp-row clp-check' },
            h('input', {
              type: 'checkbox', checked: settings.showOptimize,
              onChange: (e) => { updateSettings({ showOptimize: e.target.checked }) },
            }),
            h('span', { class: 'clp-row-label' }, t('showOptimize'))),
          h('div', { class: 'clp-group-head clp-group-split' },
            h('span', { class: 'clp-group-title' }, t('groupStyles')),
            h('span', { class: 'clp-group-desc' }, t('groupStylesDesc'))),
          h('div', { class: 'clp-cols' },
            h('span', { class: 'clp-col-title' }, t('orderedStyle')),
            h('span', { class: 'clp-col-title' }, t('bulletStyle'))),
          ...levelRows)
        : h('div', { class: 'clp-tab-body' },
          h('div', { class: 'clp-keys-head' },
            h('span', { class: 'clp-keys-title' }, t('keysTitle')),
            h('span', { class: 'clp-keys-scope' }, t('keysScope'))),
          ...keyRows),
      ), document.body)
    }

    const CSS = `
.clp-root { display: inline-flex; align-items: center; }
.clp-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; padding: 0; border: none; border-radius: 6px;
  background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer;
}
.clp-btn:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.clp-btn:disabled { opacity: 0.4; cursor: default; }
.clp-btn:disabled:hover { color: var(--dsw-alias-label-secondary); background: transparent; }
.clp-error, .clp-error:hover { color: var(--dsw-alias-state-error-primary); }
.clp-toast {
  position: fixed; left: 50%; bottom: 132px; transform: translateX(-50%); z-index: 2147483000;
  max-width: min(480px, calc(100vw - 32px)); padding: 8px 14px; border-radius: 8px;
  background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-state-error-primary);
  border: 1px solid var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 1.5;
  box-shadow: 0 8px 28px rgba(0,0,0,.22); cursor: pointer;
}
@keyframes clp-pulse { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(0.72); opacity: 0.55; } }
.clp-pulse { animation: clp-pulse 0.6s ease-in-out infinite; }
@keyframes clp-breathe { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
.clp-optimizing { position: relative; }
/* Only the draft blocks breathe (1s); the ::after busy label is a pseudo
   element, not matched by the child selector, so its text and pill stay steady. */
.clp-optimizing > * { animation: clp-breathe 1s ease-in-out infinite; }
.clp-optimizing:hover::after {
  content: var(--clp-opt-text); position: absolute; inset: 0; z-index: 1;
  /* Shrink to the label itself (inset:0 + fit-content + auto margins =
     centered) so only the text area is covered; 4px breathing room around
     the label, and the draft text outside the pill shows through. */
  width: fit-content; height: fit-content; margin: auto;
  padding: 4px; border-radius: 6px; white-space: nowrap;
  font-size: 13px; color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-overlay);
  pointer-events: none;
}
.clp-popover {
  position: fixed; z-index: 2147483000; width: 340px; height: min(432px, calc(100vh - 24px));
  overflow: hidden; padding: 10px 12px 10px; box-sizing: border-box;
  background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0,0,0,.22);
  display: flex; flex-direction: column; gap: 8px; font-size: 12px;
}
.clp-group-head { display: flex; align-items: baseline; gap: 8px; padding-top: 2px; }
.clp-group-split { border-top: 1px solid var(--dsw-alias-border-l1); margin-top: 4px; padding-top: 10px; }
.clp-group-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.clp-group-desc { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.clp-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); padding-bottom: 2px; }
.clp-title-ver { font-size: 11px; font-weight: 400; color: var(--dsw-alias-label-tertiary); }
.clp-tabs {
  display: flex; border: 1px solid var(--dsw-alias-border-l2); border-radius: 7px;
  overflow: hidden; margin-bottom: 2px; height: 32px; flex: none;
}
.clp-tab {
  flex: 1; border: none; background: transparent; cursor: pointer;
  font-size: 12.5px; line-height: 30px; padding: 0; text-align: center;
  color: var(--dsw-alias-label-primary); font-weight: 500;
}
.clp-tab + .clp-tab { border-left: 1px solid var(--dsw-alias-border-l1); }
.clp-tab-on { background: var(--dsw-alias-brand-primary); color: #fff; font-weight: 600; }
/* The popover shell never scrolls; the title and the tab bar stay pinned
   and only this body scrolls (min-height:0 lets the flex child shrink). */
.clp-tab-body {
  display: flex; flex-direction: column; gap: 8px;
  overflow-y: auto; min-height: 0; overscroll-behavior: contain;
}
.clp-keys-head { display: flex; align-items: baseline; gap: 8px; padding-top: 2px; }
.clp-keys-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.clp-keys-scope { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.clp-keys-row {
  display: flex; align-items: center; gap: 10px; padding: 7px 0;
  border-top: 1px solid var(--dsw-alias-border-l1);
}
.clp-keys-caps { display: inline-flex; align-items: center; gap: 3px; min-width: 132px; flex: none; flex-wrap: wrap; }
.clp-kbd {
  font-family: ui-monospace, Menlo, monospace; font-size: 10px; line-height: 1;
  padding: 3px 5px; border-radius: 4px; color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1);
  box-shadow: 0 1px 0 var(--dsw-alias-border-l2);
}
.clp-kbd-sep { color: var(--dsw-alias-label-secondary); font-size: 10px; }
.clp-keys-desc { color: var(--dsw-alias-label-primary); font-size: 12px; }
.clp-row { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.clp-row-label { color: var(--dsw-alias-label-secondary); margin-right: auto; }
.clp-check { cursor: pointer; }
.clp-cols { display: flex; gap: 8px; justify-content: flex-start; margin-top: 2px; padding-left: 58px; }
.clp-col-title { width: 118px; color: var(--dsw-alias-label-secondary); font-size: 11px; text-align: left; }
.clp-level { display: flex; align-items: center; justify-content: flex-start; gap: 8px; }
.clp-level-label { width: 50px; flex: none; color: var(--dsw-alias-label-secondary); }
.clp-select {
  width: 118px; height: 24px; padding: 0 4px; border-radius: 6px; font-size: 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
}
.clp-seg { display: inline-flex; border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; overflow: hidden; }
.clp-seg-btn {
  border: none; background: transparent; color: var(--dsw-alias-label-secondary);
  min-width: 28px; height: 22px; padding: 0 6px; cursor: pointer; font-size: 12px;
}
.clp-seg-btn + .clp-seg-btn { border-left: 1px solid var(--dsw-alias-border-l1); }
.clp-seg-on { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
`

    // ------------------------------------------------------------------
    // Plugin entry
    // ------------------------------------------------------------------

    const DICTS = {
      zh: {
        title: '输入框列表编排',
        settings: '列表设置',
        optimize: '优化提示词为结构化列表（AI 改写，完成后可撤销）',
        restore: '撤销优化，恢复原始提示词',
        showOptimize: '显示提示词优化按钮',
        optimizeFailed: '优化失败',
        timeout: '优化超时（90 秒），已自动取消',
        cancelled: '已取消优化',
        toastChips: '草稿包含引用/命令，暂不支持优化',
        tooShort: '文本过短或无意义，无优化价值',
        groupBasic: '基本',
        groupBasicDesc: '默认行为',
        groupStyles: '样式',
        groupStylesDesc: 'Tab / Shift+Tab 切换层级时套用',
        tabSettings: '设置',
        tabKeys: '快捷键',
        keysTitle: '快捷键',
        keysScope: '仅输入框内生效',
        optimizing: '正在优化输入内容',
        boldText: '粗体',
        keyBold: '切换粗体（作用于选中文本）',
        keyLineStart: '跳到行首（列表行落在符号右侧，再按到最左）',
        keyContinue: '列表行内换行，并延续当前编号',
        keyExit: '空项：删除标记并退出列表',
        keyBackspace: '标记后：二级及更深升一级；一级删标记；空项退出',
        keyArrow: '跨过标记一步：标记右侧←到行首，行首→到标记右侧',
        keyLevel: '调整层级，并切换至该层级样式',
        keyOrdered: '切换有序列表',
        keyBullet: '切换无序列表',
        indentUnit: '缩进宽度',
        autoRenumber: '有序编号自动重排',
        orderedStyle: '有序样式',
        bulletStyle: '无序符号',
        level: '层级',
      },
      en: {
        title: 'Composer lists',
        settings: 'List settings',
        optimize: 'Polish the prompt into structured lists (AI rewrite, undoable)',
        restore: 'Undo the optimization and restore the original prompt',
        showOptimize: 'Show the prompt-optimize button',
        optimizeFailed: 'Optimize failed',
        timeout: 'Optimization timed out (90 s) and was cancelled',
        cancelled: 'Optimization cancelled',
        toastChips: 'The draft contains reference/command chips; optimize is unavailable',
        tooShort: 'Text too short or meaningless to optimize',
        groupBasic: 'Basics',
        groupBasicDesc: 'default behavior',
        groupStyles: 'Styles',
        groupStylesDesc: 'applied when Tab / Shift+Tab changes level',
        tabSettings: 'Settings',
        tabKeys: 'Shortcuts',
        keysTitle: 'Shortcuts',
        keysScope: 'composer only',
        optimizing: 'Optimizing your prompt…',
        boldText: 'Bold',
        keyBold: 'Toggle bold on the selection',
        keyLineStart: 'Jump to line start (after the marker on list lines; again for the far left)',
        keyContinue: 'New line inside a list, continuing the marker',
        keyExit: 'Empty item: clear the marker and exit the list',
        keyBackspace: 'After a marker: promote one level (L2+); delete it (L1); empty item exits',
        keyArrow: 'Hop over the marker: ← from its right to line start, → from line start past it',
        keyLevel: 'Change level and its marker style',
        keyOrdered: 'Toggle ordered list',
        keyBullet: 'Toggle bullet list',
        indentUnit: 'Indent width',
        autoRenumber: 'Renumber ordered lists',
        orderedStyle: 'Ordered style',
        bulletStyle: 'Bullet char',
        level: 'Level',
      },
    }

    return {
      inject: ['slots', 'locale'],
      apply (ctx) {
        const disposers = []
        for (const [locale, dict] of Object.entries(DICTS)) {
          disposers.push(ctx.locale.register('composerLists', locale, dict))
        }
        const t = ctx.locale.bind('composerLists')
        disposers.push(ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            { name: 'conversation.input.left', id: 'composer-lists', order: 25, label: () => t('title') },
            (slotProps) => h(Runtime, { ...slotProps, t }),
          )))
        ctx.effect(() => () => {
          for (const dispose of disposers) dispose()
        })
      },
      _pure: {
        parseItem, renderOrderedCore, renumberPlan, onlyMarkerEdit, togglePlan, indentPlan,
        continuationPlan, backspacePlan, promotePlan, arrowJump, lineBounds, lineRange,
        lineIndexOf, meaninglessText, seDecision, caretAnchoredEdits, reactionEdits, exitLoneLine,
      },
    }
  },
})
