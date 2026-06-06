# clipeek

> See all your AI agents at a glance, tucked in the corner.

**clipeek**（瞄一眼)is a tiny, always‑on‑top macOS HUD that watches your local AI CLI sessions and shows each one as a traffic‑light dot — so you can tell at a glance which agent is working, which needs you, and which is done, and jump straight to its terminal with a click, without hunting through tabs.

English · [中文](README.zh-CN.md)

<!-- TODO: add a screenshot / GIF of the HUD here -->

## Lights

| Light | Meaning |
| --- | --- |
| 🟢 Green | Done — idle, waiting for you |
| 🟢 Green, blinking | Done, your turn — just finished, or the agent is waiting for your input |
| 🟡 Amber | Working — thinking, running a tool, or replying |
| 🟡 Amber, blinking | Needs you — permission prompt, a question, or plan approval |
| 🔴 Red | Error — API error / crash |

Dots are ordered by urgency (red ▸ blinking amber ▸ amber ▸ blinking green ▸ green), newest activity first within a color. Closed sessions disappear on their own.

## Features

- **One dot per live session**, in a compact bar — with the session's name under each (toggleable).
- **Click** a dot (or a list row) → jump straight to that session's terminal tab.
- **Hover** a dot → a tooltip with the session's name and working directory; click ✏︎ to rename it (local only — your real session name is untouched).
- **Two layouts**, switchable from the tray menu:
  - **Bar** — a horizontal strip of dots, parked along your Dock.
  - **List** — a vertical panel in a screen corner, with a one‑line summary, names, paths and idle time.
- **Move / scroll / resize / zoom** — drag the handle to move; drag the dots to scroll; drag the edges to resize; zoom from the menu. Position, size and renames are remembered across restarts.
- **Menu‑bar tray** — no Dock icon, no window chrome; the tray title shows an aggregate light + the number of live sessions.

## Requirements

- macOS
- [Node.js](https://nodejs.org/) (to run from source)
- [Claude Code](https://claude.com/claude-code)
- [Warp](https://www.warp.dev/) — for click‑to‑focus a terminal tab (needs Warp ≥ `2026.05.27`). Other terminals still show status fine, they just can't be focused yet.

## Run from source

```bash
git clone https://github.com/Jirry/clipeek.git
cd clipeek
npm install
npm start        # build + launch
# npm run dev    # watch & rebuild during development
```

## Build a release

```bash
npm run dist     # electron-builder → release/clipeek-<version>-arm64.dmg
```

The dmg is **unsigned** (no Apple Developer certificate) and **Apple‑Silicon (arm64) only**. On first launch macOS Gatekeeper will block it — right‑click the app → **Open**, or run `xattr -dr com.apple.quarantine /Applications/clipeek.app`.

## Note

On first launch clipeek installs a small, removable Claude Code hook (files under `~/.clipeek/`, registered in `~/.claude/settings.json`) so it can detect permission prompts / turn completion and open the right terminal tab. It only adds its own entry and never touches your other hooks — delete those entries to uninstall.

## Status

- **Claude Code** — supported.
- **Codex** — planned.

## License

[MIT](LICENSE) © Jirry
