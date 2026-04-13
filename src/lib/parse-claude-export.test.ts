import { describe, expect, test } from "bun:test";
import {
	buildClaudeImportItems,
	parseClaudeConversations,
} from "./parse-claude-export";

describe("parseClaudeConversations", () => {
	test("parses ordered chat_messages from Claude export", () => {
		const conversations = parseClaudeConversations({
			conversations: [
				{
					uuid: "conv_1",
					name: "Test conversation",
					summary: "short summary",
					created_at: "2025-01-01T00:00:00.000Z",
					updated_at: "2025-01-01T00:01:00.000Z",
					chat_messages: [
						{
							uuid: "m1",
							sender: "human",
							created_at: "2025-01-01T00:00:00.000Z",
							text: "hello",
							content: [{ type: "text", text: "hello" }],
						},
						{
							uuid: "m2",
							sender: "assistant",
							created_at: "2025-01-01T00:00:05.000Z",
							text: "world",
							content: [{ type: "text", text: "world" }],
						},
					],
				},
			],
		});

		expect(conversations).toHaveLength(1);
		expect(
			conversations[0]?.messages.map((message) => [message.role, message.text]),
		).toEqual([
			["user", "hello"],
			["assistant", "world"],
		]);
	});

	test("builds import items for conversations and memories", () => {
		const items = buildClaudeImportItems(
			{
				conversations: [
					{
						uuid: "conv_2",
						name: "Long conversation",
						chat_messages: [
							{
								uuid: "m1",
								sender: "human",
								text: "a".repeat(3000),
							},
							{
								uuid: "m2",
								sender: "assistant",
								text: "b".repeat(3000),
							},
						],
					},
				],
				memories: [
					{
						conversations_memory: "memory text",
						project_memories: {
							project_1: "project memory text",
						},
					},
				],
				projects: [
					{
						uuid: "project_1",
						name: "Project One",
					},
				],
			},
			{ maxChars: 2500 },
		);

		expect(items.length).toBeGreaterThan(2);
		expect(
			items.some((item) =>
				item.content.includes("[kind: conversations_memory]"),
			),
		).toBe(true);
		expect(
			items.some((item) => item.content.includes("[kind: project_memory]")),
		).toBe(true);
	});
});
