# Alibaba Token Plan media API contract

Verified against the official Qwen Cloud documentation on 2026-07-19.

## Fixed subscription surface

- Host: `https://token-plan.ap-southeast-1.maas.aliyuncs.com`
- Credential environment variable: `ALIBABA_CODE_API_KEY`
- Authorization: `Bearer <token>`
- Supported invocation surfaces: Claude Code, Codex, Codex-VL, and Pi through
  the packaged skill and CLI. Pi is not assumed to support MCP natively.
- Token Plan Individual Lite guardrails: interactive use only, one submit at a
  time, no batch generation, and no automatic retry of a generation POST.
- Never substitute the DashScope pay-as-you-go host.

The Token Plan documentation says coding tools cannot configure media models
as chat models. They must use a skill, command, agent, or equivalent extension.
The Individual plan is intended for interactive programming and agent-tool
work, not unattended scripts, backend services, or batch processing.

## Wan 2.7 image generation and editing

Synchronous endpoint:

`POST /api/v1/services/aigc/multimodal-generation/generation`

Allowed plan models:

- `wan2.7-image`
- `wan2.7-image-pro`

Request shape:

```json
{
  "model": "wan2.7-image",
  "input": {
    "messages": [{
      "role": "user",
      "content": [{"text": "prompt"}, {"image": "data-or-https-url"}]
    }]
  },
  "parameters": {
    "n": 1,
    "size": "1K",
    "enable_sequential": false,
    "watermark": false,
    "thinking_mode": true
  }
}
```

The content array requires exactly one text object and accepts zero to nine
image objects. Prompt maximum is 5,000 characters. Inputs may be JPEG, PNG,
BMP, or WEBP and are limited to 20 MB each. `wan2.7-image` supports 1K and 2K;
Pro also supports 4K for text-to-image only. The output image URL is under
`output.choices[*].message.content[*].image` and expires after 24 hours.

## HappyHorse video generation

Submit endpoint:

`POST /api/v1/services/aigc/video-generation/video-synthesis`

Required submission header: `X-DashScope-Async: enable`.

Allowed plan models:

- `happyhorse-1.1-t2v`
- `happyhorse-1.1-i2v`

Text-to-video input contains `prompt`; parameters contain `resolution`,
`ratio`, and `duration`. Image-to-video input additionally contains exactly one
`media` item with `type: first_frame` and an HTTPS or Base64 image in `url`;
its parameters omit `ratio` because output follows the first frame.

Duration is an integer from 3 through 15 seconds. Resolution is 720P or 1080P.
Text-to-video ratios are 16:9, 9:16, 1:1, 4:3, 3:4, 4:5, 5:4, 9:21, or 21:9.
The response task ID is `output.task_id`.

Status endpoint:

`GET /api/v1/tasks/{task_id}`

Terminal states are `SUCCEEDED`, `FAILED`, `CANCELED`, and `UNKNOWN`. On
success, `output.video_url` is an H.264 MP4 signed URL valid for 24 hours.

## Official sources

- https://docs.qwencloud.com/token-plan/best-practices/integrate-multimodal-gen
- https://docs.qwencloud.com/token-plan/personal/token-plan-personal-overview
- https://docs.qwencloud.com/api-reference/image-generation/wan27-image-gen-edit/synchronous
- https://docs.qwencloud.com/api-reference/video-generation/happyhorse-text-to-video/create-task
- https://docs.qwencloud.com/api-reference/video-generation/happyhorse-image-to-video/create-task
- https://docs.qwencloud.com/api-reference/video-generation/happyhorse-text-to-video/query-result
