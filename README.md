# pi-jev-agent

Step-level [Jev](https://docs.typesafe.ai) tool routing for [Pi](https://pi.dev).

Before every model step, Jev looks at a compact conversation state and chooses exactly one next tool (or `respond_to_user`). Only that tool is exposed to the main model for the step. The model fills arguments; it does not pick among a large tool list.

## How it works

```
user prompt
  -> before_agent_start: Jev chooses tool T0; setActiveTools([T0])
  -> model step 0 (sees only T0)
  -> tools run
  -> turn_end: append results; Jev chooses T1; setActiveTools([T1])
  -> model step 1 (sees only T1)
  -> ...
  -> Jev chooses respond_to_user; setActiveTools([])
  -> model writes the final answer
```

Pi 0.85.1 has no eve-style `step.started` hook. The equivalent is:

| Step | Hook | Why |
| --- | --- | --- |
| First model call of a run | `before_agent_start` | Runs before `Agent.createContextSnapshot()`, so `setActiveTools` is visible to the first LLM call. |
| Later model calls | `turn_end` (when the turn produced tool results) | `turn_start` is too late: tools are already snapshotted into the turn context. After `turn_end`, Pi's `prepareNextTurnWithContext` re-reads `agent.state.tools` for the next step. |

Each Jev call asks two questions on the same state (`user_request`, `actions_taken[]`, `assistant_said[]`):

- `next_tool`: a Choice over every registered tool plus `respond_to_user`
- `done`: a Noul readiness check (Pi-specific; see below)

If Jev picks `respond_to_user` while `done` is below `PI_JEV_DONE_THRESHOLD` (default `0.5`), the router blocks the reply and exposes the next-best real tool instead (confidence-gated routing).

### Pi readiness adaptation

The eve eval agent treats `done` as "every requested tool action is already in `actions_taken`". That is too narrow for a general Pi coding session: greetings, explanations, and other no-tool turns would score low and the gate would force a random catalog tool.

pi-jev-agent's readiness noul is true when **either**:

- every required tool action already appears in `actions_taken`, **or**
- the request can be answered fully without any catalog tool

It stays false when a required tool step is still missing, so premature `respond_to_user` after unfinished work is still gated.

Turn state is built with `appendTurn`: tool **name** and **arguments** come from the assistant message `toolCall` blocks, matched to Pi `toolResults` by `toolCallId` (Pi results do not carry args).

## Privacy

Routing is opt-in (`PI_JEV_ENABLED=1`) because it sends router state to TypeSafe: the user prompt, short assistant snippets, tool names, and clipped tool-result text (default 600 characters). It does not send credentials, API keys, or full unclipped file bodies. Tool results can still contain sensitive substrings if a prior tool returned them; keep that in mind before enabling.

## Requirements

- Pi 0.85.1 or newer
- Node.js 20 or newer
- A TypeSafe API key (unless `PI_JEV_STUB=1`)

## Try locally

```sh
export TYPESAFE_API_KEY="..."
export PI_JEV_ENABLED=1
pi -e /absolute/path/to/pi-jev-agent
```

No-paid-call plumbing check:

```sh
PI_JEV_ENABLED=1 PI_JEV_STUB=1 PI_JEV_DEBUG=1 pi -e /absolute/path/to/pi-jev-agent
```

If routing fails (timeout, HTTP error, missing key without stub), every catalog tool plus `jev_search_tools` is restored so the agent can continue (fail-open). The recovery tool can re-run routing after a fail-open.

## Install

```sh
pi install /absolute/path/to/pi-jev-agent
```

Restart Pi after installation. Do not install globally from this workspace unless you intend to.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_JEV_ENABLED` | unset | Set to `1` to enable routing and external state processing. |
| `PI_JEV_DONE_THRESHOLD` | `0.5` | Minimum done-noul required to accept `respond_to_user`. |
| `PI_JEV_TIMEOUT_MS` | `1500` | API timeout. A timeout restores all tools. |
| `PI_JEV_DEBUG` | unset | Set to `1` to show each step decision in the Pi UI. |
| `PI_JEV_STUB` | unset | Set to `1` to skip TypeSafe and walk unused tools in catalog order (tests / smoke). |
| `TYPESAFE_API_KEY` | unset | Bearer token for `https://api.typesafe.ai/v1/systemone`. |

Run `/jev-status` for the latest tool, confidence, done score, gate flag, top-3, tokens, and latency.

## Residual Pi API limits

- No first-class per-step tool factory like eve's `defineDynamic({ events: { "step.started" } })`.
- `setActiveTools` during `turn_start` or `context` does not change tools for the in-flight step; the turn context already holds a tools snapshot.
- Empty `setActiveTools([])` for `respond_to_user` relies on Pi accepting a zero-tool active set for a final text-only step.
- If the main model emits text instead of calling the sole exposed tool, Pi ends the run: `turn_end` has no tool results, so pi-jev-agent does not re-route for another step. Recovery then depends on a new user prompt (or fail-open / `/jev-status` inspection).
- Choice is capped by TypeSafe (~255 options). Very large extension catalogs may need a prefilter later.

## Development

```sh
bun test
bun run check
npm pack --dry-run
```
