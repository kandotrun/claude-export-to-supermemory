import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type PreparedImportItem = {
	conversationId: string;
	title: string;
	part: number;
	totalParts: number;
	createdAt?: string;
	updatedAt?: string;
	content: string;
};

export type ImportManifest = {
	version: 1;
	updatedAt: string;
	items: Record<
		string,
		{
			conversationId: string;
			title: string;
			part: number;
			totalParts: number;
			hash: string;
			importedAt: string;
			contentLength: number;
			createdAt?: string;
			updatedAt?: string;
		}
	>;
};

export type ImportResult = {
	imported: number;
	skipped: number;
	failed: number;
};

export async function importToSupermemory(params: {
	dryRun?: boolean;
	verbose?: boolean;
	containerTag: string;
	manifestPath: string;
	items: PreparedImportItem[];
}): Promise<ImportResult> {
	const manifestPath = resolve(params.manifestPath);
	const manifest = await loadManifest(manifestPath);
	let imported = 0;
	let skipped = 0;
	let failed = 0;

	for (const item of params.items) {
		const hash = hashContent(item.content);
		const manifestKey = `${item.conversationId}:${hash}`;

		if (manifest.items[manifestKey]) {
			skipped += 1;
			if (params.verbose) {
				console.log(
					`Skipping already imported part ${item.part}/${item.totalParts}: ${item.title}`,
				);
			}
			continue;
		}

		if (params.dryRun) {
			imported += 1;
			console.log(
				`[dry-run] Would import ${item.title} (${item.conversationId}) part ${item.part}/${item.totalParts}`,
			);
			continue;
		}

		try {
			await saveMemory(item.content, params.containerTag);
			manifest.items[manifestKey] = {
				conversationId: item.conversationId,
				title: item.title,
				part: item.part,
				totalParts: item.totalParts,
				hash,
				importedAt: new Date().toISOString(),
				contentLength: item.content.length,
				createdAt: item.createdAt,
				updatedAt: item.updatedAt,
			};
			manifest.updatedAt = new Date().toISOString();
			await writeManifest(manifestPath, manifest);
			imported += 1;

			if (params.verbose) {
				console.log(`Imported ${item.title} (${item.part}/${item.totalParts})`);
			}
		} catch (error) {
			failed += 1;
			console.error(
				`Failed to import ${item.title} (${item.part}/${item.totalParts}): ${error instanceof Error ? error.message : String(error)}`,
			);
			break;
		}
	}

	return { imported, skipped, failed };
}

async function saveMemory(content: string, containerTag: string) {
	const process = Bun.spawnSync({
		cmd: [
			"mcporter",
			"call",
			"supermemory.memory",
			"--output",
			"json",
			"--args",
			JSON.stringify({
				content,
				action: "save",
				containerTag,
			}),
		],
		stdout: "pipe",
		stderr: "pipe",
	});

	if (process.exitCode !== 0) {
		const stderr = new TextDecoder().decode(process.stderr).trim();
		throw new Error(stderr || "mcporter call failed");
	}
}

async function loadManifest(manifestPath: string): Promise<ImportManifest> {
	const file = Bun.file(manifestPath);
	if (!(await file.exists())) {
		return {
			version: 1,
			updatedAt: new Date(0).toISOString(),
			items: {},
		};
	}

	const parsed = (await file.json()) as Partial<ImportManifest>;

	return {
		version: 1,
		updatedAt:
			typeof parsed.updatedAt === "string"
				? parsed.updatedAt
				: new Date(0).toISOString(),
		items: parsed.items ?? {},
	};
}

async function writeManifest(manifestPath: string, manifest: ImportManifest) {
	await mkdir(dirname(manifestPath), { recursive: true });
	await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function hashContent(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}
