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
- Grok on Linux and macOS
- VL
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

VL (`vl.native`) wraps the local Vivling runtime: NexusCrew never reads or
copies its credentials, and the model chosen in the UI travels separately from
the runtime's own configuration. Remote variants (Anthropic, custom endpoint)
exist in the catalog but are never seeded: a cell that needs a key or an
endpoint would fail at its first start.

Activity hooks are injected only into CLI versions that have been verified
against them. On any other version no hook is installed and the cell runs
without them — a declared limitation, not a failure.

### VL engine fields (per-cell identity, binary, profile, effort)

A `vl` engine accepts four optional fields. They are paths and names — never
secrets — and they are validated twice: the *shape* when the definition is
saved, the *truth on the node* at every launch.

- `vlBinary` — absolute path of the `vl` executable on the **node that runs
  the cell**. When declared it is the only binary considered: NexusCrew does
  not fall back to the `PATH`. A declared binary that is missing, is not a
  regular file, or is not executable refuses the start with a declared reason.
  The same resolved file is used for the version probes and for the spawn, so
  the gate never interrogates a different executable than the one launched.
  Spaces in the path are legal. Without the field, the `PATH` is used exactly
  as before.
- `vlConfigFile` — absolute path of a shared `config.toml` catalog of `vl`
  profiles. At every launch NexusCrew copies it into the cell's own
  `config/vl/config.toml` (atomic write, mode 0600). The cell's
  `selected.toml` is never created nor touched, and no `secrets.env` is ever
  written: keys travel by name only.
- `vlProfile` — a single `-p <name>` argument, valid on `vl.native` only (the
  remote variants already compose provider and endpoint, and the two choices
  exclude each other). A profile that is not in the catalog refuses the start
  explicitly. In profile mode `VL_PROVIDER` and `VL_BASE_URL` are neutralized,
  as are `VL_MODEL` and `VL_EFFORT` when NexusCrew carries no explicit
  choice. Precedence: explicit operator choice > profile > the cell's own
  `selected.toml`.
- `effort` — accepted only among the levels declared for the model, and only
  when the selected binary is new enough to read `VL_EFFORT`. An unsupported
  or unknown level refuses the start with a declared error instead of being
  ignored or promoted to another level.

### Choosing the model of a `vl.native` cell: the profiles of the node

On `vl.native` the model is chosen among the **profiles of the node that runs the
cell**, not among models NexusCrew knows. The list comes from two commands of the
binary that will actually run, started with the cell's own environment and
without a turn: `vl status` (the gate) and `vl models --json` (the inventory).
NexusCrew never reads the profile catalog itself.

- **Capability gate.** A profile name goes in `VL_MODEL` only when `vl status`
  declares `capabilities.model_selector = "profile"`. The version number is never
  consulted: an old and a new `vl` both say 0.4.0, and an old one would send the
  name to the provider as a model id. A binary that does not declare it, or whose
  `vl status` does not answer, never receives a profile name in `VL_MODEL`: if the
  value names a profile of the cell's catalog the launch uses the bridge
  `-p <profile>` with `VL_MODEL` absent, otherwise the raw model travels as it
  always did.
- **Inventory.** The document is validated before use — `schema_version` 1, every
  value inside its closed vocabulary, every id and model shaped like an
  identifier — and refused whole otherwise, naming the field and never echoing the
  value. Only id, provider, model, context, output limit, source and
  `key: present|absent|not_needed` leave NexusCrew; no key value, endpoint, path
  or environment can, whatever the document carries. Profiles that share a model
  (accounts A and P) stay two entries.
- **The selector is opaque.** On `vl.native` without a fixed profile the saved
  value (and the per-cell override) is a profile **selector**: it is stored and
  passed exactly as typed. The model aliases that map a legacy model name to its
  new name never apply to it — a legacy name can be the id of another profile — and
  the exact, case-sensitive profile id is matched before any comparison by model.
  Every other client, and every remote variant, keeps its aliases.
- **UI.** The engine editor and the cell editor list `<model> · <profile id>`; the
  profile **id** is what is saved and passed. A profile with no key on the node is
  listed and marked, not hidden: the choice is the operator's, and `key: present`
  is a view of the node's credentials, not proof that the credential works. The
  profiles the node declares it could not list (`excluded`) are shown as a count.
- **Only what the operator declared.** The built-in presets are never offered and
  never accepted by the preflight, whatever the inventory kind: the runtime
  resolves them by name (`preset_names_resolvable`, information about the runtime,
  not permission for NexusCrew to propose them). When the configuration declares no
  profile at all the inventory is the built-in catalog; the editors then say
  "no profile declared" and offer nothing, and the preflight refuses with the same
  reason.
- **A new engine.** The list of a `vl.native` engine that is not saved yet comes
  with the node's definitions (`vlProfilesDefault`): the default `vl` binary of
  the node that serves them, with the operator's catalog. A form that declares its
  own binary, catalog file or fixed profile never reuses it — it would describe
  another binary or catalog — and says the list is not read there; the same holds
  when a saved engine's binary, catalog or profile is edited. The form also says
  when the node is being read, when the node gave no list, and when its binary is
  old or its inventory invalid.
- **Preflight.** At launch the value must be the id of a profile of the inventory
  or the model of exactly one: an unknown value, or a model shared by several
  profiles, refuses the start naming the available profiles, instead of failing
  inside the cell. A missing key does not refuse the start (the runtime says what
  is missing); the launch diagnostics carry its state.
- **Unchanged, and what is checked where.** Remote and custom variants
  (`VL_PROVIDER` + `VL_BASE_URL`) keep the raw model. With a declared catalog file
  (`vlConfigFile`) there is no list; the launch checks the choice against the
  catalog copied into the cell. With a fixed `vlProfile` the model is a plain model
  override and the launch only checks that the profile exists in the catalog: the
  inventory preflight does not apply.

Every `vl` cell also gets its own identity directory under the NexusCrew state
tree, keyed by owner instance id and cell id, with private `XDG_STATE_HOME`,
`XDG_DATA_HOME` and `XDG_CONFIG_HOME`. Two cells on the same engine are
isolated down to the host, not just in their environment.

The cell prompt travels only through `VL_SYSTEM_APPEND_FILE`. NexusCrew never
reads, rewrites, archives, rotates or deletes `vl` sessions, never deletes a
lock, and never puts a credential on the command line.

### Bootstrap prompt delivery (Kimi engines)

For `kimi.native` and the Claude Code "Kimi Code" provider the cell prompt is
never placed on the process command line. It is delivered to the interactive
prompt only, at most once per process generation:

- Before delivering, NexusCrew classifies the visible terminal. Login,
  custom-API-key consent and onboarding/trust dialogs are **not ready**: no
  text is pasted and no Enter is sent, so the prompt can never be lost behind
  a dialog. The session stays alive and usable.
- If the terminal is still not ready after a bounded wait, the up response
  reports a bounded `actionRequired` code with a recovery hint. For the
  Claude Code "Kimi Code" provider the recovery is to confirm or enable the
  custom API key in the cell terminal (`/config` → "Use custom API key") and
  then restart the cell — never the Anthropic `/login` flow. For `kimi.native`
  it is the CLI's own `/login` (device code) or `/provider`.
- Delivery itself is a single bracketed paste followed by a separate Enter,
  targeted at the exact pane, and is owned solely by the cell's supervising
  launcher for every process generation (the API runtime never pastes for
  these engines; it only reads the bounded delivery outcome the launcher
  publishes on the pane). There is no automatic retry after a paste attempt;
  a supervised restart delivers the prompt at most once again for the new
  process generation.

MCP servers started by an AI CLI inherit that process's environment according
to the CLI's own configuration and behavior; that inheritance is owned by the
CLI, not by NexusCrew.

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

The package ships portable skills, and
[`nexuscrew`](../skills/nexuscrew/SKILL.md) is the one to read first: it
describes the whole system, what an AI agent can do through it, and the rules
that hold across every other skill.

Two extend Fleet itself: [`live`](../skills/live/SKILL.md) covers designating
and permitting a node's Live host cell, plus the
[per-cell voice prompt](LIVE_PROMPT.md) it reads once a session lands, and
[`aidesktop`](../skills/aidesktop/SKILL.md) covers a cell's web panel together
with the AI Desktop container recipe. The rest cover one capability each — the
operator channel ([`nexuscrew-agent`](../skills/nexuscrew-agent/SKILL.md)) and
the optional MCP companions listed in
[`mcp-companions.json`](../mcp-companions.json):
[`memory`](../skills/memory/SKILL.md),
[`vl-msa`](../skills/vl-msa/SKILL.md),
[`crew`](../skills/crew/SKILL.md) and
[`mail-assistant`](../skills/mail-assistant/SKILL.md). The companions are
separate servers: absent unless installed, and never installed silently.

## Related guides

- [Configuration](CONFIGURATION.md)
- [Connect nodes](NODES.md)
- [Notifications](NOTIFICATIONS.md)
- [Security](SECURITY.md)
