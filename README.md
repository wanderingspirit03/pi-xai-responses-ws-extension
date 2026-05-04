# pi-xai-responses-ws-extension

Pi provider extension for native xAI Grok Responses over HTTP and WebSocket.

## Install

```bash
pi install https://github.com/wanderingspirit03/pi-xai-responses-ws-extension
```

For local testing:

```bash
pi -e ./index.ts --provider xai-responses --model grok-4.3 --print "Say OK"
```

## Configuration

Set your xAI API key:

```bash
export XAI_API_KEY=...
```

Optional runtime flags:

```bash
export XAI_RESPONSES_STORE=1
export XAI_RESPONSES_DELTA_CHAIN=1
export XAI_RESPONSES_TOOL_CHOICE=auto
export XAI_RESPONSES_URL=https://api.x.ai/v1/responses
export XAI_RESPONSES_REASONING=auto

export XAI_WS_REASONING=auto  # auto/off = omit parameter, or force low/high for experiments
export XAI_WS_STORE=1         # 1/default = let xAI retain response state for tool-result turns
export XAI_WS_DELTA_CHAIN=1   # 1/default = previous_response_id chaining, 0 = resend full context
export XAI_WS_TOOL_CHOICE=auto # optional: auto/required/none
export XAI_WS_URL=wss://api.x.ai/v1/responses

export XAI_BASH_GUARD=1              # 1/default = enforce bash tool timeouts
export XAI_BASH_DEFAULT_TIMEOUT=300  # default timeout for model bash calls, seconds
export XAI_BASH_SEARCH_TIMEOUT=45    # timeout for broad root grep/find searches, seconds
export XAI_BASH_MAX_TIMEOUT=900      # cap explicit bash timeouts from the model, seconds
```

`xai-responses` is the recommended provider for benchmark runs. It uses plain HTTP
`/v1/responses` with `store=true` and `previous_response_id` chaining, which avoids the long-lived
WebSocket continuation path. `xai-ws` remains available for latency experiments.

The extension also installs a small Pi `bash` tool guard. Pi's built-in bash timeout is optional,
so the guard patches bash tool calls before execution: commands without a timeout get
`XAI_BASH_DEFAULT_TIMEOUT`, broad root searches such as `grep -r /` or `find /` get
`XAI_BASH_SEARCH_TIMEOUT`, and model-supplied timeouts are capped by `XAI_BASH_MAX_TIMEOUT`.

## Model

The extension registers:

- provider: `xai-responses`
- provider: `xai-ws`
- model: `grok-4.3`
- API: `xai-responses-http` or `xai-responses-websocket`

Run:

```bash
pi --provider xai-responses --model grok-4.3 --thinking high --print "Create a tiny JS function"
```

Thinking note: indexed xAI docs currently say Grok 4-style models reason automatically and that
only `grok-4.20-multi-agent` accepts `reasoning.effort` values (`low` / `high`). Live probing of
native `grok-4.3` rejected both `reasoning: { "effort": "low" }` and
`reasoning: { "effort": "high" }` with `Model grok-4.3 does not support parameter reasoningEffort`.
The extension therefore omits the reasoning parameter by default, even if Pi is launched with
`--thinking high`.
