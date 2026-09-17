# pi-jev-agent

`pi-jev-agent` is an experimental extension for the [Pi coding agent](https://pi.dev). It uses [TypeSafe Jev](https://docs.typesafe.ai) to choose the next tool before each language-model step.

Pi normally gives the language model every active tool definition and lets the model decide what to call. That tool catalog can consume substantial input context when many extensions are installed. `pi-jev-agent` moves the bounded tool-selection decision to Jev, then gives the main model only the selected tool and its schema.

The main model still performs the actual coding work, generates tool arguments, interprets results, and writes responses. Jev only decides which tool should be available next, or whether the model should answer without a tool.

## Status

This project is an experiment, not a transparent performance upgrade. It adds one TypeSafe API request before each model step and can select the wrong tool. Measure task completion, cost, tokens, and latency on your own workload before relying on it.

The routing design is adapted from [vinilana/jev-eval-agent](https://github.com/vinilana/jev-eval-agent), which compares direct LLM tool selection against Jev routing over a large mock tool catalog.

## How it works

```text
User asks Pi to complete a task
  -> Jev reads the request and compact action history
  -> Jev selects one registered Pi tool
  -> Main model sees only that tool and generates its arguments
  -> Pi executes the tool
  -> Jev reads the result and selects the next tool
  -> Repeat until Jev selects respond_to_user
  -> Main model receives no tools and writes the response
```

Each routing request contains:

- the current user request
- registered tool names and descriptions
- completed tool calls, including arguments and clipped results
- short assistant-text excerpts from earlier steps

Jev answers two typed questions in one request:

- `next_tool`: one registered tool or `respond_to_user`
- `done`: whether Pi is ready to respond

If Jev selects `respond_to_user` before the readiness probability reaches `PI_JEV_DONE_THRESHOLD`, the extension exposes the next-best real tool instead. A request is ready when all required tool actions are complete or when it can be answered without any tool.

## Requirements

- Pi 0.85.1 or newer
- Node.js 20 or newer
- A [TypeSafe](https://typesafe.ai) API key

## Installation

Install the package with Pi:

```sh
pi install npm:pi-jev-agent
```

Set the required environment variables before starting Pi:

```sh
export TYPESAFE_API_KEY="your-key"
export PI_JEV_ENABLED=1
pi
```

The extension is a no-op unless `PI_JEV_ENABLED=1`. If routing is enabled without `TYPESAFE_API_KEY`, Pi keeps its normal tool configuration and shows a warning.

To try a local checkout without installing it:

```sh
PI_JEV_ENABLED=1 pi -e /absolute/path/to/pi-jev-agent
```

## Privacy and security

Enabling the extension sends the user prompt, tool names and descriptions, short assistant excerpts, tool-call arguments, and clipped tool results to TypeSafe for routing.

The extension does not independently read files, environment variables, or credentials for its routing request. Sensitive data already present in a prompt, tool argument, or tool result can still be sent. Do not enable the extension for workloads whose state must remain entirely local.

Tool results are clipped to 600 characters by default. Clipping limits payload size; it is not a secret-redaction mechanism.

## Failure behavior

The extension fails open. If TypeSafe times out, rejects the request, or returns an invalid decision, Pi restores the complete tool catalog plus the `jev_search_tools` recovery tool. The agent can then continue with normal LLM tool selection.

Routing is scoped to one user run. After the run ends, the extension leaves only its recovery tool active until the next request is classified.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_JEV_ENABLED` | unset | Set to `1` to enable external step-level routing. |
| `TYPESAFE_API_KEY` | unset | Bearer token used for TypeSafe System One requests. |
| `PI_JEV_DONE_THRESHOLD` | `0.5` | Minimum readiness probability required to accept `respond_to_user`. |
| `PI_JEV_TIMEOUT_MS` | `1500` | TypeSafe request timeout in milliseconds. A timeout restores all tools. |
| `PI_JEV_DEBUG` | unset | Set to `1` to display each routing decision and latency in Pi. |
| `PI_JEV_STUB` | unset | Set to `1` to use a deterministic offline router for tests and plumbing checks. |

Run `/jev-status` inside Pi to inspect the latest selected tool, confidence, readiness score, top candidates, token usage, latency, and action count.

## Offline smoke test

Stub mode verifies the Pi integration without a TypeSafe API call:

```sh
PI_JEV_ENABLED=1 PI_JEV_STUB=1 PI_JEV_DEBUG=1 \
  pi -e /absolute/path/to/pi-jev-agent
```

The stub walks unused tools in catalog order. It tests extension plumbing only and does not represent Jev's routing quality.

## Pi integration details

Pi 0.85.1 does not expose a first-class hook that dynamically supplies tools at the start of every model step. The extension uses two existing lifecycle hooks:

| Model step | Pi hook | Behavior |
| --- | --- | --- |
| First step after a user prompt | `before_agent_start` | Route before Pi snapshots the active tools. |
| Step after a tool result | `turn_end` | Route before Pi prepares the next model context and re-reads active tools. |

Tool names and arguments come from assistant `toolCall` blocks. Results are matched by `toolCallId` because Pi tool-result events do not contain the original arguments.

## Known limitations

- The extra Jev request adds latency to every model step.
- Routing quality depends on tool descriptions and the compact history supplied to Jev.
- If the main model writes text instead of calling its sole exposed tool, Pi can end the run without another routing step.
- `respond_to_user` uses an empty active-tool set and depends on Pi supporting a text-only step with no tools.
- TypeSafe Choice supports roughly 255 options. Larger tool catalogs need a prefilter.
- Tools unlocked by other extensions during an active run may not remain visible unless Jev selects them.

## Development

```sh
bun test
bun run check
bun test/smoke-load.ts
npm publish --dry-run
```

The smoke test uses `PI_JEV_STUB=1` and makes no paid API request.
