# pi-xai-responses-ws-extension

Pi provider extension for native xAI Grok Responses over WebSocket.

## Install

```bash
pi install https://github.com/wanderingspirit03/pi-xai-responses-ws-extension
```

For local testing:

```bash
pi -e ./index.ts --provider xai-ws --model grok-4.3 --print "Say OK"
```

## Configuration

Set your xAI API key:

```bash
export XAI_API_KEY=...
```

Optional runtime flags:

```bash
export XAI_WS_REASONING=auto  # auto/off = omit parameter, or force low/high for experiments
export XAI_WS_STORE=1         # 1/default = let xAI retain response state for tool-result turns
export XAI_WS_DELTA_CHAIN=1   # 1/default = previous_response_id chaining, 0 = resend full context
export XAI_WS_TOOL_CHOICE=auto # optional: auto/required/none
export XAI_WS_URL=wss://api.x.ai/v1/responses
```

`XAI_WS_STORE=1` with response chaining is the current recommended mode for agent/tool workloads.
In live testing on May 3, 2026, `previous_response_id` continuation with `store=false` returned a
not-found error even on the same socket. Full-context mode avoids that specific path, but native
xAI tool-result turns are more reliable when the prior response is retained and continued with
`previous_response_id`.

## Model

The extension registers:

- provider: `xai-ws`
- model: `grok-4.3`
- API: `xai-responses-websocket`

Run:

```bash
pi --provider xai-ws --model grok-4.3 --thinking high --print "Create a tiny JS function"
```

Thinking note: indexed xAI docs currently say Grok 4-style models reason automatically and that
only `grok-4.20-multi-agent` accepts `reasoning.effort` values (`low` / `high`). Live probing of
native `grok-4.3` rejected both `reasoning: { "effort": "low" }` and
`reasoning: { "effort": "high" }` with `Model grok-4.3 does not support parameter reasoningEffort`.
The extension therefore omits the reasoning parameter by default, even if Pi is launched with
`--thinking high`.
