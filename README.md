# AlphaMind

Multi-project Claude Code orchestration desktop app. One window, all your projects. A master Claude orchestrates child Claude Code instances across all your project directories.

> Internally codenamed **Simple Claude**.

## Features

- Multi-project sidebar with procedurally generated sigils (unique mandala icon per project)
- Live multi-tab Claude Code sessions via PTY
- Session history per project, click to resume any past conversation
- Activity indicators (running / unread / bell) on tabs and sidebar
- Tab persistence across app restarts (sessions auto-resume)
- macOS native notifications when Claude finishes in inactive tab
- **Map Mode** (Cmd+M) — radial graph view of all projects with live git stats
- **Master Pane** (Cmd+J) — chat-based orchestrator that can write to any project Claude tab
- Quick Switcher (Cmd+P), Help Overlay (Cmd+/), Image Resize (Cmd+Shift+I), and more

## Stack

- Electron + Vite + React + TypeScript
- xterm.js + node-pty (terminal emulation)
- @anthropic-ai/claude-agent-sdk (master agent)
- electron-updater (auto-update notifications)

## Develop

```
npm install
npm run dev          # development mode
npm run package:mac  # build .app + .dmg
npm run release      # build + publish to GitHub Releases
```

`npm run release` requires `GH_TOKEN` env var with repo `contents:write` permission.

## Releases

See [Releases](https://github.com/alphacoderapp/AlphaMind/releases) for downloads.

## License

MIT.
