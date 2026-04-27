export interface LoggerConfig {
	debugMode: boolean;
}

let globalLogger: Logger | null = null;

export function initializeLogger(config: LoggerConfig): void {
	globalLogger = new Logger(config);
}

export function getLogger(): Logger {
	if (!globalLogger) {
		return new Logger({ debugMode: false });
	}
	return globalLogger;
}

/**
 * Keys whose values should be treated as secrets and masked in any log
 * output. Matches case-insensitively against env var names and object
 * property names (substring match, so e.g. ANTHROPIC_API_KEY,
 * OPENAI_API_KEY, GEMINI_API_KEY, and any custom *TOKEN / *SECRET /
 * *PASSWORD get covered by one rule).
 *
 * Even though Logger is gated by debugMode, users often share debug logs
 * in issues / screenshots. Redacting at source prevents accidental leaks.
 */
const SECRET_KEY_PATTERNS: readonly RegExp[] = [
	/api[_-]?key/i,
	/secret/i,
	/token/i,
	/password/i,
	/passwd/i,
	/authorization/i,
	/bearer/i,
];

const SECRET_PLACEHOLDER = "***";

function isSecretKey(key: string): boolean {
	return SECRET_KEY_PATTERNS.some((re) => re.test(key));
}

/**
 * Recursively redact secret-looking values from any value before logging.
 * - Plain objects and arrays are walked; other values pass through.
 * - Circular references are short-circuited to avoid infinite loops.
 * - Redacts only non-empty string/number secret values (so `apiKey: ""`
 *   still shows as empty, which is useful diagnostic info).
 */
export function redactSecrets(value: unknown, seen?: WeakSet<object>): unknown {
	if (value === null || value === undefined) return value;
	if (typeof value !== "object") return value;

	// Now narrowed to `object`.
	const obj: object = value;

	const visited = seen ?? new WeakSet<object>();
	if (visited.has(obj)) {
		return "[Circular]";
	}
	visited.add(obj);

	if (Array.isArray(obj)) {
		return obj.map((item: unknown) => redactSecrets(item, visited));
	}

	// Preserve special objects (Error, Date, Map, Set, etc.) as-is.
	// Only walk plain data objects.
	const proto = Object.getPrototypeOf(obj) as object | null;
	if (proto !== Object.prototype && proto !== null) {
		return value;
	}

	const result: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
		if (
			isSecretKey(k) &&
			(typeof v === "string" || typeof v === "number") &&
			String(v).length > 0
		) {
			result[k] = SECRET_PLACEHOLDER;
		} else {
			result[k] = redactSecrets(v, visited);
		}
	}
	return result;
}

export class Logger {
	constructor(private config: LoggerConfig) {}

	log(...args: unknown[]): void {
		if (this.config.debugMode) {
			console.debug(...args.map((a) => redactSecrets(a)));
		}
	}

	error(...args: unknown[]): void {
		if (this.config.debugMode) {
			console.error(...args.map((a) => redactSecrets(a)));
		}
	}

	warn(...args: unknown[]): void {
		if (this.config.debugMode) {
			console.warn(...args.map((a) => redactSecrets(a)));
		}
	}

	info(...args: unknown[]): void {
		if (this.config.debugMode) {
			console.debug(...args.map((a) => redactSecrets(a)));
		}
	}
}
