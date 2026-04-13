import { importToSupermemory } from "./lib/import-supermemory";
import {
	buildClaudeImportItems,
	loadClaudeExport,
	parseClaudeConversations,
} from "./lib/parse-claude-export";

type CliOptions = {
	input?: string;
	containerTag: string;
	manifestPath: string;
	maxChars: number;
	limit?: number;
	since?: string;
	includeThinking: boolean;
	includeTools: boolean;
	includeMemories: boolean;
	includeProjectMemories: boolean;
	includeProjectDocs: boolean;
	dryRun: boolean;
	verbose: boolean;
	help: boolean;
};

async function main() {
	const options = parseArgs(process.argv.slice(2));

	if (options.help || !options.input) {
		printUsage();
		process.exit(options.help ? 0 : 1);
	}

	const bundle = await loadClaudeExport(options.input);
	const conversations = parseClaudeConversations(bundle, {
		includeThinking: options.includeThinking,
		includeTools: options.includeTools,
	})
		.filter((conversation) => {
			if (!options.since) {
				return true;
			}

			const updatedAt = conversation.updatedAt ?? conversation.createdAt;
			return updatedAt
				? Date.parse(updatedAt) >= Date.parse(options.since)
				: false;
		})
		.sort((left, right) =>
			compareTimestamps(
				left.updatedAt ?? left.createdAt,
				right.updatedAt ?? right.createdAt,
			),
		);

	const limitedConversations =
		typeof options.limit === "number"
			? conversations.slice(0, options.limit)
			: conversations;
	const selectedIds = new Set(
		limitedConversations.map((conversation) => conversation.id),
	);
	const selectedRawConversations = (bundle.conversations ?? []).filter(
		(conversation) => {
			const uuid =
				typeof conversation.uuid === "string" ? conversation.uuid : undefined;
			return uuid ? selectedIds.has(uuid) : false;
		},
	);

	const items = buildClaudeImportItems(
		{
			...bundle,
			conversations: selectedRawConversations,
		},
		{
			includeThinking: options.includeThinking,
			includeTools: options.includeTools,
			includeMemories: options.includeMemories,
			includeProjectMemories: options.includeProjectMemories,
			includeProjectDocs: options.includeProjectDocs,
			maxChars: options.maxChars,
		},
	);

	console.log(
		`Loaded ${bundle.conversations?.length ?? 0} conversation(s), selected ${limitedConversations.length}, prepared ${items.length} import item(s).`,
	);

	const result = await importToSupermemory({
		dryRun: options.dryRun,
		verbose: options.verbose,
		containerTag: options.containerTag,
		manifestPath: options.manifestPath,
		items,
	});

	console.log(
		`${options.dryRun ? "Dry run complete" : "Import complete"}. Imported: ${result.imported}, skipped: ${result.skipped}, failed: ${result.failed}.`,
	);
}

function parseArgs(args: string[]): CliOptions {
	const options: CliOptions = {
		input: undefined,
		containerTag: process.env.SUPERMEMORY_CONTAINER_TAG || "sm_project_default",
		manifestPath: ".data/import-manifest.json",
		maxChars: 120_000,
		limit: undefined,
		since: undefined,
		includeThinking: false,
		includeTools: false,
		includeMemories: true,
		includeProjectMemories: true,
		includeProjectDocs: false,
		dryRun: false,
		verbose: false,
		help: false,
	};

	const consumeValue = (index: number, flag: string) => {
		const value = args[index + 1];
		if (!value || value.startsWith("--")) {
			throw new Error(`Missing value for ${flag}`);
		}
		return value;
	};

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];

		if (!arg) {
			continue;
		}

		if (!arg.startsWith("--")) {
			options.input ??= arg;
			continue;
		}

		switch (arg) {
			case "--input":
				options.input = consumeValue(index, arg);
				index += 1;
				break;
			case "--container":
				options.containerTag = consumeValue(index, arg);
				index += 1;
				break;
			case "--manifest":
				options.manifestPath = consumeValue(index, arg);
				index += 1;
				break;
			case "--max-chars":
				options.maxChars = parsePositiveInt(consumeValue(index, arg), arg);
				index += 1;
				break;
			case "--limit":
				options.limit = parsePositiveInt(consumeValue(index, arg), arg);
				index += 1;
				break;
			case "--since": {
				const value = consumeValue(index, arg);
				if (Number.isNaN(Date.parse(value))) {
					throw new Error(`Invalid ISO date for ${arg}: ${value}`);
				}
				options.since = value;
				index += 1;
				break;
			}
			case "--include-thinking":
				options.includeThinking = true;
				break;
			case "--include-tools":
				options.includeTools = true;
				break;
			case "--skip-memories":
				options.includeMemories = false;
				break;
			case "--skip-project-memories":
				options.includeProjectMemories = false;
				break;
			case "--include-project-docs":
				options.includeProjectDocs = true;
				break;
			case "--dry-run":
				options.dryRun = true;
				break;
			case "--verbose":
				options.verbose = true;
				break;
			case "--help":
			case "-h":
				options.help = true;
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}

	return options;
}

function parsePositiveInt(value: string, flag: string): number {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`Expected a positive integer for ${flag}, got: ${value}`);
	}
	return parsed;
}

function compareTimestamps(left?: string, right?: string): number {
	const leftValue = left ? Date.parse(left) : 0;
	const rightValue = right ? Date.parse(right) : 0;
	return leftValue - rightValue;
}

function printUsage() {
	console.log(`claude-export-to-supermemory

Usage:
  bun run src/cli.ts --input <path>
  bun run src/cli.ts <path>

Accepted input:
  - Claude export .zip
  - extracted export directory containing conversations.json
  - conversations.json directly

Options:
  --container <tag>         Supermemory container tag (default: SUPERMEMORY_CONTAINER_TAG or sm_project_default)
  --manifest <path>         Local manifest path for dedupe tracking (default: .data/import-manifest.json)
  --max-chars <n>           Max chars per saved memory item (default: 120000)
  --limit <n>               Only import the first N conversations after filtering
  --since <iso-date>        Only import conversations updated on or after this ISO date
  --include-thinking        Include Claude thinking blocks
  --include-tools           Include tool_use and tool_result blocks
  --skip-memories           Skip top-level conversations_memory import
  --skip-project-memories   Skip project_memories import
  --include-project-docs    Include project docs from projects.json
  --dry-run                 Parse and prepare items without sending to Supermemory
  --verbose                 Print per-item progress
  --help                    Show usage
`);
}

void main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
