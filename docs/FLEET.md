# Fleet and terminals

[← Documentation index](README.md)

## Cells

A **cell** is a reusable worker definition: tmux session name, working
directory, engine, model, permission policy, optional system prompt, optional
Shell command and boot state.

Starting a stopped cell opens the same launch sheet on desktop and mobile, so
the effective settings can be reviewed before the process starts. Cells marked
`boot:true` are started by the platform boot integration.

NexusCrew is the Fleet manager. Definitions, lifecycle, boot ownership,
restart supervision and write-only credentials are handled by its built-in
runtime; no external `fleet` executable is discovered or invoked.

Set `NEXUSCREW_FLEET=0` to disable Fleet entirely.

## Engines

Clean installations include these base adapters:

- Claude Code
- Codex
- Codex-VL
- Pi
- Agy on Linux and macOS
- Kimi Code CLI
- Shell

Agy delegates authentication to its local login and supports standard or
unsafe permission policies. On Android/Termux, use the Shell adapter with a
per-cell `agy` command.

Kimi Code CLI (`kimi.native`) runs the official `@moonshot-ai/kimi-code`
binary directly. Authentication and providers are owned by the CLI itself
(device-code login, `config.toml`): NexusCrew never reads, stores or injects
Kimi credentials. The cell prompt is not passed on the command line — the CLI
has no interactive prompt flag (`kimi -p` is non-interactive and skips the
TUI) — so it is injected with bracketed paste after the session is ready.
This engine is distinct from the Claude Code "Kimi Code" provider below,
which remains the managed K3 path with an isolated Claude configuration.

Custom argv-based engines are launched directly without a shell after
trust-boundary validation.

The Shell engine resolves `$SHELL` or a trusted platform shell at start time;
executable paths are not stored in Fleet definitions or backups. An empty
command opens an interactive login shell. A configured command is passed as
one opaque argument through the private launch broker, runs once without
restart supervision and then leaves the cell stopped.

## Providers

Provider choices are scoped to the selected CLI:

| CLI | Built-in choices |
|---|---|
| Claude Code | Anthropic, Alibaba Token Plan, OpenRouter, Kimi Code, Bedrock, Vertex AI, Foundry, Ollama Cloud, local Ollama, Z.AI, custom Anthropic-compatible |
| Codex | OpenAI/ChatGPT, OpenAI API, Ollama Cloud, local Ollama, LM Studio, custom Responses endpoint |
| Codex-VL | OpenAI/ChatGPT, OpenAI API, Alibaba Token Plan, OpenRouter, Ollama Cloud, local Ollama, LM Studio, custom Responses endpoint |
| Pi | Native, Anthropic, OpenAI API, Alibaba Token Plan, Codex OAuth, Gemini, Copilot, OpenRouter, Ollama, DeepSeek, Z.AI, custom |
| Kimi Code CLI | Native account via CLI login (device code); providers managed by the CLI |
| Shell | Device-local interactive shell or one trusted per-cell command |

Custom Codex-compatible endpoints use the Responses wire API; NexusCrew does
not silently fall back to Chat Completions.

OpenRouter is first-class for Claude Code and Codex-VL. Kimi Code is a separate
Claude Code membership profile and is not interchangeable with a Moonshot
pay-as-you-go key. It is also distinct from the native Kimi Code CLI engine:
the provider drives Claude Code against the Kimi endpoint through the managed
`ANTHROPIC_*` environment (K3 models, including the 1M-context profile), while
`kimi.native` launches the official CLI with its own login and configuration.

Alibaba Token Plan is available for Claude Code, Codex-VL and Pi through the
fixed local variable `ALIBABA_CODE_API_KEY`. See
[Alibaba Token Plan](ALIBABA_TOKEN_PLAN.md).

## Credentials and permissions

Permission handling is explicit:

- Claude engines use standard permissions or
  `--dangerously-skip-permissions`.
- Codex and Codex-VL use standard permissions or
  `--dangerously-bypass-approvals-and-sandbox`.
- Kimi Code CLI uses standard (interactive) permissions by default; the unsafe
  policy maps to `--yolo`, which auto-approves regular tool calls but still
  lets the agent ask questions. The fully autonomous `--auto` mode is
  deliberately not exposed.
- Pi uses its native permission behavior.

Provider keys are resolved on the node that launches the process. Values are
excluded from Fleet definitions, backups, API responses, tmux state, process
arguments, temporary files and logs.

Built-in providers with a fixed variable expose a dedicated **KEY** section.
It shows only the variable name, configured source and affected engines.
Replacing or removing a shared key warns which engines use it.

## Decks and workspaces

Desktop decks place multiple live terminals in a saved tiled layout. Decks
remain attached to the current PWA by default; `↗` detaches one into another
browser window.

Session and deck order can be changed with pointer drag-and-drop or keyboard
controls and is saved automatically. The deck bar groups workspaces by owner
node. Newly seen nodes start collapsed, and activity dots show current work
without opening every group.

On mobile, locations are independently collapsible and filterable by all,
pinned, active, off or technical sessions. Managed terminals use the logical
Fleet cell name as their visible title; tmux session and route identifiers
remain technical context.

When a mobile terminal is open, the key-bar cell control opens a bottom-left
quick rail. Its default view contains only cells whose local or routed Fleet
state and tmux session were freshly verified; it refreshes while open and
checks the target again before switching. A degraded cell remains visible as a
warning rather than disappearing. Use the explicit all-cells control for the
complete inventory, including stopped cells.

Choosing a row only selects it. Use the separate **Open cell** control to make
the switch, so an exploratory touch cannot replace the terminal under your
finger. Drag a row by its handle to reorder cells. That order is shared with
the main roster and desktop sidebar, retains unmanaged tmux sessions, and
keeps an offline cell's position for when it becomes active again.

## Terminal behavior

Terminal attachment uses `tmux attach -f ignore-size` by default, so a phone or
narrow browser cannot resize a session held by another terminal client.

Mobile controls expose:

- copy-mode scrolling
- window and pane navigation
- Escape, Ctrl-C, Enter, Page Up and Page Down
- detach
- compact or two-row key layouts
- speech-to-text where supported
- expandable per-cell prompt composer

Long text and multiline prompts use bracketed paste. Clipboard images and
dropped files are stored in the selected session inbox; their paths are
inserted without submitting Enter.

New sessions created by NexusCrew disable the tmux alternate screen by default.
Full-screen TUI output therefore remains in tmux history, so mobile finger
drags and normal terminal scrolling can browse it. Set `alternateScreen: true`
in the local NexusCrew config (or `NEXUSCREW_ALTERNATE_SCREEN=1`) to restore the
standard tmux behavior for future sessions created through Fleet. Existing and unmanaged
sessions are unchanged.

Desktop wheel events always browse tmux history, including in writable TUIs
that use the alternate screen and while Shift is held. Keep a user-owned tmux
`history-limit` of at least 10000; `nexuscrew doctor` diagnoses a lower value
without changing it.

Each owner-qualified cell keeps its own browser-local draft, composer size and
bounded prompt history. That state is not federated or included in Fleet
backups.

## Bundled skills

The package includes portable skills for optional MCP companions and
[`fill-forms`](../skills/fill-forms/SKILL.md). `fill-forms` inspects, fills and
visually validates local PDF and DOCX forms without overwriting the blank
source or sending documents elsewhere. Optional Python dependencies are not
installed automatically.

## Related guides

- [Configuration](CONFIGURATION.md)
- [Connect nodes](NODES.md)
- [Notifications](NOTIFICATIONS.md)
- [Security](SECURITY.md)
