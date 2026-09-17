/** Pseudo-tool meaning "no tool: answer the user now". */
export const RESPOND = "respond_to_user";

export interface ToolSummary {
	name: string;
	description: string;
}

export interface RouterAction {
	step: number;
	tool: string;
	input: unknown;
	result: string;
}

export interface RouterState {
	user_request: string;
	actions_taken: RouterAction[];
	assistant_said: string[];
}

export interface RouterDecision {
	tool: string;
	confidence: number;
	/** Probability (0-1) the assistant is ready to answer now (work finished or no tool needed). */
	done: number;
	/** True when the gate overrode a premature respond_to_user. */
	gated: boolean;
	top: Array<{ name: string; p: number }>;
	latencyMs: number;
	usage: { input_tokens: number; output_tokens: number };
	state: RouterState;
}

interface ChoiceAnswer {
	type?: string;
	choice?: string;
	confidence?: number;
	probabilities?: Record<string, number>;
}

interface NoulAnswer {
	type?: string;
	noul?: number;
}

interface JevResponse {
	answers?: {
		next_tool?: ChoiceAnswer;
		done?: NoulAnswer;
	};
	usage?: { input_tokens?: number; output_tokens?: number };
}

const INSTRUCTIONS =
	"You are routing a coding agent. Given the user's request and the actions already taken (with their results), " +
	"which tool should the assistant call NEXT to make progress? Choose exactly one. " +
	"Follow the order implied by the request: inspect before editing, and honour conditions. " +
	"Never repeat an action that already succeeded. If everything requested is done, choose respond_to_user.";

/**
 * Pi-specific readiness noul (broader than the eve eval "all actions done" check).
 * Accepts respond_to_user when work is finished OR when no tool is needed at all.
 * Still false for unfinished tool work so the gate can block premature completion.
 */
export const DONE_INSTRUCTIONS =
	"True if the assistant should answer the user now without calling another tool: " +
	"either every tool action the user asked for already appears as a successful entry in actions_taken, " +
	"OR the request can be answered fully without any catalog tool (greeting, explanation, opinion, planning talk, clarification). " +
	"False if at least one requested tool action has not been carried out yet, or a needed lookup returned nothing useful and still requires a tool.";

const RESPOND_CRITERIA = {
	what: "No tool call is needed now: either every required tool action is already in actions_taken, or the request can be answered without any catalog tool. The assistant should write its final answer.",
	not_for: "Cases where a required tool step (a read, edit, search, build, or other tool use) still has not happened, or a prior lookup failed and another tool call is still needed.",
};

export function emptyState(userRequest = ""): RouterState {
	return {
		user_request: userRequest,
		actions_taken: [],
		assistant_said: [],
	};
}

export function clip(value: unknown, max = 600): string {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	if (!text) return "";
	return text.length > max ? `${text.slice(0, max)}...` : text;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const record = part as { type?: string; text?: string };
			return record.type === "text" && typeof record.text === "string" ? record.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

/**
 * Build compact router state from Pi agent messages (user / assistant / toolResult).
 * Tool result text is clipped so raw file bodies are not sent whole to TypeSafe.
 */
export function buildState(messages: readonly unknown[]): RouterState {
	const userTexts: string[] = [];
	const assistantSaid: string[] = [];
	const actions: RouterAction[] = [];
	const pending = new Map<string, { step: number; tool: string; input: unknown }>();
	let step = 0;

	for (const raw of messages) {
		if (!raw || typeof raw !== "object") continue;
		const message = raw as {
			role?: string;
			content?: unknown;
			toolCallId?: string;
			toolName?: string;
			isError?: boolean;
		};

		if (message.role === "user") {
			const text = textOf(message.content);
			if (text) userTexts.push(text);
			continue;
		}

		if (message.role === "assistant") {
			const text = textOf(message.content);
			if (text) assistantSaid.push(clip(text, 300));
			if (Array.isArray(message.content)) {
				for (const part of message.content) {
					if (!part || typeof part !== "object") continue;
					const call = part as {
						type?: string;
						id?: string;
						name?: string;
						arguments?: unknown;
						input?: unknown;
					};
					if (call.type !== "toolCall" && call.type !== "tool-call") continue;
					step += 1;
					const id = call.id ?? `${call.name ?? "tool"}-${step}`;
					pending.set(id, {
						step,
						tool: call.name ?? "unknown",
						input: call.arguments ?? call.input,
					});
				}
			}
			continue;
		}

		if (message.role === "toolResult" || message.role === "tool") {
			const id = message.toolCallId ?? `anon-${step + 1}`;
			const call = pending.get(id) ?? {
				step: ++step,
				tool: message.toolName ?? "unknown",
				input: undefined,
			};
			actions.push({
				...call,
				result: clip(textOf(message.content) || (message.isError ? "error" : "")),
			});
			pending.delete(id);
		}
	}

	return {
		user_request: userTexts.join("\n---\n"),
		actions_taken: actions,
		assistant_said: assistantSaid,
	};
}

function toolCallsFromAssistant(assistantMessage: unknown): Map<string, { tool: string; input: unknown }> {
	const pending = new Map<string, { tool: string; input: unknown }>();
	if (!assistantMessage || typeof assistantMessage !== "object") return pending;
	const content = (assistantMessage as { content?: unknown }).content;
	if (!Array.isArray(content)) return pending;
	let index = 0;
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const call = part as {
			type?: string;
			id?: string;
			name?: string;
			arguments?: unknown;
			input?: unknown;
		};
		if (call.type !== "toolCall" && call.type !== "tool-call") continue;
		index += 1;
		const id = call.id ?? `${call.name ?? "tool"}-${index}`;
		pending.set(id, {
			tool: call.name ?? "unknown",
			input: call.arguments ?? call.input,
		});
	}
	return pending;
}

/**
 * Append one Pi turn. Tool-call name/arguments come from the assistant message
 * (matched by toolCallId); Pi toolResults do not carry args.
 */
export function appendTurn(
	state: RouterState,
	assistantMessage: unknown,
	toolResults: readonly unknown[],
): RouterState {
	const next = {
		user_request: state.user_request,
		actions_taken: [...state.actions_taken],
		assistant_said: [...state.assistant_said],
	};

	if (assistantMessage && typeof assistantMessage === "object") {
		const text = textOf((assistantMessage as { content?: unknown }).content);
		if (text) next.assistant_said.push(clip(text, 300));
	}

	const pending = toolCallsFromAssistant(assistantMessage);
	let step = next.actions_taken.length;
	for (const raw of toolResults) {
		if (!raw || typeof raw !== "object") continue;
		const result = raw as {
			toolName?: string;
			toolCallId?: string;
			content?: unknown;
			isError?: boolean;
		};
		step += 1;
		const id = result.toolCallId ?? `anon-${step}`;
		const call = pending.get(id);
		next.actions_taken.push({
			step,
			tool: call?.tool ?? result.toolName ?? "unknown",
			input: call?.input,
			result: clip(textOf(result.content) || (result.isError ? "error" : "")),
		});
		pending.delete(id);
	}

	return next;
}

function criteriaFor(tools: ToolSummary[]): Record<string, string | { what: string; not_for: string }> {
	const criteria: Record<string, string | { what: string; not_for: string }> = {
		[RESPOND]: RESPOND_CRITERIA,
	};
	for (const tool of tools) {
		criteria[tool.name] = tool.description || tool.name;
	}
	return criteria;
}

/** Offline stand-in for smoke tests without a TypeSafe key or paid call. */
export function stubDecision(state: RouterState, tools: ToolSummary[]): RouterDecision {
	const used = new Set(state.actions_taken.map((action) => action.tool));
	const next = tools.find((tool) => !used.has(tool.name));
	const tool = next?.name ?? RESPOND;
	return {
		tool,
		confidence: 0.99,
		done: tool === RESPOND ? 1 : 0,
		gated: false,
		top: [{ name: tool, p: 0.99 }],
		latencyMs: 0,
		usage: { input_tokens: 0, output_tokens: 0 },
		state,
	};
}

export async function chooseNextTool(
	state: RouterState,
	tools: ToolSummary[],
	options: {
		apiKey: string;
		doneThreshold?: number;
		timeoutMs?: number;
		stub?: boolean;
		fetch?: typeof fetch;
	},
): Promise<RouterDecision> {
	if (options.stub || process.env.PI_JEV_STUB === "1") {
		return stubDecision(state, tools);
	}

	if (tools.length === 0) {
		return {
			tool: RESPOND,
			confidence: 1,
			done: 1,
			gated: false,
			top: [{ name: RESPOND, p: 1 }],
			latencyMs: 0,
			usage: { input_tokens: 0, output_tokens: 0 },
			state,
		};
	}

	const started = performance.now();
	const response = await (options.fetch ?? fetch)("https://api.typesafe.ai/v1/systemone", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${options.apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			state,
			model: "jev-latest",
			questions: {
				next_tool: {
					type: "choice",
					instructions: INSTRUCTIONS,
					criteria: criteriaFor(tools),
				},
				done: {
					type: "noul",
					instructions: DONE_INSTRUCTIONS,
				},
			},
		}),
		signal: AbortSignal.timeout(options.timeoutMs ?? 1_500),
	});

	if (!response.ok) {
		throw new Error(`TypeSafe returned HTTP ${response.status}`);
	}

	const body = (await response.json()) as JevResponse;
	const answer = body.answers?.next_tool;
	const done = typeof body.answers?.done?.noul === "number" ? body.answers.done.noul : 0;
	const probabilities = answer?.probabilities ?? {};
	const ranked = Object.entries(probabilities).sort((left, right) => right[1] - left[1]);
	const top = ranked.slice(0, 5).map(([name, p]) => ({
		name,
		p: Math.round(p * 1000) / 1000,
	}));

	let tool = answer?.choice ?? RESPOND;
	let gated = false;
	const doneThreshold = options.doneThreshold ?? 0.5;
	if (tool === RESPOND && done < doneThreshold) {
		const next = ranked.find(([name]) => name !== RESPOND);
		if (next) {
			tool = next[0];
			gated = true;
		}
	}

	// Ignore unknown choices from the model.
	const known = new Set(tools.map((item) => item.name));
	if (tool !== RESPOND && !known.has(tool)) {
		const next = ranked.find(([name]) => name !== RESPOND && known.has(name));
		tool = next?.[0] ?? RESPOND;
	}

	return {
		tool,
		confidence: typeof answer?.confidence === "number" ? answer.confidence : 0,
		done,
		gated,
		top: top.length > 0 ? top : [{ name: tool, p: 1 }],
		latencyMs: Math.round(performance.now() - started),
		usage: {
			input_tokens: body.usage?.input_tokens ?? 0,
			output_tokens: body.usage?.output_tokens ?? 0,
		},
		state,
	};
}
