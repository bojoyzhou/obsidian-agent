import * as React from "react";
const { useState, useCallback, useMemo } = React;
import { FileSystemAdapter, setIcon } from "obsidian";
import type { ChatMessage, MessageContent } from "../types/chat";
import type { AcpClient } from "../acp/acp-client";
import type AgentClientPlugin from "../plugin";
import { MarkdownRenderer } from "./shared/MarkdownRenderer";
import { TerminalBlock } from "./TerminalBlock";
import { ToolCallBlock } from "./ToolCallBlock";
import { LucideIcon } from "./shared/IconButton";
import { toRelativePath } from "../utils/paths";

// ---------------------------------------------------------------------------
// TextWithMentions (internal helper)
// ---------------------------------------------------------------------------

interface TextWithMentionsProps {
	text: string;
	plugin: AgentClientPlugin;
	autoMentionContext?: {
		noteName: string;
		notePath: string;
		selection?: {
			fromLine: number;
			toLine: number;
		};
	};
}

// Function to render text with @mentions and optional auto-mention
function TextWithMentions({
	text,
	plugin,
	autoMentionContext,
}: TextWithMentionsProps): React.ReactElement {
	// Match @[[filename]] format only
	const mentionRegex = /@\[\[([^\]]+)\]\]/g;
	const parts: React.ReactNode[] = [];

	// Add auto-mention badge first if provided
	if (autoMentionContext) {
		const displayText = autoMentionContext.selection
			? `@${autoMentionContext.noteName}:${autoMentionContext.selection.fromLine}-${autoMentionContext.selection.toLine}`
			: `@${autoMentionContext.noteName}`;

		parts.push(
			<span
				key="auto-mention"
				className="agent-client-text-mention"
				onClick={() => {
					void plugin.app.workspace.openLinkText(
						autoMentionContext.notePath,
						"",
					);
				}}
			>
				{displayText}
			</span>,
		);
		parts.push("\n");
	}

	let lastIndex = 0;
	let match;

	while ((match = mentionRegex.exec(text)) !== null) {
		// Add text before the mention
		if (match.index > lastIndex) {
			parts.push(text.slice(lastIndex, match.index));
		}

		// Extract filename from [[brackets]]
		const noteName = match[1];

		// Check if file actually exists
		const file = plugin.app.vault
			.getMarkdownFiles()
			.find((f) => f.basename === noteName);

		if (file) {
			// File exists - render as clickable mention
			parts.push(
				<span
					key={match.index}
					className="agent-client-text-mention"
					onClick={() => {
						void plugin.app.workspace.openLinkText(file.path, "");
					}}
				>
					@{noteName}
				</span>,
			);
		} else {
			// File doesn't exist - render as plain text
			parts.push(`@${noteName}`);
		}

		lastIndex = match.index + match[0].length;
	}

	// Add any remaining text
	if (lastIndex < text.length) {
		parts.push(text.slice(lastIndex));
	}

	return <div className="agent-client-text-with-mentions">{parts}</div>;
}

// ---------------------------------------------------------------------------
// CollapsibleThought (internal helper)
// ---------------------------------------------------------------------------

interface CollapsibleThoughtProps {
	text: string;
	plugin: AgentClientPlugin;
}

function CollapsibleThought({ text, plugin }: CollapsibleThoughtProps) {
	const [isExpanded, setIsExpanded] = useState(false);
	const showEmojis = plugin.settings.displaySettings.showEmojis;

	return (
		<div
			className="agent-client-collapsible-thought"
			onClick={() => setIsExpanded(!isExpanded)}
		>
			<div className="agent-client-collapsible-thought-header">
				{showEmojis && (
					<LucideIcon
						name="lightbulb"
						className="agent-client-collapsible-thought-label-icon"
					/>
				)}
				Thinking
				<LucideIcon
					name={isExpanded ? "chevron-down" : "chevron-right"}
					className="agent-client-collapsible-thought-icon"
				/>
			</div>
			{isExpanded && (
				<div className="agent-client-collapsible-thought-content">
					<MarkdownRenderer text={text} plugin={plugin} />
				</div>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// ContentBlock (internal helper, formerly MessageContentRenderer)
// ---------------------------------------------------------------------------

interface ContentBlockProps {
	content: MessageContent;
	plugin: AgentClientPlugin;
	messageId?: string;
	messageRole?: "user" | "assistant";
	terminalClient?: AcpClient;
	/** Callback to approve a permission request */
	onApprovePermission?: (
		requestId: string,
		optionId: string,
	) => Promise<void>;
}

function ContentBlock({
	content,
	plugin,
	messageId,
	messageRole,
	terminalClient,
	onApprovePermission,
}: ContentBlockProps) {
	switch (content.type) {
		case "text":
			// User messages: render with mention support
			// Assistant messages: render as markdown
			if (messageRole === "user") {
				return <TextWithMentions text={content.text} plugin={plugin} />;
			}
			return <MarkdownRenderer text={content.text} plugin={plugin} />;

		case "text_with_context":
			// User messages with auto-mention context
			return (
				<TextWithMentions
					text={content.text}
					autoMentionContext={content.autoMentionContext}
					plugin={plugin}
				/>
			);

		case "agent_thought":
			return <CollapsibleThought text={content.text} plugin={plugin} />;

		case "tool_call":
			return (
				<ToolCallBlock
					content={content}
					plugin={plugin}
					terminalClient={terminalClient}
					onApprovePermission={onApprovePermission}
				/>
			);

		case "plan": {
			const showEmojis = plugin.settings.displaySettings.showEmojis;
			return (
				<div className="agent-client-message-plan">
					<div className="agent-client-message-plan-title">
						{showEmojis && (
							<LucideIcon
								name="list-checks"
								className="agent-client-message-plan-label-icon"
							/>
						)}
						Plan
					</div>
					{content.entries.map((entry, idx) => (
						<div
							key={idx}
							className={`agent-client-message-plan-entry agent-client-plan-status-${entry.status}`}
						>
							{showEmojis && (
								<span
									className={`agent-client-message-plan-entry-icon agent-client-status-${entry.status}`}
								>
									<LucideIcon
										name={
											entry.status === "completed"
												? "check"
												: entry.status === "in_progress"
													? "loader"
													: "circle"
										}
									/>
								</span>
							)}{" "}
							{entry.content}
						</div>
					))}
				</div>
			);
		}

		case "terminal":
			return (
				<TerminalBlock
					terminalId={content.terminalId}
					terminalClient={terminalClient || null}
					plugin={plugin}
				/>
			);

		case "image":
			return (
				<div className="agent-client-message-image">
					<img
						src={`data:${content.mimeType};base64,${content.data}`}
						alt="Attached image"
						className="agent-client-message-image-thumbnail"
					/>
				</div>
			);

		case "resource_link":
			return (
				<div className="agent-client-message-resource-link">
					<span
						className="agent-client-message-resource-link-icon"
						ref={(el) => {
							if (el) setIcon(el, "file");
						}}
					/>
					<span className="agent-client-message-resource-link-name">
						{content.name}
					</span>
				</div>
			);

		default:
			return <span>Unsupported content type</span>;
	}
}

// ---------------------------------------------------------------------------
// MessageBubble (exported, formerly MessageRenderer)
// ---------------------------------------------------------------------------

export interface MessageBubbleProps {
	message: ChatMessage;
	plugin: AgentClientPlugin;
	terminalClient?: AcpClient;
	/** Callback to approve a permission request */
	onApprovePermission?: (
		requestId: string,
		optionId: string,
	) => Promise<void>;
}

/**
 * Extract plain text from message contents for clipboard copy.
 */
function extractTextContent(contents: MessageContent[]): string {
	return contents
		.filter((c) => c.type === "text" || c.type === "text_with_context")
		.map((c) => ("text" in c ? c.text : ""))
		.join("\n");
}

/**
 * Copy button that shows a check icon briefly after copying.
 * Uses callback ref for Obsidian's setIcon DOM manipulation.
 */
function CopyButton({ contents }: { contents: MessageContent[] }) {
	const [copied, setCopied] = useState(false);

	const handleCopy = useCallback(() => {
		const text = extractTextContent(contents);
		if (!text) return;
		void navigator.clipboard
			.writeText(text)
			.then(() => {
				setCopied(true);
				setTimeout(() => setCopied(false), 2000);
			})
			.catch(() => {});
	}, [contents]);

	const iconRef = useCallback(
		(el: HTMLButtonElement | null) => {
			if (el) setIcon(el, copied ? "check" : "copy");
		},
		[copied],
	);

	return (
		<button
			className="clickable-icon agent-client-message-action-button"
			onClick={handleCopy}
			aria-label="Copy message"
			ref={iconRef}
		/>
	);
}

const EXPLORATION_KINDS = new Set(["read", "search", "fetch", "think"]);

type ExplorationToolCall = Extract<MessageContent, { type: "tool_call" }>;

function isExplorationToolCall(c: MessageContent): c is ExplorationToolCall {
	if (c.type !== "tool_call") return false;
	if (!c.kind || !EXPLORATION_KINDS.has(c.kind)) return false;
	if (c.permissionRequest) return false;
	return true;
}

type ContentGroup =
	| { type: "attachments"; items: MessageContent[] }
	| { type: "single"; item: MessageContent }
	| { type: "exploration"; items: ExplorationToolCall[] };

/**
 * Group consecutive image/resource_link contents into attachment strips,
 * and group consecutive read-only tool calls (read/search/fetch/think) into
 * a collapsible exploration block to de-emphasize them visually.
 */
function groupContent(contents: MessageContent[]): ContentGroup[] {
	const groups: ContentGroup[] = [];
	let attachBuf: MessageContent[] = [];
	let exploreBuf: ExplorationToolCall[] = [];

	const flushAttach = () => {
		if (attachBuf.length > 0) {
			groups.push({ type: "attachments", items: attachBuf });
			attachBuf = [];
		}
	};
	const flushExplore = () => {
		if (exploreBuf.length === 0) return;
		if (exploreBuf.length >= 2) {
			groups.push({ type: "exploration", items: exploreBuf });
		} else {
			for (const item of exploreBuf) groups.push({ type: "single", item });
		}
		exploreBuf = [];
	};

	for (const content of contents) {
		if (content.type === "image" || content.type === "resource_link") {
			flushExplore();
			attachBuf.push(content);
		} else if (isExplorationToolCall(content)) {
			flushAttach();
			exploreBuf.push(content);
		} else {
			flushAttach();
			flushExplore();
			groups.push({ type: "single", item: content });
		}
	}

	flushAttach();
	flushExplore();
	return groups;
}

function getExplorationIcon(kind?: string): string {
	switch (kind) {
		case "read":
			return "book-open";
		case "search":
			return "search";
		case "fetch":
			return "globe";
		case "think":
			return "message-circle-more";
		default:
			return "hammer";
	}
}

function describeExplorationItem(item: ExplorationToolCall): {
	param?: string;
	openPath?: string;
} {
	const raw = item.rawInput as Record<string, unknown> | undefined;
	const firstLoc = item.locations?.[0]?.path;

	if (item.kind === "read" && firstLoc) {
		return { param: firstLoc, openPath: firstLoc };
	}
	if (item.kind === "fetch") {
		const url = typeof raw?.url === "string" ? raw.url : undefined;
		return { param: url };
	}
	if (item.kind === "search") {
		const pattern =
			typeof raw?.pattern === "string"
				? raw.pattern
				: typeof raw?.query === "string"
					? (raw.query as string)
					: undefined;
		return { param: pattern };
	}
	if (firstLoc) {
		return { param: firstLoc, openPath: firstLoc };
	}
	return {};
}

function ExplorationItem({
	item,
	plugin,
	vaultPath,
}: {
	item: ExplorationToolCall;
	plugin: AgentClientPlugin;
	vaultPath: string;
}) {
	const { param, openPath } = describeExplorationItem(item);
	const relativeParam = useMemo(() => {
		if (!param) return undefined;
		if (item.kind === "read" || openPath) {
			return toRelativePath(param, vaultPath);
		}
		return param;
	}, [param, openPath, vaultPath, item.kind]);
	const relativeOpenPath = useMemo(
		() => (openPath ? toRelativePath(openPath, vaultPath) : undefined),
		[openPath, vaultPath],
	);

	const handleOpen = useCallback(() => {
		if (!relativeOpenPath) return;
		void plugin.app.workspace.openLinkText(relativeOpenPath, "");
	}, [plugin, relativeOpenPath]);

	const isActive = item.status !== "completed" && item.status !== "failed";
	const isFailed = item.status === "failed";

	return (
		<div className="agent-client-exploration-item">
			<LucideIcon
				name={getExplorationIcon(item.kind)}
				className="agent-client-exploration-item-icon"
			/>
			<span className="agent-client-exploration-item-title">
				{item.title || item.kind || "step"}
			</span>
			{relativeParam &&
				(relativeOpenPath ? (
					<a
						className="agent-client-exploration-item-param agent-client-exploration-item-link"
						onClick={(e) => {
							e.preventDefault();
							handleOpen();
						}}
						href="#"
						title={relativeParam}
					>
						{relativeParam}
					</a>
				) : (
					<span
						className="agent-client-exploration-item-param"
						title={relativeParam}
					>
						{relativeParam}
					</span>
				))}
			{isActive && (
				<LucideIcon
					name="loader"
					className="agent-client-exploration-item-status agent-client-exploration-active"
				/>
			)}
			{isFailed && (
				<LucideIcon
					name="x"
					className="agent-client-exploration-item-status agent-client-exploration-item-failed"
				/>
			)}
		</div>
	);
}

function ExplorationGroup({
	items,
	plugin,
}: {
	items: ExplorationToolCall[];
	plugin: AgentClientPlugin;
	messageId: string;
	terminalClient?: AcpClient;
	onApprovePermission?: (
		requestId: string,
		optionId: string,
	) => Promise<void>;
}) {
	const hasActive = items.some((it) => it.status !== "completed");
	const [expanded, setExpanded] = useState(false);

	const vaultPath = useMemo(() => {
		const adapter = plugin.app.vault.adapter;
		if (adapter instanceof FileSystemAdapter) {
			return adapter.getBasePath();
		}
		return "";
	}, [plugin]);

	const summary = useMemo(() => {
		const byTitle = new Map<string, number>();
		for (const it of items) {
			const t = it.title || it.kind || "step";
			byTitle.set(t, (byTitle.get(t) ?? 0) + 1);
		}
		return Array.from(byTitle.entries())
			.map(([t, n]) => (n > 1 ? `${t} ×${n}` : t))
			.join(" · ");
	}, [items]);

	return (
		<div
			className={`agent-client-exploration-group${expanded ? " agent-client-exploration-expanded" : ""}`}
		>
			<button
				type="button"
				className="agent-client-exploration-header"
				onClick={() => setExpanded((v) => !v)}
				aria-expanded={expanded}
			>
				<LucideIcon
					name={expanded ? "chevron-down" : "chevron-right"}
					className="agent-client-exploration-chevron"
				/>
				<LucideIcon
					name={hasActive ? "loader" : "telescope"}
					className={`agent-client-exploration-icon${hasActive ? " agent-client-exploration-active" : ""}`}
				/>
				<span className="agent-client-exploration-count">
					Explored {items.length} {items.length === 1 ? "step" : "steps"}
				</span>
				<span className="agent-client-exploration-summary">{summary}</span>
			</button>
			{expanded && (
				<div className="agent-client-exploration-body">
					{items.map((item, idx) => (
						<ExplorationItem
							key={idx}
							item={item}
							plugin={plugin}
							vaultPath={vaultPath}
						/>
					))}
				</div>
			)}
		</div>
	);
}

export const MessageBubble = React.memo(function MessageBubble({
	message,
	plugin,
	terminalClient,
	onApprovePermission,
}: MessageBubbleProps) {
	const groups = groupContent(message.content);

	return (
		<div
			className={`agent-client-message-renderer ${message.role === "user" ? "agent-client-message-user" : "agent-client-message-assistant"}`}
		>
			{groups.map((group, idx) => {
				if (group.type === "exploration") {
					return (
						<ExplorationGroup
							key={idx}
							items={group.items}
							plugin={plugin}
							messageId={message.id}
							terminalClient={terminalClient}
							onApprovePermission={onApprovePermission}
						/>
					);
				}
				if (group.type === "attachments") {
					// Render attachments (images + resource_links) in horizontal strip
					return (
						<div
							key={idx}
							className="agent-client-message-images-strip"
						>
							{group.items.map((content, imgIdx) => (
								<ContentBlock
									key={imgIdx}
									content={content}
									plugin={plugin}
									messageId={message.id}
									messageRole={message.role}
									terminalClient={terminalClient}
									onApprovePermission={onApprovePermission}
								/>
							))}
						</div>
					);
				} else {
					// Render single non-image content
					return (
						<div key={idx}>
							<ContentBlock
								content={group.item}
								plugin={plugin}
								messageId={message.id}
								messageRole={message.role}
								terminalClient={terminalClient}
								onApprovePermission={onApprovePermission}
							/>
						</div>
					);
				}
			})}
			{message.content.some(
				(c) =>
					(c.type === "text" || c.type === "text_with_context") &&
					c.text,
			) && (
				<div className="agent-client-message-actions">
					<CopyButton contents={message.content} />
				</div>
			)}
		</div>
	);
});
