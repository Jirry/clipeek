# clipeek

> See all your AI agents at a glance, tucked in the corner.

**clipeek**（瞄一眼）is a tiny, always‑on‑top macOS HUD that watches your local AI CLI sessions and shows each one as a traffic‑light dot — so you can tell at a glance which agent is working, which needs you, and which is done, without hunting through terminal tabs.

English · [中文](README.zh-CN.md)

<!-- TODO: add a screenshot / GIF of the HUD here -->

## Lights

| Light | Meaning |
| --- | --- |
| 🟢 Green | Done — idle, waiting for you |
| 🟢 Blinking | Just finished — your turn |
| 🟡 Yellow | Working (thinking / running a tool / replying) |
| 🟡 Blinking | Needs you (permission prompt / a question / plan approval) |
| 🔴 Red | Error (API error) |

Lights are ordered by urgency: red ▸ blinking‑yellow ▸ yellow ▸ green, newest activity first within a color.

## Features

- A compact bar of lights, one per live session — with an optional name under each.
- **Hover** a light → a tooltip with the session's name (editable) and working directory.
- **Double‑click** a light → jump straight to that session's terminal tab (Warp).
- Drag the handle to move the bar; drag the light area to scroll; drag the edges to resize.
- Bar mode (horizontal strip) or list mode (vertical, parked in a screen corner).
- Lives in the menu‑bar tray — no Dock icon, no window chrome.

## Requirements

- macOS
- [Node.js](https://nodejs.org/) (to run from source)
- [Claude Code](https://claude.com/claude-code)
- [Warp](https://www.warp.dev/) — only for the double‑click‑to‑focus feature (needs Warp ≥ `2026.05.27`)

## Run from source

```bash
git clone https://github.com/Jirry/clipeek.git
cd clipeek
npm install
npm start        # build + launch
# npm run dev    # watch & rebuild during development
```

## Status

- **Claude Code** — supported.
- **Codex** — planned.

## License

[MIT](LICENSE) © Jirry
