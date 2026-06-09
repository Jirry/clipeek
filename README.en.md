# CliPeek

> See all your AI agents at a glance, tucked in the corner.

[![CI](https://github.com/Jirry/clipeek/actions/workflows/ci.yml/badge.svg)](https://github.com/Jirry/clipeek/actions/workflows/ci.yml)

[中文](README.md) · English

**CliPeek**（瞄一眼)is a tiny, always‑on‑top macOS HUD that watches your local AI CLI sessions and shows each one as a traffic‑light dot — so you can tell at a glance which agent is working, which needs you, and which is done, and jump to its terminal with a click or a keystroke, without hunting through tabs.

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

## Keyboard

| Shortcut | Effect |
| --- | --- |
| **`⌘J`** (Command + J) | **Smart jump** — go to the session that most needs you |
| **`⌘⇧J`** (Command + Shift + J) | **Cycle all** — ignore state, step through every light in order |
| **Click a dot / list row** | Jump to that session's terminal tab |

Both shortcuts **focus the target session's terminal** and **flash that light (white ring + pulse, ~2.5s)** — pressing again reverts the previous one immediately. They share one "current" cursor, so "next" always moves on from the current dot.

- **`⌘J` (smart):** cycles **active** sessions by urgency — **🔴 error ▸ 🟡 blinking amber (needs you) ▸ 🟡 amber (working) ▸ 🟢 blinking green (your turn)**; only if there are none does it fall back to your 🟢 green (done / idle) ones.
- **`⌘⇧J` (cycle all):** ignores state and steps through **every** light in bar order — always reaches any session (working, green, anything).

> Both shortcuts can be customized in **Settings** (record your own combo). Note `⌘J` is a global shortcut and will override ⌘J in your other apps.

## Features

- **One dot per live session**, in a compact bar — with the session's name under each (toggleable).
- **Hover** a dot → a tooltip with the session's name and working directory; click ✏︎ to rename it (local only — your real session name is untouched).
- **Two layouts**, switchable in one click:
  - **Bar** — a horizontal strip of dots, parked along your Dock.
  - **List** — a vertical panel in a screen corner, with a one‑line summary, names, paths and idle time.
- **Move / scroll / resize / zoom** — drag the handle to move (across multiple displays); drag the dots to scroll; drag the edges to resize; set zoom in Settings. Position, size and renames are remembered across restarts.
- **Menu‑bar tray** — no Dock icon, no window chrome; the tray title shows an aggregate light + the number of live sessions.

## Settings

Menu‑bar icon (or right‑click a dot) → **Settings…**:

- **Shortcuts** — customize `⌘J` (smart jump) and `⌘⇧J` (cycle all); just record the keys.
- **Appearance** — zoom, bar / list layout, whether to show names under the dots.
- **Window** — reset position (back to the bottom‑right of the current screen), restore default size.
- **General** — launch at login (start CliPeek automatically when you log in).

## Requirements

- macOS
- [Node.js](https://nodejs.org/) (to run from source)
- [Claude Code](https://claude.com/claude-code)
- [Warp](https://www.warp.dev/) — for jumping to a terminal tab (needs Warp ≥ `2026.05.27`). Other terminals still show status fine, they just can't be focused yet.

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
npm run dist     # electron-builder → release/CliPeek-<version>-{arm64,x64}.{dmg,zip}
```

The build is **unsigned** (no Apple Developer certificate). macOS Gatekeeper blocks unsigned apps on first launch — remove the quarantine flag once, then open normally:

```sh
xattr -dr com.apple.quarantine /Applications/CliPeek.app
```

## Note

On first launch CliPeek installs a small, removable Claude Code hook (files under `~/.clipeek/`, registered in `~/.claude/settings.json`) so it can detect permission prompts, the start and end of a turn (to switch lights promptly), and open the right terminal tab. It only adds its own entries and never touches your other hooks — delete them to uninstall.

## Status

- **Claude Code** — supported.
- **Codex** — planned.

## License

[MIT](LICENSE) © Jirry
