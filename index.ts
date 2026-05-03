import type {
	AssistantMessage,
	Context,
	ExtensionAPI,
	Model,
	SimpleStreamOptions,
	ToolCall,
} from "@mariozechner/pi-coding-agent";
import { calculateCost, createAssistantMessageEventStream } from "@mariozechner/pi-ai";

type AnyRecord = Record<string, any>;

const PROVIDER = "xai-ws";
const API = "xai-responses-websocket";
const DEFAULT_URL = "wss://api.x.ai/v1/responses";
const MAX_SOCKET_AGE_MS = 24 * 60 * 1000;

type SessionState = {
	socket: WebSocket;
	openedAt: number;
	busy: boolean;
	previousResponseId?: string;
	seenMessages: number;
};

const sessions = new Map<string, SessionState>();

function apiKey(options?: SimpleStreamOptions): string {
	const key = options?.apiKey || process.env.XAI_API_KEY;
	if (!key) throw new Error("No xAI API key. Set XAI_API_KEY or pass --api-key.");
	return key;
}

function sessionKey(model: Model<any>, options?: SimpleStreamOptions): string {
	return options?.sessionId || `${process.pid}:${model.provider}:${model.id}`;
}

function isOpen(socket: WebSocket): boolean {
	return socket.readyState === WebSocket.OPEN;
}

function closeQuietly(socket: WebSocket) {
	try {
		socket.close(1000, "done");
	} catch {}
}

function resolveThinking(options?: SimpleStreamOptions): "off" | "low" | "high" | undefined {
	const override = (process.env.XAI_WS_REASONING || "auto").toLowerCase();
	if (override === "off" || override === "none" || override === "0") return "off";
	if (override === "low" || override === "high") return override;
	return undefined;
}

function envFlag(name: string, defaultValue: boolean): boolean {
	const value = process.env[name]?.toLowerCase();
	if (value === undefined) return defaultValue;
	return value === "1" || value === "true" || value === "yes" || value === "on";
}

function contentToInput(content: any): AnyRecord[] {
	if (typeof content === "string") return [{ type: "input_text", text: content }];
	if (!Array.isArray(content)) return [{ type: "input_text", text: String(content ?? "") }];
	return content
		.map((item) => {
			if (item.type === "text") return { type: "input_text", text: item.text || "" };
			if (item.type === "image") {
				return {
					type: "input_image",
					detail: "auto",
					image_url: `data:${item.mimeType};base64,${item.data}`,
				};
			}
			return null;
		})
		.filter(Boolean);
}

function toolCallIds(id: string): { callId: string; itemId?: string } {
	const [callId, itemId] = String(id || "").split("|");
	return { callId, itemId };
}

function convertMessages(context: Context, model: Model<any>, startIndex = 0): AnyRecord[] {
	const input: AnyRecord[] = [];
	if (startIndex === 0 && context.systemPrompt) {
		input.push({
			type: "message",
			role: model.reasoning ? "developer" : "system",
			content: [{ type: "input_text", text: context.systemPrompt }],
		});
	}

	for (const msg of context.messages.slice(startIndex)) {
		if (msg.role === "user") {
			input.push({ type: "message", role: "user", content: contentToInput(msg.content) });
		} else if (msg.role === "toolResult") {
			const { callId } = toolCallIds(msg.toolCallId);
			const output = msg.content
				.map((item: any) => (item.type === "text" ? item.text : `[${item.mimeType || "image"}]`))
				.join("\n");
			input.push({ type: "function_call_output", call_id: callId, output });
		} else if (msg.role === "assistant") {
			for (const block of msg.content || []) {
				if (block.type === "text" && block.text) {
					input.push({
						type: "message",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: block.text, annotations: [] }],
					});
				} else if (block.type === "toolCall") {
					const { callId, itemId } = toolCallIds(block.id);
					input.push({
						type: "function_call",
						id: itemId,
						call_id: callId,
						name: block.name,
						arguments: JSON.stringify(block.arguments || {}),
					});
				}
			}
		}
	}
	return input;
}

function convertTools(context: Context): AnyRecord[] | undefined {
	if (!context.tools?.length) return undefined;
	return context.tools.map((tool) => ({
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	}));
}

function makeOutput(model: Model<any>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

async function connect(url: string, key: string, signal?: AbortSignal): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${key}` } } as any);
		const cleanup = () => {
			socket.removeEventListener("open", onOpen);
			socket.removeEventListener("error", onError);
			socket.removeEventListener("close", onClose);
			signal?.removeEventListener("abort", onAbort);
		};
		const onOpen = () => {
			cleanup();
			resolve(socket);
		};
		const onError = () => {
			cleanup();
			reject(new Error("WebSocket error"));
		};
		const onClose = (event: CloseEvent) => {
			cleanup();
			reject(new Error(`WebSocket closed ${event.code} ${event.reason}`.trim()));
		};
		const onAbort = () => {
			cleanup();
			closeQuietly(socket);
			reject(new Error("Request was aborted"));
		};
		socket.addEventListener("open", onOpen);
		socket.addEventListener("error", onError);
		socket.addEventListener("close", onClose);
		signal?.addEventListener("abort", onAbort);
	});
}

async function acquire(model: Model<any>, options?: SimpleStreamOptions): Promise<SessionState> {
	const key = sessionKey(model, options);
	const current = sessions.get(key);
	if (
		current &&
		!current.busy &&
		isOpen(current.socket) &&
		Date.now() - current.openedAt < MAX_SOCKET_AGE_MS
	) {
		current.busy = true;
		return current;
	}
	if (current) {
		closeQuietly(current.socket);
		sessions.delete(key);
	}
	const socket = await connect(model.baseUrl || DEFAULT_URL, apiKey(options), options?.signal);
	const state: SessionState = { socket, openedAt: Date.now(), busy: true, seenMessages: 0 };
	sessions.set(key, state);
	return state;
}

function decodeData(data: any): string | undefined {
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
	if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
	return undefined;
}

function parseJson(text: string): any {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function ensureText(output: AssistantMessage, stream: any): number {
	const last = output.content[output.content.length - 1];
	if (last?.type === "text") return output.content.length - 1;
	output.content.push({ type: "text", text: "" });
	const index = output.content.length - 1;
	stream.push({ type: "text_start", contentIndex: index, partial: output });
	return index;
}

function ensureThinking(output: AssistantMessage, stream: any): number {
	const last = output.content[output.content.length - 1];
	if (last?.type === "thinking") return output.content.length - 1;
	output.content.push({ type: "thinking", thinking: "" });
	const index = output.content.length - 1;
	stream.push({ type: "thinking_start", contentIndex: index, partial: output });
	return index;
}

async function readResponse(socket: WebSocket, output: AssistantMessage, stream: any, model: Model<any>, signal?: AbortSignal) {
	const toolBlocks = new Map<string, { index: number; json: string; callId: string; itemId: string; name: string }>();
	let completed = false;
	let failure: Error | undefined;
	const ensureToolBlock = (key: string, item: AnyRecord = {}) => {
		let state = toolBlocks.get(key);
		if (state) return state;
		const callId = item.call_id || `call_${key}`;
		const itemId = item.id || item.item_id || key;
		const block: ToolCall & { partialJson?: string } = {
			type: "toolCall",
			id: `${callId}|${itemId}`,
			name: item.name || "",
			arguments: {},
			partialJson: "",
		} as any;
		output.content.push(block);
		state = { index: output.content.length - 1, json: "", callId, itemId, name: item.name || "" };
		toolBlocks.set(key, state);
		stream.push({ type: "toolcall_start", contentIndex: state.index, partial: output });
		return state;
	};
	const finishToolCall = (key: string, item: AnyRecord = {}) => {
		const state = ensureToolBlock(key, item);
		const raw = item.arguments || state.json || "{}";
		const toolCall: ToolCall = {
			type: "toolCall",
			id: `${item.call_id || state.callId}|${item.id || state.itemId}`,
			name: item.name || state.name,
			arguments: parseJson(raw) || {},
		};
		output.content[state.index] = toolCall;
		stream.push({ type: "toolcall_end", contentIndex: state.index, toolCall, partial: output });
	};

	await new Promise<void>((resolve) => {
		const finish = () => {
			cleanup();
			resolve();
		};
		const cleanup = () => {
			socket.removeEventListener("message", onMessage);
			socket.removeEventListener("error", onError);
			socket.removeEventListener("close", onClose);
			signal?.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			failure = new Error("Request was aborted");
			finish();
		};
		const onError = () => {
			failure = new Error("WebSocket error");
			finish();
		};
		const onClose = (event: CloseEvent) => {
			if (!completed) failure = new Error(`WebSocket closed ${event.code} ${event.reason}`.trim());
			finish();
		};
		const onMessage = (event: MessageEvent) => {
			const text = decodeData(event.data);
			if (!text) return;
			const evt = parseJson(text);
			if (evt?.error && !evt.type) {
				const err = evt.error;
				failure = new Error(`${err.code || err.type || "error"}: ${err.message || JSON.stringify(err)}`);
				finish();
				return;
			}
			if (!evt?.type) return;

			if (evt.type === "error") {
				const err = evt.error || evt;
				failure = new Error(`${err.code || err.type || "error"}: ${err.message || JSON.stringify(err)}`);
				finish();
				return;
			}

			if (evt.type === "response.output_text.delta" || evt.type === "response.text.delta") {
				const delta = evt.delta || "";
				const index = ensureText(output, stream);
				(output.content[index] as any).text += delta;
				stream.push({ type: "text_delta", contentIndex: index, delta, partial: output });
			} else if (evt.type === "response.output_text.done" || evt.type === "response.text.done") {
				const index = output.content.findLastIndex((block: any) => block.type === "text");
				if (index >= 0) stream.push({ type: "text_end", contentIndex: index, content: (output.content[index] as any).text, partial: output });
			} else if (evt.type.includes("reasoning") && evt.type.endsWith(".delta")) {
				const delta = evt.delta || "";
				const index = ensureThinking(output, stream);
				(output.content[index] as any).thinking += delta;
				stream.push({ type: "thinking_delta", contentIndex: index, delta, partial: output });
			} else if (evt.type.includes("reasoning") && evt.type.endsWith(".done")) {
				const index = output.content.findLastIndex((block: any) => block.type === "thinking");
				if (index >= 0) stream.push({ type: "thinking_end", contentIndex: index, content: (output.content[index] as any).thinking, partial: output });
			} else if (evt.type === "response.output_item.added" && evt.item?.type === "function_call") {
				const item = evt.item;
				const block: ToolCall & { partialJson?: string } = {
					type: "toolCall",
					id: `${item.call_id}|${item.id || item.call_id}`,
					name: item.name,
					arguments: {},
					partialJson: "",
				} as any;
				output.content.push(block);
				const index = output.content.length - 1;
				toolBlocks.set(String(evt.output_index ?? item.id), {
					index,
					json: "",
					callId: item.call_id,
					itemId: item.id || item.call_id,
					name: item.name,
				});
				stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
			} else if (evt.type === "response.function_call_arguments.delta") {
				const key = String(evt.output_index ?? evt.item_id);
				const state = ensureToolBlock(key, { item_id: evt.item_id });
				state.json += evt.delta || "";
				const block: any = output.content[state.index];
				block.partialJson = state.json;
				stream.push({ type: "toolcall_delta", contentIndex: state.index, delta: evt.delta || "", partial: output });
			} else if (evt.type === "response.function_call_arguments.done") {
				const key = String(evt.output_index ?? evt.item_id);
				const state = ensureToolBlock(key, { item_id: evt.item_id });
				state.json = evt.arguments || state.json;
			} else if (evt.type === "response.output_item.done" && evt.item?.type === "function_call") {
				const item = evt.item;
				const key = String(evt.output_index ?? item.id);
				finishToolCall(key, item);
			} else if (evt.type === "response.completed" || evt.type === "response.done") {
				const response = evt.response || {};
				output.responseId = response.id || output.responseId;
				for (let i = 0; i < (response.output || []).length; i++) {
					const item = response.output[i];
					if (item?.type === "function_call") finishToolCall(String(i), item);
				}
				const usage = response.usage;
				if (usage) {
					const cached = usage.input_tokens_details?.cached_tokens || 0;
					output.usage.input = (usage.input_tokens || 0) - cached;
					output.usage.output = usage.output_tokens || 0;
					output.usage.cacheRead = cached;
					output.usage.totalTokens = usage.total_tokens || output.usage.input + output.usage.output + cached;
					calculateCost(model as any, output.usage);
				}
				output.stopReason = output.content.some((block) => block.type === "toolCall") ? "toolUse" : "stop";
				completed = true;
				finish();
			} else if (evt.type === "response.failed") {
				const err = evt.response?.error;
				failure = new Error(err?.message || JSON.stringify(evt));
				finish();
			}
		};

		socket.addEventListener("message", onMessage);
		socket.addEventListener("error", onError);
		socket.addEventListener("close", onClose);
		signal?.addEventListener("abort", onAbort);
	});

	if (failure) throw failure;
	if (!completed) throw new Error("WebSocket stream ended before response.completed");
}

function streamXaiResponsesWebSocket(model: Model<any>, context: Context, options?: SimpleStreamOptions) {
	const stream = createAssistantMessageEventStream();
	(async () => {
		const output = makeOutput(model);
		let state: SessionState | undefined;
		try {
			state = await acquire(model, options);
			const store = envFlag("XAI_WS_STORE", true);
			const chainEnabled = envFlag("XAI_WS_DELTA_CHAIN", store);
			const useChain = chainEnabled && !!state.previousResponseId && context.messages.length >= state.seenMessages;
			const startIndex = useChain ? state.seenMessages : 0;
			const body: AnyRecord = {
				type: "response.create",
				model: model.id,
				store,
				input: convertMessages(context, model, startIndex),
				tools: convertTools(context) || [],
			};

			if (useChain) body.previous_response_id = state.previousResponseId;
			if (options?.maxTokens) body.max_output_tokens = options.maxTokens;
			if (options?.temperature !== undefined) body.temperature = options.temperature;
			const thinking = resolveThinking(options);
			if (thinking && thinking !== "off") body.reasoning = { effort: thinking };

			state.socket.send(JSON.stringify(body));
			stream.push({ type: "start", partial: output });
			await readResponse(state.socket, output, stream, model, options?.signal);

			state.previousResponseId = output.responseId;
			state.seenMessages = context.messages.length + 1;
			state.busy = false;
			if (output.stopReason !== "toolUse") {
				closeQuietly(state.socket);
				sessions.delete(sessionKey(model, options));
			}
			stream.push({ type: "done", reason: output.stopReason as any, message: output });
			stream.end();
		} catch (error) {
			if (state) {
				state.busy = false;
				if (/previous_response_not_found|closed|aborted|error/i.test(String(error))) {
					closeQuietly(state.socket);
					sessions.delete(sessionKey(model, options));
				}
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason as any, error: output });
			stream.end();
		}
	})();
	return stream;
}

export default function (pi: ExtensionAPI) {
	pi.registerProvider(PROVIDER, {
		baseUrl: process.env.XAI_WS_URL || DEFAULT_URL,
		apiKey: "XAI_API_KEY",
		api: API,
		streamSimple: streamXaiResponsesWebSocket,
		models: [
			{
				id: "grok-4.3",
				name: "Grok 4.3 (xAI Responses WebSocket)",
				api: API,
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
				contextWindow: 256000,
				maxTokens: 32768,
			},
		],
	});
}
