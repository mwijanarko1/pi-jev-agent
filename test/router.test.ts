import { describe, expect, test } from "bun:test";
import {
	DONE_INSTRUCTIONS,
	RESPOND,
	appendTurn,
	buildState,
	chooseNextTool,
	emptyState,
	stubDecision,
} from "../extensions/router";

const tools = [
	{ name: "read", description: "Read a file" },
	{ name: "edit", description: "Edit a file" },
	{ name: "bash", description: "Run a shell command" },
	{ name: "android_tap", description: "Tap the screen" },
];

describe("buildState", () => {
	test("extracts user request, tool calls, and clipped results", () => {
		const state = buildState([
			{ role: "user", content: [{ type: "text", text: "fix package.json" }] },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Reading it." },
					{ type: "toolCall", id: "c1", name: "read", arguments: { path: "package.json" } },
				],
			},
			{
				role: "toolResult",
				toolCallId: "c1",
				toolName: "read",
				content: [{ type: "text", text: `{"name":"pi-jev"}${"x".repeat(700)}` }],
			},
		]);

		expect(state.user_request).toBe("fix package.json");
		expect(state.assistant_said[0]).toBe("Reading it.");
		expect(state.actions_taken).toHaveLength(1);
		expect(state.actions_taken[0]?.tool).toBe("read");
		expect(state.actions_taken[0]?.input).toEqual({ path: "package.json" });
		expect(state.actions_taken[0]?.result.length).toBeLessThanOrEqual(603);
		expect(state.actions_taken[0]?.result.endsWith("...")).toBe(true);
	});
});

describe("appendTurn", () => {
	test("matches toolCall arguments from the assistant message by id", () => {
		const state = appendTurn(
			emptyState("run tests"),
			{
				content: [
					{ type: "text", text: "Running." },
					{
						type: "toolCall",
						id: "t1",
						name: "bash",
						arguments: { command: "bun test" },
					},
				],
			},
			// Pi toolResults do not carry args; only toolCallId + result content.
			[
				{
					toolName: "bash",
					toolCallId: "t1",
					content: [{ type: "text", text: "ok" }],
				},
			],
		);

		expect(state.user_request).toBe("run tests");
		expect(state.assistant_said).toEqual(["Running."]);
		expect(state.actions_taken).toEqual([
			{
				step: 1,
				tool: "bash",
				input: { command: "bun test" },
				result: "ok",
			},
		]);
		expect(state.actions_taken[0]?.input).toEqual({ command: "bun test" });
	});

	test("keeps args when multiple toolCalls are matched by id", () => {
		const state = appendTurn(
			emptyState("read then edit"),
			{
				content: [
					{ type: "toolCall", id: "a", name: "read", arguments: { path: "a.ts" } },
					{ type: "toolCall", id: "b", name: "edit", arguments: { path: "b.ts", oldText: "x", newText: "y" } },
				],
			},
			[
				{ toolCallId: "b", toolName: "edit", content: [{ type: "text", text: "edited" }] },
				{ toolCallId: "a", toolName: "read", content: [{ type: "text", text: "src" }] },
			],
		);

		expect(state.actions_taken).toEqual([
			{
				step: 1,
				tool: "edit",
				input: { path: "b.ts", oldText: "x", newText: "y" },
				result: "edited",
			},
			{
				step: 2,
				tool: "read",
				input: { path: "a.ts" },
				result: "src",
			},
		]);
	});
});

describe("chooseNextTool", () => {
	test("selects the choice tool and reports done probability", async () => {
		const result = await chooseNextTool(emptyState("read the file"), tools, {
			apiKey: "test-key",
			fetch: async () =>
				new Response(
					JSON.stringify({
						answers: {
							next_tool: {
								type: "choice",
								choice: "read",
								confidence: 0.91,
								probabilities: {
									read: 0.7,
									edit: 0.1,
									bash: 0.05,
									android_tap: 0.05,
									[RESPOND]: 0.1,
								},
							},
							done: { type: "noul", noul: 0.12 },
						},
						usage: { input_tokens: 40, output_tokens: 8 },
					}),
					{ status: 200 },
				),
		});

		expect(result.tool).toBe("read");
		expect(result.confidence).toBe(0.91);
		expect(result.done).toBe(0.12);
		expect(result.gated).toBe(false);
		expect(result.top[0]?.name).toBe("read");
		expect(result.usage).toEqual({ input_tokens: 40, output_tokens: 8 });
	});

	test("gates premature respond_to_user when done is below threshold", async () => {
		const result = await chooseNextTool(emptyState("edit the file"), tools, {
			apiKey: "test-key",
			doneThreshold: 0.5,
			fetch: async () =>
				new Response(
					JSON.stringify({
						answers: {
							next_tool: {
								type: "choice",
								choice: RESPOND,
								confidence: 0.4,
								probabilities: {
									[RESPOND]: 0.45,
									edit: 0.4,
									read: 0.15,
								},
							},
							done: { type: "noul", noul: 0.2 },
						},
					}),
					{ status: 200 },
				),
		});

		expect(result.tool).toBe("edit");
		expect(result.gated).toBe(true);
		expect(result.done).toBe(0.2);
	});

	test("allows respond_to_user when done clears the gate after tools", async () => {
		const result = await chooseNextTool(
			{
				user_request: "edit the file",
				actions_taken: [{ step: 1, tool: "edit", input: {}, result: "ok" }],
				assistant_said: [],
			},
			tools,
			{
				apiKey: "test-key",
				doneThreshold: 0.5,
				fetch: async () =>
					new Response(
						JSON.stringify({
							answers: {
								next_tool: {
									type: "choice",
									choice: RESPOND,
									confidence: 0.9,
									probabilities: { [RESPOND]: 0.9, edit: 0.1 },
								},
								done: { type: "noul", noul: 0.88 },
							},
						}),
						{ status: 200 },
					),
			},
		);

		expect(result.tool).toBe(RESPOND);
		expect(result.gated).toBe(false);
	});

	test("allows respond_to_user for no-tool conversational requests when readiness is high", async () => {
		let body: { questions?: { done?: { instructions?: string } } } | undefined;
		const result = await chooseNextTool(emptyState("What is a monorepo?"), tools, {
			apiKey: "test-key",
			doneThreshold: 0.5,
			fetch: async (_url, init) => {
				body = JSON.parse(String(init?.body)) as typeof body;
				return new Response(
					JSON.stringify({
						answers: {
							next_tool: {
								type: "choice",
								choice: RESPOND,
								confidence: 0.93,
								probabilities: { [RESPOND]: 0.8, read: 0.1, bash: 0.1 },
							},
							// High readiness: answer without tools, even with empty actions_taken.
							done: { type: "noul", noul: 0.91 },
						},
					}),
					{ status: 200 },
				);
			},
		});

		expect(result.tool).toBe(RESPOND);
		expect(result.gated).toBe(false);
		expect(result.done).toBe(0.91);
		expect(body?.questions?.done?.instructions).toBe(DONE_INSTRUCTIONS);
		expect(DONE_INSTRUCTIONS).toContain("without any catalog tool");
		expect(DONE_INSTRUCTIONS).toContain("False if at least one requested tool action has not been carried out yet");
	});

	test("reports HTTP failures without exposing the response body", async () => {
		await expect(
			chooseNextTool(emptyState("x"), tools, {
				apiKey: "test-key",
				fetch: async () => new Response("secret", { status: 401 }),
			}),
		).rejects.toThrow("TypeSafe returned HTTP 401");
	});

	test("stub mode picks the first unused tool without calling fetch", async () => {
		const result = await chooseNextTool(
			{
				user_request: "do work",
				actions_taken: [{ step: 1, tool: "read", input: {}, result: "ok" }],
				assistant_said: [],
			},
			tools,
			{ apiKey: "", stub: true, fetch: async () => {
				throw new Error("fetch should not run");
			} },
		);

		expect(result.tool).toBe("edit");
		expect(result.latencyMs).toBe(0);
	});
});

describe("stubDecision", () => {
	test("returns respond_to_user when every tool was already used", () => {
		const decision = stubDecision(
			{
				user_request: "done",
				actions_taken: tools.map((tool, index) => ({
					step: index + 1,
					tool: tool.name,
					input: {},
					result: "ok",
				})),
				assistant_said: [],
			},
			tools,
		);
		expect(decision.tool).toBe(RESPOND);
		expect(decision.done).toBe(1);
	});
});
