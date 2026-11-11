import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Direction, Metric, View } from '../types'

const PANE = 'goodhart'
const TITLE = 'Goodhart'
const TOOL = 'mcp__goodhart__metric'
const metrics = atom({ plugin: 'goodhart', key: 'metrics' } as const, [], {
  shape: 'metrics-1',
})
// Docked panes default to a big share of the screen; ask for a narrow one (the person can still drag it).
const OPEN = { id: PANE, title: TITLE, columns: 52, backgroundColor: '#000000' }
const view = atom({ plugin: 'goodhart', key: 'view' } as const, 'pane' as View)
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

const parseDirection = (s: unknown): Direction | undefined =>
  s === 'up' || s === 'down' ? s : undefined

const HELP = [
  '/goodhart                      show the metrics (band or pane)',
  '/goodhart view band|pane       band = lines above the prompt, pane = side panel',
  '/goodhart objective <text>     set what this session is optimizing for',
  '/goodhart set <key> <target> [up|down]   set or change a goal (marks it agreed)',
  '/goodhart agree <key|all>      accept the goal Claude proposed',
  '/goodhart rm <key>             remove a metric',
  '/goodhart clear                remove all metrics and the objective',
].join('\n')

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
    if ((await read($, view)) === 'pane') void $.ui.open(OPEN)

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
    await update($, metrics, list => {
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

    return { result: message }
  })

  on('command.run', { command: 'goodhart' }, async ($, e) => {
    const raw = e.args.trim()
    const [sub, key, a, b] = raw.split(/\s+/).filter(Boolean)
    if (!sub) {
      if ((await read($, view)) === 'pane') await $.ui.open(OPEN)
      return { text: 'Goodhart shown. /goodhart help lists the commands.' }
    }
    if (sub === 'help') return { text: HELP }
    if (sub === 'view') {
      if (key !== 'band' && key !== 'pane') return { text: 'Usage: /goodhart view band|pane' }
      await update($, view, () => key)
      if (key === 'pane') await $.ui.open(OPEN)
      else await $.ui.close({ id: PANE })
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
      return { text: 'All metrics and the objective removed.' }
    }

    const list = await read($, metrics)
    const hit = list.find(m => m.key === key)
    if (sub === 'agree') {
      const keys = key === 'all' ? list.filter(m => m.goalStatus === 'proposed').map(m => m.key) : hit ? [key] : []
      if (keys.length === 0) return { text: `Nothing to agree for "${key ?? ''}".` }
      await update($, metrics, l =>
        l.map(m => (keys.includes(m.key) && m.target !== undefined ? { ...m, goalStatus: 'agreed' as const } : m)),
      )
      return { text: `Agreed goals: ${keys.join(', ')}.` }
    }
    if (sub === 'rm') {
      if (!hit) return { text: `No metric "${key ?? ''}".` }
      await update($, metrics, l => l.filter(m => m.key !== key))
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
    const block = [
      'Goodhart metrics for this session (record new values with mcp__goodhart__metric after each measurement, with a change label; optimize toward agreed goals; a proposed goal still needs the user to agree):',
      ...(goal ? [`Objective: ${goal}`] : []),
      summary(list, changeRows(list)),
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
    if (e.props.hasSurvey || list.length === 0 || (await read($, view)) !== 'band') return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const keyWidth = Math.max(...list.map(m => m.key.length))

    return (
      <Box flexDirection="column">
        {list.map(m => {
          const now = last(m)
          const prev = m.history[m.history.length - 2]
          const delta = now && prev ? now.value - prev.value : undefined
          const better = delta === undefined || delta === 0 ? undefined : (delta > 0) === (m.direction === 'up')
          const p = progress(m)
          const met = isMet(m)
          return (
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
          )
        })}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, metrics)
    const goal = await read($, objective)
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
          return (
            <Box flexDirection="column">
              <Text>
                <Text color={met ? BB.green : BB.amber} bold>
                  {fit(` ${met ? '✓' : ' '}${m.key.toUpperCase()}`, tickerW)}
                </Text>
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
              </Text>
              <Text color={BB.grey}>
                {fit(
                  `   TGT ${m.target === undefined ? '--' : `${m.direction === 'up' ? '≥' : '≤'}${fmtNum(m.target)}${m.unit ? ` ${m.unit}` : ''}`}` +
                    ` ${m.goalStatus === 'agreed' ? 'AGREED' : m.goalStatus === 'proposed' ? 'PROPOSED' : ''}` +
                    (best ? `  BEST ${best.label.toUpperCase()}` : ''),
                  W,
                )}
              </Text>
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
        <Text>
          <Text backgroundColor={BB.amber} color={BB.black} bold> view band </Text>
          <Text color={BB.amberDim}> BAND  </Text>
          <Text backgroundColor={BB.amber} color={BB.black} bold> agree all </Text>
          <Text color={BB.amberDim}> ACCEPT  </Text>
          <Text backgroundColor={BB.amber} color={BB.black} bold> help </Text>
        </Text>
      </Box>
    )
  })
}
