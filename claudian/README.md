# OKF Claudian

The Workspace fork of [Claudian](https://github.com/YishenTu/claudian) provides embedded
agent chat, inline editing, attachments and provider runtimes. OKF handoffs target Codex
through the public `okfBridge v1`. Source and adoption boundaries: [UPSTREAM.md](UPSTREAM.md).

## Requirements and use

- Obsidian v1.13.0+
- Desktop only: Windows, macOS or Linux.
- An installed, authenticated CLI for the selected provider; Workspace handoffs require Codex.

Install through the [Workspace deployment guide](../docs/DEPLOYMENT.md#plugin-deployment).
Open the sidebar from the ribbon or command palette. See [daily use](../docs/USER-GUIDE.md#claudian)
and the [handoff protocol](../docs/INTERFACES.md#bridge).

## CLI troubleshooting

Leave the provider CLI path empty for auto-detection first. If discovery fails, check that
Obsidian's GUI environment can find both the CLI and Node.js, then set the executable path
or the provider environment's PATH. On Windows, Claude uses its native executable or npm
`cli-wrapper.cjs`; `.cmd` and `.ps1` wrappers are unsuitable. Keep provider authentication separate.

## Development and privacy

Use the Node version in `.node-version`, `npm ci` and `npm run dev`.
Checks and component constraints live in [AGENTS.md](AGENTS.md) and the
[development guide](../docs/DEVELOPMENT.md#检查与构建).

Input, attachments and tool outputs may be sent to the selected provider and configured MCP
services. Claudian has no telemetry beacons; UI polling reads local editor state.
Runtime network requests follow the selected provider and configured services.

Licensed under the [MIT License](LICENSE); original authorship remains in the license and source.
