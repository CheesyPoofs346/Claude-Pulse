# Claude Pulse

Live local dashboard for your Claude Code usage — terminal **and** desktop app in one view.
Inspired by [Claude-Code-Usage-Monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor), rebuilt as a web app.

## Run

```
node server.js        # or double-click pulse.cmd
```

Then open http://localhost:4747. Zero dependencies (Node 18+). Auto-refreshes every 10s.

## What it shows

- **Current 5-hour block** — cost, tokens, messages, time to reset, and how it compares to your heaviest past block
- **Burn rate** — tokens/min and $/hour over the trailing hour
- **Today / last 7 days** — spend and volume
- **Daily spend, 30 days** — stacked by source (Terminal vs Desktop app)
- **By model / by source** splits
- **Recent sessions** — with human-readable titles pulled from the Claude desktop app

## How it works

Both the Claude Code CLI and the Claude desktop app write usage records to
`~/.claude/projects/**/*.jsonl`, tagged with an `entrypoint` field (`cli` vs
`claude-desktop`) — that's how the source split works. Session titles are joined
from the desktop app's store at `%APPDATA%/Claude/claude-code-sessions`.
Files are cached by mtime, deduplicated by `messageId:requestId`, and everything
stays on your machine.

Costs are estimates at Claude API list prices: cache writes ×1.25 (5-min TTL) or
×2 (1-hour TTL, split per record), cache reads ×0.1, Sonnet 5 intro pricing
($2/$10 per MTok through 2026-08-31, date-checked per entry), and web searches
at $10/1k. On a Pro/Max subscription they represent relative usage, not a bill.
