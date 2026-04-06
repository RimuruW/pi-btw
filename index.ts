import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
	streamSimple,
	type AssistantMessage,
	type Context,
	type Message,
} from "@mariozechner/pi-ai";
import {
	convertToLlm,
	getMarkdownTheme,
	DynamicBorder,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type Theme,
} from "@mariozechner/pi-coding-agent";
import { Container, Loader, Markdown, Spacer, Text, type TUI } from "@mariozechner/pi-tui";

// ---------------------------------------------------------------------------
// Command constants
// ---------------------------------------------------------------------------

const COMMAND_NAME = "btw";
const CUSTOM_MESSAGE_TYPE = "btw-note";

// ---------------------------------------------------------------------------
// System prompt — constrains the model to answer without tools / actions
// ---------------------------------------------------------------------------

function buildSystemPrompt(): string {
	return `<system-reminder>This is a side question from the user. You must answer this question directly in a single response.

IMPORTANT CONTEXT:
- You are a separate, lightweight agent spawned to answer this one question
- The main agent is NOT interrupted — it continues working independently in the background
- You share the conversation context but are a completely separate instance
- Do NOT reference being interrupted or what you were "previously doing" — that framing is incorrect

CRITICAL CONSTRAINTS:
- You have NO tools available — you cannot read files, run commands, search, or take any actions
- This is a one-off response — there will be no follow-up turns
- You can ONLY provide information based on what you already know from the conversation context
- NEVER say things like "Let me try…", "I'll now…", "Let me check…", or promise to take any action
- If you don't know the answer, say so — do not offer to look it up or investigate

Simply answer the question with the information you have.</system-reminder>`;
}

// ---------------------------------------------------------------------------
// Context helpers
// ---------------------------------------------------------------------------

/** Remove an in-progress assistant message (stopReason === null) so the fork
 *  doesn't see a truncated / partial response. */
function stripInProgressMessage(messages: AgentMessage[]): AgentMessage[] {
	const last = messages.at(-1);
	if (last && last.role === "assistant" && (last as AgentMessage & { stopReason?: string }).stopReason === null) {
		return messages.slice(0, -1);
	}
	return messages;
}

function getSessionMessages(ctx: ExtensionCommandContext): AgentMessage[] {
	const sessionManager = ctx.sessionManager as {
		buildSessionContext?: () => { messages: AgentMessage[] };
		getBranch: () => Array<{ type: string; message?: AgentMessage }>;
	};

	if (typeof sessionManager.buildSessionContext === "function") {
		return sessionManager.buildSessionContext().messages;
	}

	return sessionManager
		.getBranch()
		.filter((entry): entry is { type: "message"; message: AgentMessage } => entry.type === "message")
		.map((entry) => entry.message);
}

function excludeBtwMessages(messages: AgentMessage[]): AgentMessage[] {
	return messages.filter(
		(message) => (message as AgentMessage & { customType?: string }).customType !== CUSTOM_MESSAGE_TYPE,
	);
}

// ---------------------------------------------------------------------------
// Response extraction — handles thinking blocks, tool calls, and errors
// ---------------------------------------------------------------------------

function extractBtwAnswer(message: AssistantMessage): { answer: string | null; errorHint?: string } {
	const textBlocks = message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n\n")
		.trim();

	if (textBlocks) return { answer: textBlocks };

	// Model tried to call a tool despite instructions.
	const toolCall = message.content.find((block) => block.type === "toolCall");
	if (toolCall) {
		const name = (toolCall as { name: string }).name;
		return {
			answer: null,
			errorHint: `Model tried to call \`${name}\` (side questions have no tools). Try rephrasing or ask in the main conversation.`,
		};
	}

	// Only thinking content — no text answer.
	const hasThinking = message.content.some((b) => b.type === "thinking");
	if (hasThinking) {
		return {
			answer: null,
			errorHint: "Model returned thinking content but no text answer. Try a simpler question or disable thinking.",
		};
	}

	return { answer: null };
}

// ---------------------------------------------------------------------------
// Streaming LLM call
// ---------------------------------------------------------------------------

async function streamBtwQuestion(options: {
	model: NonNullable<ExtensionCommandContext["model"]>;
	apiKey: string;
	headers?: Record<string, string>;
	thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>;
	messages: AgentMessage[];
	question: string;
	signal?: AbortSignal;
	onTextDelta?: (text: string) => void;
}): Promise<{ answer: string | null; errorHint?: string }> {
	const { model, apiKey, headers, thinkingLevel, messages, question, signal, onTextDelta } = options;
	const llmMessages = convertToLlm(messages)
		// streamSimple has no tools — strip tool calls / results so the provider
		// doesn't send an empty `tools: []` array that some APIs reject (400).
		.map((m) => {
			if (m.role === "assistant") {
				const content = m.content.filter((b) => b.type !== "toolCall");
				if (content.length === 0) return null;
				return { ...m, content };
			}
			if ((m as { role: string }).role === "toolResult") return null;
			return m;
		})
		.filter((m): m is NonNullable<typeof m> => m !== null);
	const questionMessage: Message = {
		role: "user",
		content: [{ type: "text", text: question }],
		timestamp: Date.now(),
	};

	const context: Context = {
		systemPrompt: buildSystemPrompt(),
		messages: [...llmMessages, questionMessage],
	};

	const stream = streamSimple(model, context, {
		apiKey,
		headers,
		reasoning: thinkingLevel === "off" ? undefined : thinkingLevel,
		cacheRetention: "short",
		signal,
	});

	let finalMessage: AssistantMessage | undefined;

	for await (const event of stream) {
		if (event.type === "text_delta" && onTextDelta) {
			onTextDelta(event.delta);
			continue;
		}

		if (event.type === "done") {
			finalMessage = event.message;
			continue;
		}

		if (event.type === "error") {
			if (event.reason === "aborted" || signal?.aborted) {
				throw new Error("aborted");
			}
			throw new Error(event.error.errorMessage || "BTW request failed");
		}
	}

	if (!finalMessage) {
		if (signal?.aborted) throw new Error("aborted");
		throw new Error("BTW request ended without a final message");
	}

	return extractBtwAnswer(finalMessage);
}

// ---------------------------------------------------------------------------
// Streaming UI component
// ---------------------------------------------------------------------------

/** Shows a bordered spinner → streams Markdown inside the same border. */
class StreamingBtwView extends Container {
	private tui: TUI;
	private theme: Theme;
	private loader: Loader;
	private mdComponent?: Markdown;
	private errorText?: Text;
	private settled = false;
	private fullText = "";
	onAbort?: () => void;

	constructor(tui: TUI, theme: Theme, modelId: string, thinkingLevel: string) {
		super();
		this.tui = tui;
		this.theme = theme;
		const borderColor = (s: string) => theme.fg("border", s);
		this.addChild(new DynamicBorder(borderColor));
		this.loader = new Loader(tui, (s) => theme.fg("accent", s), (s) => theme.fg("muted", s), `BTW: ${modelId} (${thinkingLevel})`);
		this.addChild(this.loader);
		this.addChild(new DynamicBorder(borderColor));
	}

	/** Accumulate a streaming text delta and trigger re-render. */
	onTextDelta(delta: string): void {
		this.fullText += delta;
		this.loader.stop();
		this.children = [];
		const borderColor = (s: string) => this.theme.fg("border", s);
		this.addChild(new DynamicBorder(borderColor));
		this.addChild(new Spacer(1));
		this.mdComponent = new Markdown(this.fullText, 0, 0, getMarkdownTheme());
		this.addChild(this.mdComponent);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder(borderColor));
		this.tui.render();
	}

	/** Finalize — ensure Markdown is rendered even if no text arrived yet. */
	markComplete(): void {
		if (this.settled) return;
		this.settled = true;
		if (!this.fullText) return;
		this.loader.stop();
		this.children = [];
		const borderColor = (s: string) => this.theme.fg("border", s);
		this.addChild(new DynamicBorder(borderColor));
		this.addChild(new Spacer(1));
		this.mdComponent = new Markdown(this.fullText, 0, 0, getMarkdownTheme());
		this.addChild(this.mdComponent);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder(borderColor));
		this.tui.render();
	}

	/** Show an error message in place of the answer. */
	showError(message: string): void {
		if (this.settled) return;
		this.settled = true;
		this.loader.stop();
		this.children = [];
		const borderColor = (s: string) => this.theme.fg("border", s);
		this.addChild(new DynamicBorder(borderColor));
		this.addChild(new Spacer(1));
		this.errorText = new Text(this.theme.fg("error", `✗ ${message}`), 0, 0);
		this.addChild(this.errorText);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder(borderColor));
		this.tui.render();
	}

	/** Dismiss on Escape, Enter, Space, Ctrl+C, Ctrl+D. */
	handleInput(data: string): void {
		const isCtrl = data.length === 1 && data.charCodeAt(0) <= 0x1f;
		if (data === "\x1b" || data === "\r" || data === " " || (isCtrl && (data === "\x03" || data === "\x04"))) {
			this.onAbort?.();
		}
	}

	dispose(): void {
		this.loader.stop();
	}

	render(width: number): string[] {
		const lines: string[] = [];
		for (const child of this.children) {
			lines.push(...child.render(width));
		}
		return lines;
	}
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function btwExtension(pi: ExtensionAPI) {
	pi.on("context", async (event) => {
		return {
			messages: event.messages.filter(
				(message) => (message as AgentMessage & { customType?: string }).customType !== CUSTOM_MESSAGE_TYPE,
			),
		};
	});

	pi.registerCommand(COMMAND_NAME, {
		description: "Ask a one-off side question and save the answer outside future agent context",
		handler: async (args, ctx) => {
			const question = args.trim();
			if (!question) {
				ctx.ui.notify("Usage: /btw <question>", "warning");
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("No active model selected", "error");
				return;
			}

			// When the agent is streaming, use a separate AbortController so that
			// the agent's turn completion does not cancel the btw request.
			const btwController = ctx.isIdle() ? null : new AbortController();

			const model = ctx.model;
			const thinkingLevel = pi.getThinkingLevel();
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) {
				ctx.ui.notify(`No API key available for ${model.provider}/${model.id}`, "error");
				return;
			}

			const messages = excludeBtwMessages(stripInProgressMessage(getSessionMessages(ctx)));

			const run = (signal?: AbortSignal, onTextDelta?: (text: string) => void) =>
				streamBtwQuestion({
					model,
					apiKey: auth.apiKey,
					headers: auth.headers,
					thinkingLevel,
					messages,
					question,
					signal,
					onTextDelta,
				});

			let answer: string | null;
			let errorHint: string | undefined;

			try {
				if (ctx.hasUI) {
					const result = await ctx.ui.custom<{ answer: string | null; cancelled?: boolean; errorHint?: string }>(
						(tui, theme, _kb, done) => {
							const view = new StreamingBtwView(tui, theme, model.id, thinkingLevel);
							let settled = false;
							const finish = (value: { answer: string | null; cancelled?: boolean; errorHint?: string }) => {
								if (settled) return;
								settled = true;
								done(value);
							};

							view.onAbort = () => {
								btwController?.abort();
								finish({ answer: null, cancelled: true });
							};

							run(btwController?.signal, (delta) => view.onTextDelta(delta))
								.then((result) => {
									view.markComplete();
									// Give TUI one render cycle to show the final markdown before closing
									setTimeout(() => finish({ answer: result.answer, errorHint: result.errorHint }), 600);
								})
								.catch((error) => {
									if (error instanceof Error && error.message === "aborted") {
										finish({ answer: null, cancelled: true });
										return;
									}
									console.error("/btw failed:", error);
									const msg = error instanceof Error ? error.message : String(error);
									view.showError(msg);
									setTimeout(() => finish({ answer: null, errorHint: msg }), 1500);
								});

							return view;
						},
					);

					if (result.cancelled) {
						ctx.ui.notify("Cancelled", "info");
						return;
					}
					answer = result.answer;
					errorHint = result.errorHint;
				} else {
					const result = await run(btwController?.signal);
					answer = result.answer;
					errorHint = result.errorHint;
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message === "aborted") {
					ctx.ui.notify("Cancelled", "info");
					return;
				}
				ctx.ui.notify(message, "error");
				return;
			}

			if (answer === null) {
				if (errorHint) {
					ctx.ui.notify(errorHint, "warning");
				} else {
					ctx.ui.notify("Cancelled", "info");
				}
				return;
			}

			pi.sendMessage({
				customType: CUSTOM_MESSAGE_TYPE,
				content: `Q: ${question}\n\nA:\n${answer}`,
				display: true,
				details: {
					question,
					answer,
					model: `${model.provider}/${model.id}`,
					thinkingLevel,
					timestamp: Date.now(),
					excludedFromContext: true,
				},
			});

			ctx.ui.notify("BTW saved to the session and excluded from future agent context.", "success");
		},
	});
}
