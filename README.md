# Rivet

Rivet is a simple app for running coding agents. Each worker runs in its own git worktree, so many agents can work on one repo at once without stepping on each other. It works with **Claude Code** and **Codex** (an Ollama model can be used for small local tasks).

## Installation

> [!WARNING]
> Rivet uses the agents you already have. Install at least one of these and log in first:
>
> - Claude Code: [install](https://docs.anthropic.com/en/docs/claude-code/setup), then `claude auth login`
> - Codex: `npm install -g @openai/codex`, then `codex login`

### Run without installing

```bash
npx rivet-code@latest
```

Needs Node.js 24 or newer.

### One-line install

Installs its own Node.js, so nothing else is needed.

Windows (PowerShell):

```powershell
irm https://kartikg-gk.github.io/rivetcode/install.ps1 | iex
```

macOS / Linux:

```bash
curl -fsSL https://kartikg-gk.github.io/rivetcode/install.sh | sh
```

### Desktop app

Download from [Releases](https://github.com/kartikg-gk/rivetcode/releases):

- Windows: `Rivet-Setup-<version>.exe` (or the portable `.exe`)
- macOS (Apple Silicon): `.dmg`
- Linux: `.AppImage` or `.deb`

The builds are not signed yet. On Windows choose **More info, Run anyway**; on macOS right-click the app and choose **Open**.

## Usage

```bash
rivet                 # start Rivet and open it in your browser
rivet ./my-project    # open it on a project folder
```

The first screen checks which agents are installed and logged in. Pick a repo, type what you want, and Rivet starts an agent in its own worktree. From the app you can follow the conversation, see changed files per prompt, rewind, switch agents, and open a pull request.

Everything also works from the terminal:

```bash
rivet spawn "add dark mode"     # start a worker on a task
rivet orchestrator "<goal>"     # an agent that splits the work and starts workers
rivet status                    # list sessions
rivet pr <run>                  # push and open the pull request
rivet stop <run>
rivet doctor                    # check what Rivet needs on this machine
rivet --help                    # every command
```

Keep it current with `rivet update`. Remove it with `rivet uninstall` (your data in `~/.rivet` stays).

## Notes

Rivet is early. Expect bugs. Issues and ideas are welcome.

## License

MIT
