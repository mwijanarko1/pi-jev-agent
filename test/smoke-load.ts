import { pathToFileURL } from "node:url";

process.env.PI_JEV_ENABLED = "1";
process.env.PI_JEV_STUB = "1";
delete process.env.TYPESAFE_API_KEY;

const mod = await import(pathToFileURL(new URL("../extensions/index.ts", import.meta.url).pathname).href);
const factory = mod.default as (pi: unknown) => void;

const events = new Map<string, Function>();
const tools = new Map<string, unknown>();
const commands = new Map<string, unknown>();
let active: string[] = ["read", "bash", "edit"];
const all = [
	{ name: "read", description: "Read a file" },
	{ name: "bash", description: "Shell" },
	{ name: "edit", description: "Edit" },
];

const pi = {
	on(event: string, handler: Function) {
		events.set(event, handler);
	},
	registerTool(def: { name: string }) {
		tools.set(def.name, def);
	},
	registerCommand(name: string, def: unknown) {
		commands.set(name, def);
	},
	getAllTools() {
		return all;
	},
	getActiveTools() {
		return active.slice();
	},
	setActiveTools(names: string[]) {
		active = names.slice();
	},
};

factory(pi);

if (![...events.keys()].includes("before_agent_start") || ![...events.keys()].includes("turn_end")) {
	throw new Error("missing required hooks");
}
if (!tools.has("jev_search_tools")) throw new Error("missing recovery tool");
if (!commands.has("jev-status")) throw new Error("missing status command");

const ctx = { ui: { notify() {} } };
await events.get("session_start")!({}, ctx);
if (JSON.stringify(active) !== JSON.stringify(["jev_search_tools"])) {
	throw new Error(`session_start tools: ${active}`);
}

await events.get("before_agent_start")!(
	{ prompt: "read package.json", images: undefined, systemPrompt: "", systemPromptOptions: {} },
	ctx,
);
if (JSON.stringify(active) !== JSON.stringify(["read"])) {
	throw new Error(`first step tools: ${active}`);
}

await events.get("turn_end")!(
	{
		turnIndex: 0,
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "ok" },
				{ type: "toolCall", id: "1", name: "read", arguments: { path: "package.json" } },
			],
		},
		toolResults: [{ toolName: "read", toolCallId: "1", content: [{ type: "text", text: "{}" }] }],
	},
	ctx,
);
if (JSON.stringify(active) !== JSON.stringify(["bash"])) {
	throw new Error(`second step tools: ${active}`);
}

await events.get("turn_end")!(
	{
		turnIndex: 1,
		message: { role: "assistant", content: [{ type: "text", text: "done" }] },
		toolResults: [],
	},
	ctx,
);
if (JSON.stringify(active) !== JSON.stringify(["bash"])) {
	throw new Error(`no-tool-result turn should not re-route: ${active}`);
}

console.log("SMOKE_OK");
