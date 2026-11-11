export type Direction = 'up' | 'down'

/** band = compact lines above the prompt; pane = side panel. */
export type View = 'band' | 'pane'

export type Point = {
  value: number
  at: number
  /** The tool call that recorded it, so the transcript card finds its point. */
  id?: string
  /** Short label of the change that produced this value (e.g. "prompt caching"); groups values across metrics. */
  change?: string
  note?: string
}

export type Metric = {
  key: string
  /** What the metric measures and how Claude reads it. */
  definition: string
  unit?: string
  /** Every recorded value, oldest first; the first one is the baseline. */
  history: Point[]
  target?: number
  direction: Direction
  /** proposed = Claude suggested the goal; agreed = the user confirmed or set it. */
  goalStatus: 'none' | 'proposed' | 'agreed'
}

declare module 'claude-code' {
  interface PluginState {
    'goodhart': { metrics: Shaped<Metric[]>; view: View; objective: string }
  }
}
