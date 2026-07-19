# Alibaba Token Plan Personal engines

NexusCrew exposes three first-class managed profiles backed by one fixed local
credential name, `ALIBABA_CODE_API_KEY`:

- `claude.alibaba-token-plan`
- `codex-vl.alibaba-token-plan`
- `pi.alibaba-token-plan`

The credential value is resolved by the NexusCrew credential layer and is
passed only in the selected child process environment. Engine definitions,
generated extensions, argv, status responses and logs contain only the
environment-variable name, never its value. The default model is
`qwen3.8-max-preview` for all three profiles.

## Claude Code

- Anthropic-compatible base URL:
  `https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic`
  (Claude appends `/v1/messages`; the configured base must not include it).
- Authentication: `ANTHROPIC_AUTH_TOKEN` receives the locally resolved value;
  `ANTHROPIC_API_KEY` is deliberately empty.
- Aliases: MODEL/SONNET/OPUS/FABLE = `qwen3.8-max-preview`, HAIKU =
  `qwen3.6-flash`, SUBAGENT = `qwen3.7-max`.
- Context: `983616`; effort: `xhigh`. Qwen Cloud documents qwen3.8 thinking
  as always enabled and not user-disableable.
- State is isolated under
  `~/.nexuscrew/claude-profiles/alibaba-token-plan/` with private modes; the
  native Claude configuration is not modified and no credential is written
  there.

## Codex-VL

- Compatible base URL:
  `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`.
- Provider wire API: `responses`; provider `env_key`:
  `ALIBABA_CODE_API_KEY`. `OPENAI_API_KEY` is neither read nor forwarded by
  this profile, and there is no OpenAI/PAYG fallback.
- Latest-Codex allowlist: `qwen3.8-max-preview`, `qwen3.7-max`,
  `qwen3.7-plus`, `qwen3.6-flash`. GLM and DeepSeek are intentionally absent.
- The bundled qwen3.8 catalog pins context `983616`, effective context `95%`,
  reasoning levels `low/high/xhigh` with `xhigh` default, parallel tools off,
  text+image input and original image detail.
- Offline compatibility target: `codex-vl 0.144.7`.

## Pi

- Dedicated provider ID `alibaba-token-plan`, standard permissions only.
- A generated private extension refers to `$ALIBABA_CODE_API_KEY`; it contains
  no credential value.
- Qwen response-capable models use Pi's `openai-responses` adapter. `glm-5.2`
  and `deepseek-v4-pro` use Pi's `openai-completions` adapter, whose compatibility
  path preserves `reasoning_content` in replayed assistant/tool turns.
- `qwen3.8-max-preview` is reasoning-enabled, accepts text+image, uses context
  `983616`, and launches with `--thinking xhigh`.
- Offline compatibility target: `pi 0.80.10`.

## Verification boundary

Catalog, normalization, credential resolution, generated config/extension,
argv/env separation and local runtime loading are tested without network
access. No provider request is part of this candidate. Endpoint acceptance,
stream completion, vision input, tool round-trip and Token Plan quota behavior
remain post-reboot interactive smoke gates.

Primary references:

- https://docs.qwencloud.com/developer-guides/clients-and-developer-tools/claude-code
- https://docs.qwencloud.com/developer-guides/clients-and-developer-tools/codex
- https://docs.qwencloud.com/developer-guides/clients-and-developer-tools/openclaw
