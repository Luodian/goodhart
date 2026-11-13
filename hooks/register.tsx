import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Direction, Insight, Metric, View } from '../types'

const PANE = 'goodhart'
const TITLE = 'Goodhart'
const TOOL = 'mcp__goodhart__metric'
const INSIGHT_TOOL = 'mcp__goodhart__insight'
const metrics = atom({ plugin: 'goodhart', key: 'metrics' } as const, [], {
  shape: 'metrics-1',
})
// Docked panes default to a big share of the screen; ask for a narrow one (the person can still drag it).
const OPEN = { id: PANE, title: TITLE, columns: 52, backgroundColor: '#000000' }
// auto = band until the user agrees a goal, then the pane. A new key, so sessions that stored the old
// 'pane' default also start in auto.
const view = atom({ plugin: 'goodhart', key: 'mode' } as const, 'auto' as View)
const insights = atom({ plugin: 'goodhart', key: 'insights' } as const, [] as Insight[])
// The metric whose history the pane shows unfolded ('' = none).
const expanded = atom({ plugin: 'goodhart', key: 'expanded' } as const, '')
const objective = atom({ plugin: 'goodhart', key: 'objective' } as const, '')


// Bloomberg-terminal palette: amber on black, blue section bars, green/red moves.
const BB = {
  black: '#000000',
  amber: '#FB8B1E',
  amberDim: '#A8651C',
  white: '#F2F2F2',
  grey: '#7A7A7A',
  green: '#4AF626',
  red: '#FF433D',
  cyan: '#3FC8FF',
  blue: '#1C3F94',
}
/** Pad or cut to exactly n cells. */
const fit = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s.padEnd(n))
const fmtNum = (n: number | undefined) =>
  n === undefined ? '--' : Number.isInteger(n) ? String(n) : Math.abs(n) < 10 ? n.toFixed(3) : n.toFixed(1)
/** cost_per_task -> CPT: the change list names metrics by their initials. */
const abbrev = (key: string) =>
  key
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map(w => w[0]!.toUpperCase())
    .join('')

const last = (m: Metric) => m.history[m.history.length - 1]
const fmt = (n: number | undefined, unit?: string) =>
  n === undefined ? '-' : `${Number.isInteger(n) ? n : n.toFixed(3)}${unit ? ` ${unit}` : ''}`
const signed = (n: number) => `${n > 0 ? '+' : ''}${fmt(n)}`

const isMet = (m: Metric) => {
  const v = last(m)?.value
  if (v === undefined || m.target === undefined) return false
  return m.direction === 'up' ? v >= m.target : v <= m.target
}

/** Share of the way from the baseline (first value) to the target, 0..1, for value v (default: latest). */
const progress = (m: Metric, v = last(m)?.value) => {
  const base = m.history[0]?.value
  if (base === undefined || v === undefined || m.target === undefined) return undefined
  if (m.direction === 'up' ? v >= m.target : v <= m.target) return 1
  const span = m.target - base
  if (span === 0) return 0
  return Math.max(0, Math.min(1, (v - base) / span))
}

const bar = (p: number, width: number) => {
  const full = Math.round(p * width)
  return '█'.repeat(full) + '░'.repeat(width - full)
}

const SPARK = '▁▂▃▄▅▆▇█'
const sparkline = (m: Metric, n: number) => {
  const vs = m.history.slice(-n).map(p => p.value)
  if (vs.length < 2) return ''
  const lo = Math.min(...vs)
  const hi = Math.max(...vs)
  return vs.map(v => SPARK[hi === lo ? 3 : Math.round(((v - lo) / (hi - lo)) * 7)]).join('')
}

const goalText = (m: Metric) =>
  m.target === undefined ? 'goal ?' : `goal ${m.direction === 'up' ? '≥' : '≤'} ${fmt(m.target, m.unit)}`

/** One metric's move caused by one change: the step from the value before it. */
type Effect = {
  key: string
  delta: number
  /** Signed share of the baseline-to-target gap this step closed; negative moved away from the goal. */
  gapShare?: number
  isBetter?: boolean
  note?: string
}
type ChangeRow = { label: string; at: number; effects: Effect[] }

const changeRows = (list: Metric[]): ChangeRow[] => {
  const rows = new Map<string, ChangeRow>()
  for (const m of list) {
    const base = m.history[0]?.value
    m.history.forEach((pt, i) => {
      const before = m.history[i - 1]
      if (i === 0 || !before || !pt.change) return
      const delta = pt.value - before.value
      const gap = m.target !== undefined && base !== undefined ? m.target - base : 0
      const row = rows.get(pt.change) ?? { label: pt.change, at: pt.at, effects: [] }
      row.at = Math.min(row.at, pt.at)
      row.effects.push({
        key: m.key,
        delta,
        ...(gap !== 0 ? { gapShare: delta / gap } : {}),
        ...(delta !== 0 ? { isBetter: delta > 0 === (m.direction === 'up') } : {}),
        ...(pt.note ? { note: pt.note } : {}),
      })
      rows.set(pt.change, row)
    })
  }
  return [...rows.values()].sort((a, b) => b.at - a.at)
}

/** Score of an effect toward its metric's goal: gap share when there is a target, else the signed step. */
const gain = (ef: Effect) => ef.gapShare ?? (ef.isBetter === undefined ? 0 : ef.isBetter ? Math.abs(ef.delta) : -Math.abs(ef.delta))

const bestChange = (rows: ChangeRow[], key: string) => {
  let best: { label: string; effect: Effect } | undefined
  for (const row of rows) {
    for (const ef of row.effects) {
      if (ef.key === key && ef.isBetter && (!best || gain(ef) > gain(best.effect))) best = { label: row.label, effect: ef }
    }
  }
  return best
}

const effectText = (ef: Effect, unit?: string) =>
  `${ef.key} ${signed(ef.delta)}${unit ? ` ${unit}` : ''}${ef.gapShare !== undefined ? ` (${ef.gapShare > 0 ? '+' : ''}${Math.round(ef.gapShare * 100)}% gap)` : ''}`

const summary = (list: Metric[], rows: ChangeRow[]) =>
  list
    .map(m => {
      const goal =
        m.target === undefined
          ? 'no goal yet'
          : `goal ${m.direction === 'up' ? '>=' : '<='} ${fmt(m.target, m.unit)} (${m.goalStatus}${isMet(m) ? ', met' : ''})`
      const best = bestChange(rows, m.key)
      const win = best ? `; biggest win so far: ${best.label} (${signed(best.effect.delta)})` : ''
      return `- ${m.key} = ${fmt(last(m)?.value, m.unit)}; ${goal}${win}; ${m.definition}`
    })
    .join('\n')

/** Findings the tracker raises by itself when a record moves a goal or exposes a trade-off. */
const autoInsights = (before: Metric[], after: Metric[], key: string, change: string | undefined): Insight[] => {
  const was = before.find(m => m.key === key)
  const now = after.find(m => m.key === key)
  if (!now) return []
  const at = Date.now()
  const n = now.history.length
  const by = change ? ` after "${change}"` : ''
  const out: Insight[] = []
  const metBefore = was ? isMet(was) : false
  if (!metBefore && isMet(now)) {
    out.push({ id: `met:${key}:${n}`, kind: 'met', at, text: `${key} reached its goal (${goalText(now).replace('goal ', '')})${by}.` })
  }
  if (metBefore && !isMet(now)) {
    out.push({ id: `lost:${key}:${n}`, kind: 'lost', at, text: `${key} slipped back past its goal (${fmt(last(now)?.value, now.unit)})${by}.` })
  }
  const row = change ? changeRows(after).find(r => r.label === change) : undefined
  if (row) {
    const up = row.effects.filter(ef => ef.isBetter === true).map(ef => ef.key)
    const down = row.effects.filter(ef => ef.isBetter === false).map(ef => ef.key)
    if (up.length && down.length) {
      out.push({ id: `tradeoff:${change}:${down.join(',')}`, kind: 'tradeoff', at, text: `Trade-off: "${change}" improved ${up.join(', ')} but hurt ${down.join(', ')}.` })
    }
  }
  return out
}

/** Add insights whose id is new; a dismissed id stays dismissed. */
const addInsights = (list: Insight[], fresh: Insight[]) => [...list, ...fresh.filter(f => !list.some(i => i.id === f.id))]

/** What auto resolves to: the pane once any goal is agreed, the band before that. */
const effectiveView = (v: View, list: Metric[]): 'band' | 'pane' =>
  v !== 'auto' ? v : list.some(m => m.goalStatus === 'agreed') ? 'pane' : 'band'

const parseDirection = (s: unknown): Direction | undefined =>
  s === 'up' || s === 'down' ? s : undefined

const HELP = [
  '/goodhart                      show the metrics (band or pane)',
  '/goodhart view auto|band|pane  auto (default) = band until a goal is agreed, then pane',
  '/goodhart objective <text>     set what this session is optimizing for',
  '/goodhart set <key> <target> [up|down]   set or change a goal (marks it agreed)',
  '/goodhart agree <key|all>      accept the goal Claude proposed',
  '/goodhart rm <key>             remove a metric',
  '/goodhart clear                remove all metrics and the objective',
].join('\n')

/** Open or close the pane to match the view; called after anything that changes agreed goals. */
async function syncView($: EngineInterface) {
  const v = effectiveView(await read($, view), await read($, metrics))
  if (v === 'pane') await $.ui.open(OPEN)
  else await $.ui.close({ id: PANE })
}

async function agree($: EngineInterface, keys: string[]) {
  await update($, metrics, l =>
    l.map(m => (keys.includes(m.key) && m.target !== undefined ? { ...m, goalStatus: 'agreed' as const } : m)),
  )
  await syncView($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'goodhart',
      description: 'Goodhart: show metrics, set or agree goals (/goodhart help)',
    })
    await $.tool.register({
      name: 'metric',
      isDeferred: false,
      description: [
        "Record a session metric in the Goodhart metric tracker.",
        'Each metric is (key, value, goal). You define the key and how the value is measured;',
        'the goal is agreed with the user: when you set target, it is shown as a proposal until the user runs /goodhart agree or /goodhart set.',
        'Call action "record" after each measurement; the first value is the baseline.',
        'Pass change = a short label of what was changed (e.g. "prompt caching"), the same label for every metric measured after that change,',
        'so the tracker can attribute each metric move to the change that caused it. Put details in note.',
        'Pass objective once to state what the session is optimizing for. Use action "remove" to drop a metric. Keep keys short (snake_case).',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['record', 'remove'] },
          key: { type: 'string' },
          value: { type: 'number', description: 'Measured value now.' },
          definition: { type: 'string', description: 'What it measures and how; required when the key is new.' },
          unit: { type: 'string' },
          target: { type: 'number', description: 'Proposed goal; does not override a goal the user agreed.' },
          direction: { type: 'string', enum: ['up', 'down'], description: 'up = higher is better.' },
          change: { type: 'string', description: 'Short label of the change that produced this value; shared across metrics.' },
          note: { type: 'string', description: 'Details of the change or measurement.' },
          objective: { type: 'string', description: 'One line: what this session is optimizing for.' },
        },
        required: ['action', 'key'],
      },
    })
    await $.tool.register({
      name: 'insight',
      isDeferred: false,
      description: [
        'Show the user a short insight in a band above the prompt, until they dismiss it.',
        'Post one when you notice something non-obvious about the tracked metrics or the work toward them:',
        'a change that drove most of a gain, a trade-off, a result inside the noise, a goal that looks wrong, a next lever worth trying.',
        'One sentence, concrete numbers, no restating what the metric pane already shows. Post rarely: at most one per finding.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: 'One sentence, under 120 characters.' } },
        required: ['text'],
      },
    })
    if (effectiveView(await read($, view), await read($, metrics)) === 'pane') void $.ui.open(OPEN)

    return next(e)
  })

  on('tool.call', { tool: new RegExp(`^${TOOL}$`) }, async ($, e) => {
    // MCP-style tool arguments arrive as top-level fields of the event.
    const input = e as unknown as Record<string, unknown>
    const key = String(input.key ?? '').trim()
    if (!key) return { result: 'Error: key is required.', isError: true }
    if (typeof input.objective === 'string') await update($, objective, () => String(input.objective))

    if (input.action === 'remove') {
      await update($, metrics, list => list.filter(m => m.key !== key))
      return { result: `Removed ${key}.` }
    }

    const existing = (await read($, metrics)).find(m => m.key === key)
    if (!existing && typeof input.definition !== 'string') {
      return { result: `Error: ${key} is new; give a definition.`, isError: true }
    }

    let message = ''
    const before = await read($, metrics)
    const after = await update($, metrics, list => {
      const now = Date.now()
      const prev = list.find(m => m.key === key)
      const m: Metric = prev
        ? { ...prev, history: [...prev.history] }
        : {
            key,
            definition: String(input.definition),
            history: [],
            direction: parseDirection(input.direction) ?? 'up',
            goalStatus: 'none',
          }
      if (typeof input.definition === 'string') m.definition = input.definition
      if (typeof input.unit === 'string') m.unit = input.unit
      if (typeof input.value === 'number') {
        m.history.push({
          value: input.value,
          at: now,
          id: String(input.tool_use_id ?? ''),
          ...(typeof input.change === 'string' ? { change: input.change } : {}),
          ...(typeof input.note === 'string' ? { note: input.note } : {}),
        })
      }
      if (typeof input.target === 'number') {
        if (m.goalStatus === 'agreed' && m.target !== input.target) {
          message = ` Goal stays at ${fmt(m.target, m.unit)} (agreed with the user); ask the user to change it with /goodhart set.`
        } else {
          m.target = input.target
          m.direction = parseDirection(input.direction) ?? m.direction
          m.goalStatus = m.goalStatus === 'agreed' ? 'agreed' : 'proposed'
        }
      }
      message = `Recorded ${key} = ${fmt(last(m)?.value, m.unit)}.${isMet(m) ? ' Goal met.' : ''}${message}`
      return prev ? list.map(x => (x.key === key ? m : x)) : [...list, m]
    })

    const fresh = autoInsights(before, after, key, typeof input.change === 'string' ? input.change : undefined)
    if (fresh.length) {
      await update($, insights, l => addInsights(l, fresh))
      $.ui.toast(fresh[fresh.length - 1]!.text)
    }

    return { result: message }
  })

  on('tool.call', { tool: new RegExp(`^${INSIGHT_TOOL}$`) }, async ($, e) => {
    const text = String((e as unknown as Record<string, unknown>).text ?? '').trim()
    if (!text) return { result: 'Error: text is required.', isError: true }
    const at = Date.now()
    await update($, insights, l => addInsights(l, [{ id: `claude:${at}`, kind: 'claude', at, text }]))
    return { result: 'Shown above the prompt until the user dismisses it.' }
  })

  on('command.run', { command: 'goodhart' }, async ($, e) => {
    const raw = e.args.trim()
    const [sub, key, a, b] = raw.split(/\s+/).filter(Boolean)
    if (!sub) {
      await syncView($)
      return { text: 'Goodhart shown. /goodhart help lists the commands.' }
    }
    if (sub === 'help') return { text: HELP }
    if (sub === 'view') {
      if (key !== 'auto' && key !== 'band' && key !== 'pane') return { text: 'Usage: /goodhart view auto|band|pane' }
      await update($, view, () => key)
      await syncView($)
      return { text: `Goodhart view: ${key}.` }
    }
    if (sub === 'objective') {
      const text = raw.slice('objective'.length).trim()
      await update($, objective, () => text)
      return { text: text ? `Objective: ${text}` : 'Objective cleared.' }
    }
    if (sub === 'clear') {
      await update($, metrics, () => [])
      await update($, objective, () => '')
      await syncView($)
      return { text: 'All metrics and the objective removed.' }
    }

    const list = await read($, metrics)
    const hit = list.find(m => m.key === key)
    if (sub === 'agree') {
      const keys = key === 'all' ? list.filter(m => m.goalStatus === 'proposed').map(m => m.key) : hit ? [hit.key] : []
      if (keys.length === 0) return { text: `Nothing to agree for "${key ?? ''}".` }
      await agree($, keys)
      return { text: `Agreed goals: ${keys.join(', ')}.` }
    }
    if (sub === 'rm') {
      if (!hit) return { text: `No metric "${key ?? ''}".` }
      await update($, metrics, l => l.filter(m => m.key !== key))
      await syncView($)
      return { text: `Removed ${key}.` }
    }
    if (sub === 'set') {
      const target = Number(a)
      if (!key || !Number.isFinite(target)) return { text: 'Usage: /goodhart set <key> <target> [up|down]' }
      const direction = parseDirection(b)
      await update($, metrics, l => {
        const prev = l.find(m => m.key === key)
        const m: Metric = {
          ...(prev ?? { key, definition: 'set by the user; Claude to define', history: [], direction: 'up' as Direction }),
          target,
          direction: direction ?? prev?.direction ?? 'up',
          goalStatus: 'agreed',
        }
        return prev ? l.map(x => (x.key === key ? m : x)) : [...l, m]
      })
      await syncView($)
      return { text: `Goal for ${key}: ${direction === 'down' ? '<=' : '>='} ${target} (agreed).` }
    }
    return { text: HELP }
  })

  // Attach the current metrics to each prompt as hidden context, so Claude steers toward them
  // (prompt.compose is passed over by a security plugin above this one).
  on('prompt.submit', async ($, e, next) => {
    const list = await read($, metrics)
    if (list.length === 0) return next(e)
    const goal = await read($, objective)
    const shown = (await read($, insights)).filter(i => !i.isDismissed)
    const block = [
      'Goodhart metrics for this session (record new values with mcp__goodhart__metric after each measurement, with a change label; optimize toward agreed goals; a proposed goal still needs the user to agree):',
      ...(goal ? [`Objective: ${goal}`] : []),
      summary(list, changeRows(list)),
      ...(shown.length ? ['Insights already shown to the user (do not repeat):', ...shown.map(i => `- ${i.text}`)] : []),
    ].join('\n')
    return next({ ...e, context: [...(e.context ?? []), block] })
  })

  // A small card under each record call in the transcript: the value at that moment, its step and the goal.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.props.tool !== TOOL || e.props.isRunning || e.props.isErrored) return next(e)
    const row = await next(e)
    const id = e.props.tool_use_id
    const m = (await read($, metrics)).find(x => x.history.some(pt => pt.id === id))
    const i = m ? m.history.findIndex(pt => pt.id === id) : -1
    const pt = m?.history[i]
    if (!m || !pt) return row
    const { Box, Text } = $.ui.resolve(e)
    const before = m.history[i - 1]
    const delta = before ? pt.value - before.value : undefined
    const better = delta === undefined || delta === 0 ? undefined : (delta > 0) === (m.direction === 'up')
    const p = progress(m, pt.value)
    const met = p === 1

    return (
      <Box flexDirection="column">
        {row}
        <Box borderStyle="round" borderColor={met ? 'green' : 'gray'} paddingX={1} flexDirection="column">
          <Text>
            <Text bold>{m.key}</Text>
            {'  '}
            {fmt(pt.value, m.unit)}
            {delta !== undefined && delta !== 0 ? <Text color={better ? 'green' : 'red'}> ({signed(delta)})</Text> : null}
            {i === 0 ? <Text dimColor> baseline</Text> : null}
            <Text dimColor>
              {'  '}
              {goalText(m)}
            </Text>
          </Text>
          {p !== undefined ? (
            <Text color={met ? 'green' : 'yellow'}>
              {bar(p, 20)} {Math.round(p * 100)}%{pt.change ? <Text dimColor>{'  '}{pt.change}</Text> : null}
            </Text>
          ) : null}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, metrics)
    const active = (await read($, insights)).filter(i => !i.isDismissed)
    const showMetrics = list.length > 0 && effectiveView(await read($, view), list) === 'band'
    const proposed = list.filter(m => m.goalStatus === 'proposed').map(m => m.key)
    if (e.props.hasSurvey || (!showMetrics && active.length === 0)) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const keyWidth = Math.max(0, ...list.map(m => m.key.length))
    const cols = e.props.bodyColumns ?? e.viewport?.columns ?? 80
    const TAG = { claude: ' INSIGHT ', met: ' GOAL MET ', lost: ' SLIPPED ', tradeoff: ' TRADEOFF ' } as const
    const TAG_BG = { claude: BB.amber, met: BB.green, lost: BB.red, tradeoff: BB.amber } as const
    const dismiss = (ids: string[]) =>
      void update($, insights, l => l.map(i => (ids.includes(i.id) ? { ...i, isDismissed: true } : i)))
    const shownInsights = active.slice(-3)

    return (
      <Box flexDirection="column">
        {shownInsights.map(i => (
          <Box>
            <Text backgroundColor={TAG_BG[i.kind]} color={BB.black} bold>
              {TAG[i.kind]}
            </Text>
            <Text color={BB.white}> {fit(i.text, Math.max(10, cols - TAG[i.kind].length - 14))} </Text>
            <Button key={`dismiss:${i.id}`} plain dimColor onPress={() => dismiss([i.id])}>
              ✕ dismiss
            </Button>
          </Box>
        ))}
        {active.length > 1 ? (
          <Box>
            <Text color={BB.grey}>{active.length > 3 ? ` +${active.length - 3} older  ` : ' '}</Text>
            <Button key="dismiss-all" plain dimColor onPress={() => dismiss(active.map(i => i.id))}>
              ✕ dismiss all
            </Button>
          </Box>
        ) : null}
        {(showMetrics ? list : []).map(m => {
          const now = last(m)
          const prev = m.history[m.history.length - 2]
          const delta = now && prev ? now.value - prev.value : undefined
          const better = delta === undefined || delta === 0 ? undefined : (delta > 0) === (m.direction === 'up')
          const p = progress(m)
          const met = isMet(m)
          return (
            <Box key={`band:${m.key}`}>
            <Text>
              <Text bold color={met ? 'green' : undefined}>
                {met ? '✓ ' : '  '}
                {m.key.padEnd(keyWidth)}
              </Text>
              {'  '}
              {fmt(now?.value, m.unit)}
              {delta !== undefined && delta !== 0 ? <Text color={better ? 'green' : 'red'}> ({signed(delta)})</Text> : null}
              {'  '}
              {p !== undefined ? (
                <Text color={met ? 'green' : 'yellow'}>
                  {bar(p, 10)} {String(Math.round(p * 100)).padStart(3)}%
                </Text>
              ) : null}
              <Text dimColor>
                {'  '}
                {goalText(m)}
                {m.goalStatus === 'proposed' ? ' (proposed)' : ''}
                {'  '}
                {sparkline(m, 12)}
              </Text>
            </Text>
            {m.goalStatus === 'proposed' ? (
              <Button key={`band-agree:${m.key}`} plain onPress={() => void agree($, [m.key])}>
                <Text backgroundColor={BB.amber} color={BB.black} bold>
                  {' AGREE '}
                </Text>
              </Button>
            ) : null}
            </Box>
          )
        })}
        {showMetrics && proposed.length > 1 ? (
          <Box>
            <Button key="band-agree-all" plain onPress={() => void agree($, proposed)}>
              <Text backgroundColor={BB.amber} color={BB.black} bold>
                {' AGREE ALL '}
              </Text>
            </Button>
            <Text dimColor>  agreeing a goal opens the full pane</Text>
          </Box>
        ) : showMetrics && proposed.length === 1 ? (
          <Text dimColor>  agreeing a goal opens the full pane</Text>
        ) : null}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, metrics)
    const goal = await read($, objective)
    const open = await read($, expanded)
    const W = Math.max(40, e.props.bodyColumns ?? e.viewport?.columns ?? 48)
    const clock = new Date(Date.now()).toTimeString().slice(0, 5)

    // Column widths of the metric table; TICKER takes what is left.
    const C = { last: 10, chg: 9, prog: 6, trend: 8 }
    const tickerW = Math.max(10, W - C.last - C.chg - C.prog - C.trend)

    const Bar = (props: { left: string; right?: string; bg: string; fg: string }) => (
      <Text backgroundColor={props.bg} color={props.fg} bold>
        {fit(` ${props.left}`, W - (props.right?.length ?? 0) - 1)}
        {props.right ?? ''}{' '}
      </Text>
    )

    const header = (
      <Bar left={`GOODHART <GO>  METRIC MONITOR`} right={clock} bg={BB.amber} fg={BB.black} />
    )

    if (list.length === 0) {
      return (
        <Box flexDirection="column">
          {header}
          <Text color={BB.amberDim}> NO METRICS. ASK CLAUDE TO PROPOSE, OR /goodhart set KEY TARGET</Text>
        </Box>
      )
    }

    const rows = changeRows(list)
    const used = 1 + (goal ? 2 : 0) + 2 + list.length * 2 + 2 + 1
    const changeFit = Math.max(1, Math.floor(((e.viewport?.rows ?? 30) - used) / 3))

    return (
      <Box flexDirection="column">
        {header}
        {goal ? (
          <Text>
            <Text color={BB.amber} bold> OBJ </Text>
            <Text color={BB.white}>{fit(goal, W - 5)}</Text>
          </Text>
        ) : null}
        {goal ? <Text> </Text> : null}

        <Bar left="1) METRICS" bg={BB.blue} fg={BB.white} />
        <Text color={BB.amberDim}>
          {fit(' TICKER', tickerW)}
          {'LAST'.padStart(C.last)}
          {'CHG'.padStart(C.chg)}
          {'GAP%'.padStart(C.prog)}
          {'  TREND'.padEnd(C.trend)}
        </Text>
        {list.map(m => {
          const now = last(m)
          const prev = m.history[m.history.length - 2]
          const delta = now && prev ? now.value - prev.value : undefined
          const better = delta === undefined || delta === 0 ? undefined : (delta > 0) === (m.direction === 'up')
          const p = progress(m)
          const met = isMet(m)
          const best = bestChange(rows, m.key)
          const isOpen = open === m.key
          return (
            <Box flexDirection="column">
              <Box>
                <Button
                  key={`m:${m.key}`}
                  plain
                  onPress={() => void update($, expanded, k => (k === m.key ? '' : m.key))}
                >
                  <Text color={met ? BB.green : BB.amber} bold>
                    {fit(`${isOpen ? '▾' : '▸'}${met ? '✓' : ' '}${m.key.toUpperCase()}`, tickerW)}
                  </Text>
                </Button>
                <Text color={BB.white} bold>
                  {fmtNum(now?.value).padStart(C.last)}
                </Text>
                <Text color={better === undefined ? BB.grey : better ? BB.green : BB.red}>
                  {(delta === undefined || delta === 0 ? '━ 0' : `${delta > 0 ? '▲' : '▼'}${fmtNum(Math.abs(delta))}`).padStart(C.chg)}
                </Text>
                <Text color={met ? BB.green : BB.amber}>
                  {(p === undefined ? '--' : String(Math.round(p * 100))).padStart(C.prog)}
                </Text>
                <Text color={BB.cyan}>
                  {'  '}
                  {sparkline(m, C.trend - 2)}
                </Text>
              </Box>
              <Box>
                <Text color={BB.grey}>
                  {`   TGT ${m.target === undefined ? '--' : `${m.direction === 'up' ? '≥' : '≤'}${fmtNum(m.target)}${m.unit ? ` ${m.unit}` : ''}`}`}
                  {m.goalStatus === 'agreed' ? ' AGREED' : ''}
                </Text>
                {m.goalStatus === 'proposed' ? (
                  <Button
                    key={`agree:${m.key}`}
                    plain
                    onPress={() => void agree($, [m.key])}
                  >
                    <Text backgroundColor={BB.amber} color={BB.black} bold>
                      {' AGREE '}
                    </Text>
                  </Button>
                ) : null}
                <Text color={BB.grey}>{best ? fit(`  BEST ${best.label.toUpperCase()}`, Math.max(0, W - 30)) : ''}</Text>
              </Box>
              {isOpen
                ? [...m.history].reverse().map((pt, i, arr) => {
                    const older = arr[i + 1]
                    const d = older ? pt.value - older.value : undefined
                    const good = d === undefined || d === 0 ? undefined : (d > 0) === (m.direction === 'up')
                    return (
                      <Text>
                        <Text color={BB.white}>{`     ${fmtNum(pt.value)}`.padEnd(13)}</Text>
                        <Text color={good === undefined ? BB.grey : good ? BB.green : BB.red}>
                          {(d === undefined || d === 0 ? '' : `${d > 0 ? '▲' : '▼'}${fmtNum(Math.abs(d))}`).padEnd(9)}
                        </Text>
                        <Text color={BB.amberDim}>{fit((pt.change ?? '').toUpperCase(), Math.max(0, W - 22))}</Text>
                      </Text>
                    )
                  })
                : null}
            </Box>
          )
        })}
        <Text> </Text>
        <Bar left="2) CHANGES" right={`${rows.length} TOTAL`} bg={BB.blue} fg={BB.white} />
        {rows.length === 0 ? <Text color={BB.grey}> NO LABELLED CHANGES YET</Text> : null}
        {rows.slice(0, changeFit).map((row, n) => {
          const isTradeOff = row.effects.some(ef => ef.isBetter === true) && row.effects.some(ef => ef.isBetter === false)
          const note = row.effects.find(ef => ef.note)?.note
          return (
            <Box flexDirection="column">
              <Text>
                <Text color={BB.amber} bold>
                  {` ${rows.length - n})`.padEnd(5)}
                </Text>
                <Text color={BB.white} bold>
                  {fit(row.label.toUpperCase(), W - 5 - (isTradeOff ? 10 : 0))}
                </Text>
                {isTradeOff ? (
                  <Text backgroundColor={BB.amber} color={BB.black} bold>
                    {' TRADEOFF '}
                  </Text>
                ) : null}
              </Text>
              <Text>
                {'     '}
                {row.effects.map((ef, i) => (
                  <Text color={ef.isBetter === undefined ? BB.grey : ef.isBetter ? BB.green : BB.red}>
                    {i > 0 ? '  ' : ''}
                    {abbrev(ef.key)} {ef.delta === 0 ? '━0' : `${ef.delta > 0 ? '▲' : '▼'}${fmtNum(Math.abs(ef.delta))}`}
                    {ef.gapShare !== undefined ? ` ${ef.gapShare > 0 ? '+' : ''}${Math.round(ef.gapShare * 100)}%` : ''}
                  </Text>
                ))}
              </Text>
              {note ? <Text color={BB.grey}>{fit(`     ${note}`, W)}</Text> : null}
            </Box>
          )
        })}
        {rows.length > changeFit ? <Text color={BB.grey}> +{rows.length - changeFit} OLDER</Text> : null}

        <Text> </Text>
        <Box>
          {list.some(m => m.goalStatus === 'proposed') ? (
            <Button
              key="agree-all"
              hotkey="a"
              onPress={() => void agree($, list.filter(x => x.goalStatus === 'proposed').map(x => x.key))}
            >
              agree all
            </Button>
          ) : null}
          <Text> </Text>
          <Button
            key="expand-all"
            hotkey="e"
            onPress={() => void update($, expanded, k => (k ? '' : (list[0]?.key ?? '')))}
          >
            {open ? 'collapse' : 'expand'}
          </Button>
          <Text> </Text>
          <Button
            key="to-band"
            hotkey="b"
            onPress={() => {
              void update($, view, () => 'band' as View)
              void $.ui.close({ id: PANE })
            }}
          >
            band view
          </Button>
        </Box>
      </Box>
    )
  })
}
