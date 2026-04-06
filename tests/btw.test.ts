import test from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Test helpers — minimal mocks of pi-ai and pi-coding-agent types
// ---------------------------------------------------------------------------

const CUSTOM_MESSAGE_TYPE = "btw-note";

type MockAgentMessage = {
	role?: string;
	content?: unknown;
	customType?: string;
	[key: string]: unknown;
};

function makeMessage(role: string, content: string, customType?: string): MockAgentMessage {
	const msg: MockAgentMessage = { role, content };
	if (customType !== undefined) msg.customType = customType;
	return msg;
}

// ---------------------------------------------------------------------------
// stripInProgressMessage — remove in-progress (stopReason === null) messages
// ---------------------------------------------------------------------------

function stripInProgressMessage(messages: MockAgentMessage[]): MockAgentMessage[] {
	const last = messages.at(-1);
	if (last && last.role === "assistant" && (last as { stopReason?: string }).stopReason === null) {
		return messages.slice(0, -1);
	}
	return messages;
}

test("stripInProgressMessage removes the last assistant message when stopReason is null", () => {
	const messages = [
		makeMessage("user", "hello"),
		{ role: "assistant", content: "thinking", stopReason: null } as MockAgentMessage,
	];

	const filtered = stripInProgressMessage(messages);

	assert.equal(filtered.length, 1);
	assert.equal(filtered[0].role, "user");
});

test("stripInProgressMessage keeps the last message when stopReason is set", () => {
	const messages = [
		makeMessage("user", "hello"),
		{ role: "assistant", content: "done", stopReason: "stop" } as MockAgentMessage,
	];

	const filtered = stripInProgressMessage(messages);

	assert.equal(filtered.length, 2);
});

test("stripInProgressMessage keeps the last message when it's not an assistant", () => {
	const messages = [
		makeMessage("user", "hello"),
		makeMessage("assistant", "hi"),
		makeMessage("user", "another"),
	];

	const filtered = stripInProgressMessage(messages);

	assert.equal(filtered.length, 3);
});

test("stripInProgressMessage handles empty input", () => {
	const filtered = stripInProgressMessage([]);
	assert.deepEqual(filtered, []);
});

// ---------------------------------------------------------------------------
// extractBtwAnswer — robust response extraction
// ---------------------------------------------------------------------------

type MockContentBlock =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string }
	| { type: "toolCall"; name: string; id: string; arguments: Record<string, unknown> };

function makeAssistantMessage(content: MockContentBlock[], stopReason: string = "stop"): { role: string; content: MockContentBlock[]; stopReason: string } {
	return { role: "assistant", content, stopReason };
}

function extractBtwAnswer(message: { content: MockContentBlock[] }): { answer: string | null; errorHint?: string } {
	const textBlocks = message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n\n")
		.trim();

	if (textBlocks) return { answer: textBlocks };

	const toolCall = message.content.find((block) => block.type === "toolCall");
	if (toolCall) {
		return { answer: null, errorHint: `Model tried to call \`${(toolCall as { name: string }).name}\` (side questions have no tools). Try rephrasing or ask in the main conversation.` };
	}

	const hasThinking = message.content.some((b) => b.type === "thinking");
	if (hasThinking) {
		return { answer: null, errorHint: "Model returned thinking content but no text answer. Try a simpler question or disable thinking." };
	}

	return { answer: null };
}

test("extractBtwAnswer returns text from a normal text block", () => {
	const msg = makeAssistantMessage([{ type: "text", text: "The answer is 42" }]);
	const result = extractBtwAnswer(msg);
	assert.equal(result.answer, "The answer is 42");
	assert.equal(result.errorHint, undefined);
});

test("extractBtwAnswer joins multiple text blocks with double newlines", () => {
	const msg = makeAssistantMessage([
		{ type: "text", text: "First paragraph" },
		{ type: "text", text: "Second paragraph" },
	]);
	const result = extractBtwAnswer(msg);
	assert.equal(result.answer, "First paragraph\n\nSecond paragraph");
});

test("extractBtwAnswer ignores thinking blocks when text is present", () => {
	const msg = makeAssistantMessage([
		{ type: "thinking", thinking: "hmm..." },
		{ type: "text", text: "The answer" },
	]);
	const result = extractBtwAnswer(msg);
	assert.equal(result.answer, "The answer");
});

test("extractBtwAnswer detects tool call when no text is present", () => {
	const msg = makeAssistantMessage([
		{ type: "thinking", thinking: "I should check" },
		{ type: "toolCall", name: "read_file", id: "1", arguments: {} },
	]);
	const result = extractBtwAnswer(msg);
	assert.equal(result.answer, null);
	assert.ok(result.errorHint?.includes("read_file"));
});

test("extractBtwAnswer detects thinking-only with no text", () => {
	const msg = makeAssistantMessage([
		{ type: "thinking", thinking: "let me think about this..." },
	]);
	const result = extractBtwAnswer(msg);
	assert.equal(result.answer, null);
	assert.ok(result.errorHint?.includes("thinking content"));
});

test("extractBtwAnswer returns null for empty content", () => {
	const msg = makeAssistantMessage([]);
	const result = extractBtwAnswer(msg);
	assert.equal(result.answer, null);
	assert.equal(result.errorHint, undefined);
});

// ---------------------------------------------------------------------------
// excludeBtwMessages — pure function, easy to test
// ---------------------------------------------------------------------------

function excludeBtwMessages(messages: MockAgentMessage[]): MockAgentMessage[] {
	return messages.filter((message) => message.customType !== CUSTOM_MESSAGE_TYPE);
}

test("excludeBtwMessages removes messages with customType 'btw-note'", () => {
	const messages = [
		makeMessage("user", "hello"),
		makeMessage("assistant", "hi there"),
		makeMessage("user", "btw question", CUSTOM_MESSAGE_TYPE),
		makeMessage("assistant", "btw answer", CUSTOM_MESSAGE_TYPE),
		makeMessage("user", "back to main task"),
	];

	const filtered = excludeBtwMessages(messages);

	assert.equal(filtered.length, 3);
	assert.deepEqual(filtered, [
		makeMessage("user", "hello"),
		makeMessage("assistant", "hi there"),
		makeMessage("user", "back to main task"),
	]);
});

test("excludeBtwMessages returns all messages when none are btw-notes", () => {
	const messages = [
		makeMessage("user", "fix this bug"),
		makeMessage("assistant", "sure"),
	];

	const filtered = excludeBtwMessages(messages);

	assert.equal(filtered.length, 2);
	assert.deepEqual(filtered, messages);
});

test("excludeBtwMessages handles empty input", () => {
	const filtered = excludeBtwMessages([]);
	assert.deepEqual(filtered, []);
});

test("excludeBtwMessages removes all btw-notes even when mixed in between", () => {
	const messages = [
		makeMessage("user", "step 1"),
		makeMessage("assistant", "done", CUSTOM_MESSAGE_TYPE),
		makeMessage("user", "step 2"),
		makeMessage("assistant", "done", CUSTOM_MESSAGE_TYPE),
		makeMessage("user", "step 3"),
	];

	const filtered = excludeBtwMessages(messages);

	assert.equal(filtered.length, 3);
	assert.equal(filtered[0].role, "user");
	assert.equal(filtered[0].content, "step 1");
	assert.equal(filtered[1].role, "user");
	assert.equal(filtered[1].content, "step 2");
	assert.equal(filtered[2].role, "user");
	assert.equal(filtered[2].content, "step 3");
});

// ---------------------------------------------------------------------------
// registerCommand — validate argument parsing and guard clauses
// ---------------------------------------------------------------------------

type MockExtensionAPI = {
	registeredCommands: Map<string, { description?: string; handler: (args: string, ctx: MockCommandContext) => Promise<void> }>;
	contextFilters: Array<(event: { messages: MockAgentMessage[] }) => Promise<{ messages: MockAgentMessage[] } | void>>;
	registerCommand: (name: string, options: { description?: string; handler: (args: string, ctx: MockCommandContext) => Promise<void> }) => void;
	on: (event: string, handler: (event: { messages: MockAgentMessage[] }) => Promise<{ messages: MockAgentMessage[] } | void>) => void;
	getThinkingLevel: () => string;
};

type MockCommandContext = {
	ui: {
		notify: (message: string, type?: string) => void;
	};
	model: { provider: string; id: string } | undefined;
	isIdle: () => boolean;
	hasUI: boolean;
	modelRegistry: {
		getApiKeyAndHeaders: (model: unknown) => Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string>; error?: string }>;
	};
};

async function loadExtension(): Promise<MockExtensionAPI> {
	const api: MockExtensionAPI = {
		registeredCommands: new Map(),
		contextFilters: [],
		registerCommand(name, options) {
			api.registeredCommands.set(name, options);
		},
		on(event, handler) {
			if (event === "context") {
				api.contextFilters.push(handler);
			}
		},
		getThinkingLevel: () => "off",
	};

	const mod = await import("../index.ts");
	const factory = mod.default as (pi: MockExtensionAPI) => void;
	factory(api);
	return api;
}

test("registers the /btw command with a description", async () => {
	const api = await loadExtension();
	const cmd = api.registeredCommands.get("btw");
	assert.ok(cmd, "btw command should be registered");
	assert.ok(cmd.description?.includes("side question"), "description should mention side question");
});

test("registers a context event handler that filters btw-notes", async () => {
	const api = await loadExtension();
	assert.ok(api.contextFilters.length > 0, "context handler should be registered");
});

test("btw handler notifies when question is empty", async () => {
	const api = await loadExtension();
	const cmd = api.registeredCommands.get("btw")!;
	const notifications: Array<{ message: string; type?: string }> = [];

	const ctx: MockCommandContext = {
		ui: { notify: (message, type) => notifications.push({ message, type }) },
		model: undefined,
		isIdle: () => true,
		hasUI: false,
		modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false, error: "test" }) },
	};

	await cmd.handler("", ctx);

	assert.equal(notifications.length, 1);
	assert.ok(notifications[0].message.includes("Usage"));
	assert.equal(notifications[0].type, "warning");
});

test("btw handler notifies when no model is selected", async () => {
	const api = await loadExtension();
	const cmd = api.registeredCommands.get("btw")!;
	const notifications: Array<{ message: string; type?: string }> = [];

	const ctx: MockCommandContext = {
		ui: { notify: (message, type) => notifications.push({ message, type }) },
		model: undefined,
		isIdle: () => true,
		hasUI: false,
		modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false, error: "test" }) },
	};

	await cmd.handler("what is this?", ctx);

	assert.equal(notifications.length, 1);
	assert.ok(notifications[0].message.includes("No active model"));
});

test("btw handler notifies when API key is unavailable", async () => {
	const api = await loadExtension();
	const cmd = api.registeredCommands.get("btw")!;
	const notifications: Array<{ message: string; type?: string }> = [];

	const ctx: MockCommandContext = {
		ui: { notify: (message, type) => notifications.push({ message, type }) },
		model: { provider: "test", id: "test-model" },
		isIdle: () => true,
		hasUI: false,
		modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false, error: "no key" }) },
	};

	await cmd.handler("what is this?", ctx);

	assert.equal(notifications.length, 1);
	assert.ok(notifications[0].message.includes("No API key"));
});

// ---------------------------------------------------------------------------
// Context filter — verify btw-notes are excluded from agent context
// ---------------------------------------------------------------------------

test("context handler removes btw-note messages from the event", async () => {
	const api = await loadExtension();
	const handler = api.contextFilters[0];
	assert.ok(handler, "context handler should exist");

	const event = {
		messages: [
			makeMessage("user", "fix the bug"),
			makeMessage("assistant", "on it"),
			makeMessage("user", "btw question?", CUSTOM_MESSAGE_TYPE),
			makeMessage("assistant", "btw answer", CUSTOM_MESSAGE_TYPE),
			makeMessage("user", "continue"),
		] as MockAgentMessage[],
	};

	const result = await handler(event);

	assert.ok(result, "handler should return a result");
	assert.equal(result!.messages.length, 3);
	assert.ok(result!.messages.every((m) => m.customType !== CUSTOM_MESSAGE_TYPE));
});

test("context handler passes through when no btw-notes exist", async () => {
	const api = await loadExtension();
	const handler = api.contextFilters[0];

	const event = {
		messages: [
			makeMessage("user", "hello"),
			makeMessage("assistant", "hi"),
		] as MockAgentMessage[],
	};

	const result = await handler(event);

	assert.ok(result, "handler should return a result");
	assert.equal(result!.messages.length, 2);
});
