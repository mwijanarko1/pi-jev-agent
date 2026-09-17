import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	RESPOND,
	appendTurn,
	chooseNextTool,
	emptyState,
	type RouterDecision,
	type RouterState,
	type ToolSummary,
} from "./router";

const LOADER_TOOL = "jev_search_tools";

function enabled(): boolean {
	return process.env.PI_JEV_ENABLED === "1";
}

function numberFromEnv(name: string, fallback: number): number {
	const value = Number(process.env[name]);
	return Number.isFinite(value) ? value : fallback;
}

function catalogTools(pi: ExtensionAPI): ToolSummary[] {
	return pi
		.getAllTools()
		.filter((tool) => tool.name !== LOADER_TOOL)
		.map(({ name, description }) => ({ name, description: description ?? name }));
}

export default function piJev(pi: ExtensionAPI) {
	if (!enabled()) return;

	const apiKey = process.env.TYPESAFE_API_KEY;
	const stub = process.env.PI_JEV_STUB === "1";
	if (!apiKey && !stub) {
		pi.on("session_start", (_event, ctx) => {
			ctx.ui.notify("pi-jev-agent: TYPESAFE_API_KEY is not set; tool routing is unchanged.", "warning");
		});
		return;
	}

	let tools: ToolSummary[] = [];
	let allToolNames: string[] = [];
	let state: RouterState = emptyState();
	let lastDecision: RouterDecision | undefined;
	let routing = false;

	const applyDecision = (decision: RouterDecision) => {
		lastDecision = decision;
		if (decision.tool === RESPOND) {
			// No tools: model writes the final answer for this step.
			pi.setActiveTools([]);
			return;
		}
		// Exactly one next tool for this step.
		pi.setActiveTools([decision.tool]);
	};

	const failOpen = (error: unknown, ctx: ExtensionContext) => {
		lastDecision = undefined;
		// Recovery: restore the full catalog plus the re-route loader.
		pi.setActiveTools([...allToolNames, LOADER_TOOL]);
		ctx.ui.notify(
			`pi-jev-agent failed open: ${error instanceof Error ? error.message : String(error)}`,
			"warning",
		);
	};

	const route = async (ctx: ExtensionContext): Promise<RouterDecision | undefined> => {
		if (routing) return lastDecision;
		routing = true;
		try {
			const decision = await chooseNextTool(state, tools, {
				apiKey: apiKey ?? "",
				stub,
				doneThreshold: numberFromEnv("PI_JEV_DONE_THRESHOLD", 0.5),
				timeoutMs: numberFromEnv("PI_JEV_TIMEOUT_MS", 1_500),
			});
			applyDecision(decision);
			if (process.env.PI_JEV_DEBUG === "1") {
				const gate = decision.gated ? " gated" : "";
				ctx.ui.notify(
					`pi-jev-agent: ${decision.tool} conf=${decision.confidence.toFixed(2)} done=${decision.done.toFixed(2)}${gate} (${decision.latencyMs}ms)`,
					"info",
				);
			}
			return decision;
		} catch (error) {
			failOpen(error, ctx);
			return undefined;
		} finally {
			routing = false;
		}
	};

	pi.registerTool({
		name: LOADER_TOOL,
		label: "Search tools with Jev",
		description:
			"Re-run step-level Jev routing when the currently exposed tool cannot finish the request.",
		parameters: Type.Object({
			query: Type.String({ description: "What capability is still needed" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.query.trim()) {
				state = {
					...state,
					user_request: `${state.user_request}\n[re-route] ${params.query.trim()}`,
				};
			}
			const decision = await route(ctx);
			return {
				content: [
					{
						type: "text",
						text:
							decision?.tool === RESPOND
								? "Jev says respond to the user; no tool exposed."
								: decision
									? `Next tool: ${decision.tool}`
									: "Routing failed open; all tools restored.",
					},
				],
				details: {
					tool: decision?.tool,
					confidence: decision?.confidence,
					done: decision?.done,
					gated: decision?.gated,
					top: decision?.top,
					usage: decision?.usage,
					latencyMs: decision?.latencyMs,
				},
			};
		},
	});

	pi.on("session_start", () => {
		tools = catalogTools(pi);
		allToolNames = tools.map((tool) => tool.name);
		state = emptyState();
		lastDecision = undefined;
		// Start with only the recovery loader until the first route.
		pi.setActiveTools([LOADER_TOOL]);
	});

	/*
	 * First model step of a run: before_agent_start runs before Agent.createContextSnapshot(),
	 * so setActiveTools here is visible to the first LLM call.
	 *
	 * Later steps: turn_start is too late (tools already snapshotted into the turn context).
	 * turn_end + prepareNextTurnWithContext re-reads agent.state.tools, so route on turn_end
	 * when the turn produced tool results (another model step will follow).
	 */
	pi.on("before_agent_start", async (event, ctx) => {
		if (!event.prompt.trim()) return;
		state = emptyState(event.prompt.trim());
		await route(ctx);
	});

	pi.on("turn_end", async (event, ctx) => {
		state = appendTurn(state, event.message, event.toolResults ?? []);
		if ((event.toolResults?.length ?? 0) === 0) return;
		await route(ctx);
	});

	pi.on("agent_end", () => {
		// Leave lastDecision for /jev-status; clear only the in-flight request state on next start.
		pi.setActiveTools([LOADER_TOOL]);
	});

	pi.registerCommand("jev-status", {
		description: "Show the latest pi-jev-agent step routing decision",
		handler: async (_args, ctx) => {
			if (!lastDecision) {
				ctx.ui.notify(`pi-jev-agent: ready, ${tools.length} catalog tools`, "info");
				return;
			}
			const top = lastDecision.top
				.slice(0, 3)
				.map(({ name, p }) => `${name}:${p.toFixed(2)}`)
				.join(", ");
			ctx.ui.notify(
				`pi-jev-agent: ${lastDecision.tool}; conf ${lastDecision.confidence.toFixed(2)}; done ${lastDecision.done.toFixed(2)}; gated ${lastDecision.gated}; top ${top}; ${lastDecision.usage.input_tokens}/${lastDecision.usage.output_tokens} tok; ${lastDecision.latencyMs}ms; actions ${lastDecision.state.actions_taken.length}`,
				"info",
			);
		},
	});
}
