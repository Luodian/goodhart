# goodhart

A Claude Code mod for optimizing toward metrics without losing sight of what they cost. You and Claude keep a list of `(key, value, goal)` metrics for the session: Claude defines each key and how its value is measured, proposes a goal, and you agree or set it. Every recorded value carries a short change label, so the tracker shows which change moved which metric, flags trade-offs where one metric improves while another gets worse, and keeps the current metrics in front of Claude on every prompt.

Named after Goodhart's law: when a measure becomes a target, it stops being a good measure. Watching every metric side by side is the guard.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install goodhart --marketplace Luodian/goodhart
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```
claude plugin install goodhart --marketplace Luodian/goodhart
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `Luodian/goodhart`, then Add plugin.

## Use

Ask Claude to propose metrics for the task at hand. Claude records values with the `metric` tool; you steer with `/goodhart`:

| Command | What it does |
|---|---|
| `/goodhart` | Show the metrics |
| `/goodhart view pane` | Side panel in a terminal-style layout: metrics table, change log, trade-offs |
| `/goodhart view band` | One line per metric above the prompt |
| `/goodhart objective <text>` | Set what the session is optimizing for |
| `/goodhart set <key> <target> [up\|down]` | Set or change a goal (marks it agreed) |
| `/goodhart agree <key\|all>` | Accept the goals Claude proposed |
| `/goodhart rm <key>` / `/goodhart clear` | Remove one metric / everything |

Each record call also draws a small card in the transcript with the value at that moment, its step and the goal. The side panel docks beside the transcript in the fullscreen terminal layout from 110 columns; on the main screen it opens above the prompt.

## License

MIT
