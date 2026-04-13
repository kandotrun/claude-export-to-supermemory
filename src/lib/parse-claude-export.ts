import { stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import type { PreparedImportItem } from "./import-supermemory";

export type ClaudeExportBundle = {
	users?: RawUser[];
	projects?: RawProject[];
	memories?: RawMemoryBundle[];
	conversations?: RawConversation[];
};

export type FlattenedMessage = {
	role: "user" | "assistant" | "tool" | "unknown";
	text: string;
	createdAt?: string;
};

export type FlattenedConversation = {
	id: string;
	title: string;
	summary?: string;
	createdAt?: string;
	updatedAt?: string;
	messages: FlattenedMessage[];
};

type RawUser = {
	uuid?: unknown;
	full_name?: unknown;
	email_address?: unknown;
};

type RawMemoryBundle = {
	account_uuid?: unknown;
	conversations_memory?: unknown;
	project_memories?: Record<string, unknown>;
};

type RawProject = {
	uuid?: unknown;
	name?: unknown;
	description?: unknown;
	prompt_template?: unknown;
	created_at?: unknown;
	updated_at?: unknown;
	docs?: RawProjectDoc[];
};

type RawProjectDoc = {
	uuid?: unknown;
	filename?: unknown;
	content?: unknown;
	created_at?: unknown;
};

type RawConversation = {
	uuid?: unknown;
	name?: unknown;
	summary?: unknown;
	created_at?: unknown;
	updated_at?: unknown;
	account?: Record<string, unknown>;
	chat_messages?: RawChatMessage[];
};

type RawChatMessage = {
	uuid?: unknown;
	sender?: unknown;
	parent_message_uuid?: unknown;
	created_at?: unknown;
	updated_at?: unknown;
	text?: unknown;
	content?: RawContentPart[];
	attachments?: unknown[];
	files?: unknown[];
};

type RawContentPart =
	| {
			type?: unknown;
			text?: unknown;
			thinking?: unknown;
			name?: unknown;
			input?: unknown;
			content?: unknown;
			is_error?: unknown;
	  }
	| Record<string, unknown>;

export async function loadClaudeExport(
	inputPath: string,
): Promise<ClaudeExportBundle> {
	const resolvedPath = resolve(inputPath);
	const inputStat = await stat(resolvedPath);

	if (inputStat.isDirectory()) {
		return {
			users: await readJsonIfExists<RawUser[]>(`${resolvedPath}/users.json`),
			projects: await readJsonIfExists<RawProject[]>(
				`${resolvedPath}/projects.json`,
			),
			memories: await readJsonIfExists<RawMemoryBundle[]>(
				`${resolvedPath}/memories.json`,
			),
			conversations: await readJsonIfExists<RawConversation[]>(
				`${resolvedPath}/conversations.json`,
			),
		};
	}

	const extension = extname(resolvedPath).toLowerCase();

	if (extension === ".zip") {
		const archive = new Uint8Array(await Bun.file(resolvedPath).arrayBuffer());
		const entries = unzipSync(archive);

		return {
			users: readJsonFromEntries(entries, "users.json"),
			projects: readJsonFromEntries(entries, "projects.json"),
			memories: readJsonFromEntries(entries, "memories.json"),
			conversations: readJsonFromEntries(entries, "conversations.json"),
		};
	}

	if (extension === ".json") {
		const parsed = JSON.parse(await Bun.file(resolvedPath).text());
		const filename = basename(resolvedPath).toLowerCase();

		if (filename === "users.json") {
			return { users: parsed };
		}
		if (filename === "projects.json") {
			return { projects: parsed };
		}
		if (filename === "memories.json") {
			return { memories: parsed };
		}

		return { conversations: parsed };
	}

	throw new Error(
		`Unsupported input: ${resolvedPath}. Use a .zip, .json, or extracted export directory.`,
	);
}

export function parseClaudeConversations(
	bundle: ClaudeExportBundle,
	options: { includeThinking?: boolean; includeTools?: boolean } = {},
): FlattenedConversation[] {
	const conversations = bundle.conversations;
	if (!conversations) {
		return [];
	}

	if (!Array.isArray(conversations)) {
		throw new Error("Expected conversations.json to contain an array.");
	}

	return conversations
		.map((conversation) => flattenConversation(conversation, options))
		.filter((conversation): conversation is FlattenedConversation =>
			Boolean(conversation),
		)
		.filter((conversation) => conversation.messages.length > 0);
}

export function buildClaudeImportItems(
	bundle: ClaudeExportBundle,
	options: {
		includeThinking?: boolean;
		includeTools?: boolean;
		includeMemories?: boolean;
		includeProjectMemories?: boolean;
		includeProjectDocs?: boolean;
		maxChars?: number;
	} = {},
): PreparedImportItem[] {
	const maxChars = Math.max(2_000, options.maxChars ?? 120_000);
	const bodyBudget = Math.max(1_000, maxChars - 1_000);
	const items: PreparedImportItem[] = [];

	const conversations = parseClaudeConversations(bundle, options);
	for (const conversation of conversations) {
		const bodyLines = [
			conversation.summary ? `Summary: ${conversation.summary}` : undefined,
			conversation.summary ? "" : undefined,
			...conversation.messages.flatMap((message) =>
				renderMessageBlocks(message, bodyBudget),
			),
		].filter((line): line is string => Boolean(line));

		const chunks = chunkBlocks(bodyLines, bodyBudget);
		items.push(
			...chunks.map((chunk, index) =>
				createItem({
					source: "claude-export",
					id: conversation.id,
					title: conversation.title,
					part: index + 1,
					totalParts: chunks.length,
					createdAt: conversation.createdAt,
					updatedAt: conversation.updatedAt,
					metadata: [
						["kind", "conversation"],
						["conversation_uuid", conversation.id],
						["title", conversation.title],
					],
					body: chunk,
					maxChars,
				}),
			),
		);
	}

	const memoryBundle = bundle.memories?.[0];
	if (options.includeMemories !== false) {
		const conversationsMemory = extractText(memoryBundle?.conversations_memory);
		if (conversationsMemory) {
			const chunks = chunkText(conversationsMemory, bodyBudget);
			items.push(
				...chunks.map((chunk, index) =>
					createItem({
						source: "claude-export",
						id: "claude-conversations-memory",
						title: "Claude conversation memory",
						part: index + 1,
						totalParts: chunks.length,
						metadata: [["kind", "conversations_memory"]],
						body: chunk,
						maxChars,
					}),
				),
			);
		}
	}

	if (options.includeProjectMemories !== false) {
		for (const [projectUuid, rawMemory] of Object.entries(
			memoryBundle?.project_memories ?? {},
		)) {
			const text = extractText(rawMemory);
			if (!text) {
				continue;
			}

			const project = bundle.projects?.find(
				(entry) => asString(entry.uuid) === projectUuid,
			);
			const title =
				project?.name && typeof project.name === "string"
					? project.name
					: `Project ${projectUuid}`;
			const chunks = chunkText(text, bodyBudget);

			items.push(
				...chunks.map((chunk, index) =>
					createItem({
						source: "claude-export",
						id: `project-memory:${projectUuid}`,
						title: `${title} memory`,
						part: index + 1,
						totalParts: chunks.length,
						createdAt: toIsoTimestamp(project?.created_at),
						updatedAt: toIsoTimestamp(project?.updated_at),
						metadata: [
							["kind", "project_memory"],
							["project_uuid", projectUuid],
							["project_name", title],
						],
						body: chunk,
						maxChars,
					}),
				),
			);
		}
	}

	if (options.includeProjectDocs) {
		for (const project of bundle.projects ?? []) {
			const projectUuid = asString(project.uuid) ?? crypto.randomUUID();
			const projectName = asString(project.name) ?? "Untitled project";
			for (const doc of project.docs ?? []) {
				const content = extractText(doc.content);
				if (!content) {
					continue;
				}

				const filename = asString(doc.filename) ?? "Untitled doc";
				const chunks = chunkText(content, bodyBudget);
				items.push(
					...chunks.map((chunk, index) =>
						createItem({
							source: "claude-export",
							id: `project-doc:${asString(doc.uuid) ?? `${projectUuid}:${filename}`}`,
							title: `${projectName} / ${filename}`,
							part: index + 1,
							totalParts: chunks.length,
							createdAt:
								toIsoTimestamp(doc.created_at) ??
								toIsoTimestamp(project.created_at),
							updatedAt: toIsoTimestamp(project.updated_at),
							metadata: [
								["kind", "project_doc"],
								["project_uuid", projectUuid],
								["project_name", projectName],
								["doc_filename", filename],
							],
							body: chunk,
							maxChars,
						}),
					),
				);
			}
		}
	}

	return items;
}

function flattenConversation(
	conversation: RawConversation,
	options: { includeThinking?: boolean; includeTools?: boolean },
): FlattenedConversation | null {
	const id = asString(conversation.uuid) ?? crypto.randomUUID();
	const title = asString(conversation.name)?.trim() || "Untitled";
	const summary = asString(conversation.summary)?.trim();
	const createdAt = toIsoTimestamp(conversation.created_at);
	const updatedAt = toIsoTimestamp(conversation.updated_at);
	const messages = (conversation.chat_messages ?? [])
		.flatMap((message) => normalizeMessage(message, options))
		.filter((message): message is FlattenedMessage => Boolean(message));

	if (messages.length === 0) {
		return null;
	}

	return {
		id,
		title,
		summary,
		createdAt,
		updatedAt,
		messages,
	};
}

function normalizeMessage(
	message: RawChatMessage,
	options: { includeThinking?: boolean; includeTools?: boolean },
): FlattenedMessage[] {
	const messages: FlattenedMessage[] = [];
	const role = normalizeSender(message.sender);
	const createdAt = toIsoTimestamp(message.created_at ?? message.updated_at);
	const text = extractText(message.text);

	if (text) {
		messages.push({ role, text, createdAt });
	}

	for (const part of message.content ?? []) {
		const type = asString(part.type);
		if (type === "thinking" && options.includeThinking) {
			const thinking = extractText(part.thinking);
			if (thinking) {
				messages.push({
					role: "assistant",
					text: `[Thinking]\n${thinking}`,
					createdAt,
				});
			}
		}

		if (options.includeTools && type === "tool_use") {
			const name = asString(part.name) ?? "tool";
			const input = stringifyUnknown(part.input);
			messages.push({
				role: "tool",
				text: `[Tool use: ${name}]\n${input}`,
				createdAt,
			});
		}

		if (options.includeTools && type === "tool_result") {
			const name = asString(part.name) ?? "tool";
			const result =
				extractToolResultText(part.content) || stringifyUnknown(part.content);
			messages.push({
				role: "tool",
				text: `[Tool result: ${name}]\n${result}`,
				createdAt,
			});
		}
	}

	return dedupeMessages(messages);
}

function dedupeMessages(messages: FlattenedMessage[]): FlattenedMessage[] {
	const result: FlattenedMessage[] = [];
	const seen = new Set<string>();

	for (const message of messages) {
		const key = `${message.role}:${message.text}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		result.push(message);
	}

	return result;
}

function normalizeSender(value: unknown): FlattenedMessage["role"] {
	const sender = asString(value)?.toLowerCase();
	if (sender === "human") {
		return "user";
	}
	if (sender === "assistant") {
		return "assistant";
	}
	if (sender === "tool") {
		return "tool";
	}
	return "unknown";
}

function extractToolResultText(value: unknown): string {
	if (Array.isArray(value)) {
		return value
			.map((entry) => {
				if (entry && typeof entry === "object" && "text" in entry) {
					return extractText((entry as Record<string, unknown>).text);
				}
				return extractText(entry);
			})
			.filter(Boolean)
			.join("\n\n");
	}

	return extractText(value);
}

function createItem(params: {
	source: string;
	id: string;
	title: string;
	part: number;
	totalParts: number;
	createdAt?: string;
	updatedAt?: string;
	metadata: Array<[string, string]>;
	body: string;
	maxChars: number;
}): PreparedImportItem {
	const headerLines = [
		`[source: ${params.source}]`,
		...params.metadata.map(([key, value]) => `[${key}: ${value}]`),
		params.createdAt ? `[created_at: ${params.createdAt}]` : undefined,
		params.updatedAt ? `[updated_at: ${params.updatedAt}]` : undefined,
		`[part: ${params.part}/${params.totalParts}]`,
		"",
	].filter((line): line is string => Boolean(line));

	const content = `${headerLines.join("\n")}\n${params.body}`.trim();

	if (content.length > params.maxChars) {
		throw new Error(
			`Prepared part exceeded maxChars (${content.length} > ${params.maxChars}) for ${params.id}.`,
		);
	}

	return {
		conversationId: params.id,
		title: params.title,
		part: params.part,
		totalParts: params.totalParts,
		createdAt: params.createdAt,
		updatedAt: params.updatedAt,
		content,
	};
}

function renderMessageBlocks(
	message: FlattenedMessage,
	maxBlockChars: number,
): string[] {
	const label = roleLabel(message.role);
	const normalizedText = message.text.replace(/\r\n/g, "\n").trim();
	const basePrefix = `${label}:\n`;
	const continuedPrefix = `${label} (continued):\n`;
	const initialBudget = Math.max(200, maxBlockChars - basePrefix.length - 2);
	const continuedBudget = Math.max(
		200,
		maxBlockChars - continuedPrefix.length - 2,
	);
	const segments = splitText(normalizedText, initialBudget, continuedBudget);

	return segments.map((segment, index) => {
		const prefix = index === 0 ? basePrefix : continuedPrefix;
		return `${prefix}${segment.trim()}\n`;
	});
}

function chunkText(text: string, maxChars: number): string[] {
	return chunkBlocks(splitText(text.trim(), maxChars, maxChars), maxChars);
}

function splitText(
	text: string,
	firstBudget: number,
	continuedBudget: number,
): string[] {
	const segments: string[] = [];
	let remaining = text.trim();
	let budget = firstBudget;

	while (remaining.length > 0) {
		if (remaining.length <= budget) {
			segments.push(remaining);
			break;
		}

		const sliceIndex = findSplitPoint(remaining, budget);
		segments.push(remaining.slice(0, sliceIndex).trim());
		remaining = remaining.slice(sliceIndex).trim();
		budget = continuedBudget;
	}

	return segments;
}

function findSplitPoint(text: string, budget: number): number {
	const candidates = ["\n\n", "\n", ". ", "。", " "];

	for (const token of candidates) {
		const index = text.lastIndexOf(token, budget);
		if (index > budget * 0.6) {
			return index + token.length;
		}
	}

	return budget;
}

function chunkBlocks(blocks: string[], maxChars: number): string[] {
	const chunks: string[] = [];
	let current = "";

	for (const block of blocks) {
		const trimmed = block.trimEnd();
		const candidate = current ? `${current}\n${trimmed}` : trimmed;

		if (candidate.length > maxChars && current) {
			chunks.push(current.trimEnd());
			current = trimmed;
			continue;
		}

		current = candidate;
	}

	if (current.trim()) {
		chunks.push(current.trimEnd());
	}

	return chunks;
}

function roleLabel(role: FlattenedMessage["role"]): string {
	switch (role) {
		case "assistant":
			return "Assistant";
		case "tool":
			return "Tool";
		case "unknown":
			return "Message";
		default:
			return "User";
	}
}

async function readJsonIfExists<T>(path: string): Promise<T | undefined> {
	const file = Bun.file(path);
	if (!(await file.exists())) {
		return undefined;
	}
	return (await file.json()) as T;
}

function readJsonFromEntries<T>(
	entries: Record<string, Uint8Array>,
	filename: string,
): T | undefined {
	const match = Object.entries(entries).find(([name]) => {
		const normalized = name.replace(/\\/g, "/");
		return normalized === filename || normalized.endsWith(`/${filename}`);
	});

	if (!match) {
		return undefined;
	}

	return JSON.parse(strFromU8(match[1])) as T;
}

function extractText(value: unknown): string {
	if (typeof value === "string") {
		return value.trim();
	}

	if (Array.isArray(value)) {
		return value.map(extractText).filter(Boolean).join("\n\n").trim();
	}

	if (value && typeof value === "object") {
		const candidate = value as Record<string, unknown>;
		for (const key of ["text", "content", "summary", "description"]) {
			if (key in candidate) {
				const text = extractText(candidate[key]);
				if (text) {
					return text;
				}
			}
		}
	}

	return "";
}

function stringifyUnknown(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}

	if (value === null || value === undefined) {
		return "";
	}

	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function toIsoTimestamp(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		const milliseconds = value > 1e12 ? value : value * 1_000;
		return new Date(milliseconds).toISOString();
	}

	if (typeof value === "string" && value.trim()) {
		const numeric = Number(value);
		if (Number.isFinite(numeric)) {
			return toIsoTimestamp(numeric);
		}

		const parsed = Date.parse(value);
		if (!Number.isNaN(parsed)) {
			return new Date(parsed).toISOString();
		}
	}

	return undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}
