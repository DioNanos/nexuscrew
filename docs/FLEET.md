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
- Shell

Agy delegates authentication to its local login and supports standard or
unsafe permission policies. On Android/Termux, use the Shell adapter with a
per-cell `agy` command.

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
| Shell | Device-local interactive shell or one trusted per-cell command |

Custom Codex-compatible endpoints use the Responses wire API; NexusCrew does
not silently fall back to Chat Completions.

OpenRouter is first-class for Claude Code and Codex-VL. Kimi Code is a separate
Claude Code membership profile and is not interchangeable with a Moonshot
pay-as-you-go key.

Alibaba Token Plan is available for Claude Code, Codex-VL and Pi through the
fixed local variable `ALIBABA_CODE_API_KEY`. See
[Alibaba Token Plan](ALIBABA_TOKEN_PLAN.md).

## Credentials and permissions

Permission handling is explicit:

- Claude engines use standard permissions or
  `--dangerously-skip-permissions`.
- Codex and Codex-VL use standard permissions or
  `--dangerously-bypass-approvals-and-sandbox`.
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

Mobile finger drags browse tmux history, including alternate-screen TUIs.
Desktop wheel events in writable alternate-screen TUIs remain
application-owned Page Up/Page Down; normal and read-only terminals use tmux
scroll.

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
