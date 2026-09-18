/**
 * Safe unknown→typed value conversions shared by the NDJSON stream
 * processor, the activity feed formatter, and the BTW output parser.
 */

export function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

export function objectValue(value: unknown): Record<string, unknown> | undefined {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return undefined;
}

/** Join the text blocks of a message `content` field (string or block array). */
export function extractTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.map((block) => objectValue(block))
		.filter((block): block is Record<string, unknown> =>
			Boolean(block && block.type === "text" && typeof block.text === "string"),
		)
		.map((block) => stringValue(block.text))
		.join("\n");
}