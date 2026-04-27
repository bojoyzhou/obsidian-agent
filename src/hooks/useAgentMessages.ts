/**
 * Sub-hook for managing chat messages, streaming, and permissions.
 *
 * Handles message state, RAF batching for streaming updates,
 * send/receive operations, and permission approve/reject.
 *
 * ## Multi-session state model
 *
 * A single view may switch between multiple agent sessions (via session
 * history / new chat). While one session is streaming and the user switches
 * to another, the background session keeps receiving updates — we don't want
 * to drop its loading state or its incoming chunks when the user returns.
 *
 * To achieve this, per-session state is kept in `sessionStatesRef` (messages,
 * isSending, lastUserMessage, toolCallIndex, pending RAF buffer, etc.).
 * Incoming session updates are dispatched by `update.sessionId` and applied
 * to the matching slot. Only the *active* session's slot is mirrored into
 * React state so the UI re-renders for it; background slots mutate silently
 * and are restored on switch.
 */

import * as React from "react";
const { useState, useCallback, useMemo, useRef, useEffect } = React;

import type {
	ChatMessage,
	MessageContent,
	ActivePermission,
	ImagePromptContent,
	ResourceLinkPromptContent,
} from "../types/chat";
import type { ChatSession, SessionUpdate } from "../types/session";
import type { AcpClient } from "../acp/acp-client";
import type { IVaultAccess, NoteMetadata } from "../services/vault-service";
import type { ISettingsAccess } from "../services/settings-service";
import type { ErrorInfo } from "../types/errors";
import type { IMentionService } from "../utils/mention-parser";
import { preparePrompt, sendPreparedPrompt } from "../services/message-sender";
import { Platform } from "obsidian";
import {
	rebuildToolCallIndex,
	applySingleUpdate,
	findActivePermission,
	selectOption,
} from "../services/message-state";

// ============================================================================
// Types
// ============================================================================

/**
 * Options for sending a message.
 */
export interface SendMessageOptions {
	/** Currently active note for auto-mention */
	activeNote: NoteMetadata | null;
	/** Vault base path for mention resolution */
	vaultBasePath: string;
	/** Whether auto-mention is temporarily disabled */
	isAutoMentionDisabled?: boolean;
	/** Attached images (Base64 embedded) */
	images?: ImagePromptContent[];
	/** Attached file references (resource links) */
	resourceLinks?: ResourceLinkPromptContent[];
}

export interface UseAgentMessagesReturn {
	// Message state
	messages: ChatMessage[];
	isSending: boolean;
	lastUserMessage: string | null;

	/**
	 * Set of session IDs that currently have an in-flight agent turn.
	 *
	 * Updated whenever any (active or background) session transitions
	 * between idle ↔ busy. Useful for UI surfaces that list multiple
	 * sessions (e.g. the session history modal) and need to show a
	 * "running" badge per entry.
	 *
	 * Identity is stable while membership is unchanged — consumers may
	 * use it as a React dep without causing spurious re-renders.
	 */
	busySessionIds: ReadonlySet<string>;

	// Message operations
	sendMessage: (
		content: string,
		options: SendMessageOptions,
	) => Promise<void>;
	/** Immediately reset sending state; used when user cancels generation */
	cancelSend: () => void;
	clearMessages: () => void;
	setInitialMessages: (
		history: Array<{
			role: string;
			content: Array<{ type: string; text: string }>;
			timestamp?: string;
		}>,
	) => void;
	setMessagesFromLocal: (localMessages: ChatMessage[]) => void;
	clearError: () => void;
	setIgnoreUpdates: (ignore: boolean) => void;

	// Permission
	activePermission: ActivePermission | null;
	hasActivePermission: boolean;
	approvePermission: (requestId: string, optionId: string) => Promise<void>;
	approveActivePermission: () => Promise<boolean>;
	rejectActivePermission: () => Promise<boolean>;

	/** Enqueue a message-level update (used by useAgent for unified handler) */
	enqueueUpdate: (update: SessionUpdate) => void;
}

/**
 * Per-session state slot.
 *
 * Each tracked session has one of these, regardless of whether it is
 * currently the active/visible session. Background sessions accumulate
 * chunks here and are restored when the user switches back.
 */
interface SessionSlot {
	messages: ChatMessage[];
	isSending: boolean;
	lastUserMessage: string | null;
	toolCallIndex: Map<string, number>;
	/**
	 * True when the user has cancelled the in-flight send for this session.
	 * Any late-arriving prompt() resolution is ignored so state isn't
	 * clobbered by a stale agent response.
	 */
	sendAborted: boolean;
	/**
	 * Timestamp (ms) of the most recent cancel. Streaming updates that
	 * arrive within CANCEL_GRACE_MS of this timestamp are dropped — some
	 * agents keep pushing chunks for a short while after session/cancel,
	 * which would otherwise cause duplicated content on the next turn
	 * (see upstream issue #155).
	 */
	cancelledAt: number | null;
	/**
	 * Pending updates to apply on the next RAF flush.
	 * Background sessions keep buffering; when user switches to this session
	 * we flush immediately so there's no catch-up flicker.
	 */
	pendingUpdates: SessionUpdate[];
	/**
	 * When true, incoming updates are dropped (used during session/load
	 * replay to avoid mixing agent-side history with local-stored messages).
	 */
	ignoreUpdates: boolean;
}

function createEmptySlot(): SessionSlot {
	return {
		messages: [],
		isSending: false,
		lastUserMessage: null,
		toolCallIndex: new Map(),
		sendAborted: false,
		cancelledAt: null,
		pendingUpdates: [],
		ignoreUpdates: false,
	};
}

/**
 * Grace period after a cancel during which incoming streaming chunks are
 * dropped. Some agents keep pushing a handful of chunks after honoring
 * session/cancel; without this window they would render into the next turn.
 */
const CANCEL_GRACE_MS = 1500;

/**
 * Update types that represent streaming content. Only these are dropped
 * during the post-cancel grace window — non-content updates (mode,
 * config, usage, available_commands, session_info) remain useful.
 */
const STREAMING_UPDATE_TYPES = new Set<SessionUpdate["type"]>([
	"agent_message_chunk",
	"agent_thought_chunk",
	"user_message_chunk",
	"tool_call",
	"tool_call_update",
	"plan",
]);

export interface UseAgentMessagesOptions {
	/**
	 * Called when a session's turn completes successfully (isSending: true →
	 * false) with the final message list for that session. Fires for
	 * background sessions too, so message persistence isn't lost when the
	 * user switches views while a send is in flight.
	 */
	onSessionTurnEnd?: (sessionId: string, messages: ChatMessage[]) => void;
}

// ============================================================================
// Hook Implementation
// ============================================================================

export function useAgentMessages(
	agentClient: AcpClient,
	settingsAccess: ISettingsAccess,
	vaultAccess: IVaultAccess & IMentionService,
	session: ChatSession,
	setErrorInfo: (error: ErrorInfo | null) => void,
	options?: UseAgentMessagesOptions,
): UseAgentMessagesReturn {
	// Keep the latest onSessionTurnEnd in a ref so sendMessage's closure
	// always sees the current callback without being re-created.
	const onSessionTurnEndRef = useRef(options?.onSessionTurnEnd);
	onSessionTurnEndRef.current = options?.onSessionTurnEnd;

	// ============================================================
	// Per-session state map (authoritative store)
	// ============================================================

	const sessionStatesRef = useRef<Map<string, SessionSlot>>(new Map());

	// Slot for updates that arrive before the session is created, or
	// detached operations (rare). Indexed by empty string sentinel.
	const ORPHAN_KEY = "__orphan__";

	const getSlot = useCallback((sessionId: string | null): SessionSlot => {
		const key = sessionId ?? ORPHAN_KEY;
		let slot = sessionStatesRef.current.get(key);
		if (!slot) {
			slot = createEmptySlot();
			sessionStatesRef.current.set(key, slot);
		}
		return slot;
	}, []);

	// ============================================================
	// React-mirrored state for the *active* session
	// ============================================================

	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [isSending, setIsSending] = useState(false);
	const [lastUserMessage, setLastUserMessage] = useState<string | null>(null);

	/**
	 * Session IDs with an in-flight turn. Mirrored from per-slot
	 * `isSending` so React consumers (e.g. session history modal) can
	 * highlight running sessions without poking at the ref map directly.
	 *
	 * Kept as an immutable Set — every flip allocates a fresh instance so
	 * shallow equality still triggers React updates while the *identity*
	 * remains stable when membership is unchanged (see setSessionBusy).
	 */
	const [busySessionIds, setBusySessionIds] = useState<ReadonlySet<string>>(
		() => new Set<string>(),
	);

	/**
	 * Atomically flip a session's busy flag on both the per-slot store
	 * and the React-visible `busySessionIds` set. Always call this
	 * instead of mutating `slot.isSending` directly when the change
	 * should be observable from outside this hook (i.e. every time).
	 *
	 * The slot mirror stays in sync with React state. Both the active
	 * and background sessions flow through here.
	 */
	const setSessionBusy = useCallback(
		(sessionId: string | null | undefined, busy: boolean) => {
			// Track the slot regardless (so cancelSend, clearMessages etc.
			// still reset it even for orphan/legacy paths), but only
			// expose *real* session IDs through React state — the empty
			// string / null sentinel is an internal bookkeeping detail.
			const slot = getSlot(sessionId ?? null);
			slot.isSending = busy;

			if (!sessionId) return;

			setBusySessionIds((prev) => {
				const has = prev.has(sessionId);
				if (has === busy) return prev;
				const next = new Set(prev);
				if (busy) {
					next.add(sessionId);
				} else {
					next.delete(sessionId);
				}
				return next;
			});
		},
		[getSlot],
	);

	// Track the currently rendered sessionId so streaming flushes only
	// re-render when relevant.
	const activeSessionIdRef = useRef<string | null>(session.sessionId);

	// ============================================================
	// Session switching: save old slot / restore new slot
	// ============================================================

	useEffect(() => {
		const newId = session.sessionId;
		if (activeSessionIdRef.current === newId) return;

		// Save the latest React state back into the slot for the previous
		// session (so a switch-back later sees the freshest messages even
		// if RAF had not yet flushed).
		const prevId = activeSessionIdRef.current;
		if (prevId) {
			const prevSlot = sessionStatesRef.current.get(prevId);
			if (prevSlot) {
				prevSlot.messages = messages;
				prevSlot.isSending = isSending;
				prevSlot.lastUserMessage = lastUserMessage;
			}
		}

		activeSessionIdRef.current = newId;

		// Restore the new session's slot into React state.
		const nextSlot = newId
			? sessionStatesRef.current.get(newId)
			: undefined;
		if (nextSlot) {
			// Drain any pending updates so the user sees fully up-to-date
			// state immediately (no RAF catch-up flicker).
			if (nextSlot.pendingUpdates.length > 0) {
				let next = nextSlot.messages;
				for (const u of nextSlot.pendingUpdates) {
					next = applySingleUpdate(next, u, nextSlot.toolCallIndex);
				}
				nextSlot.messages = next;
				nextSlot.pendingUpdates = [];
			}
			setMessages(nextSlot.messages);
			setIsSending(nextSlot.isSending);
			setLastUserMessage(nextSlot.lastUserMessage);
		} else {
			// Brand new session (not tracked yet) — clean UI state.
			setMessages([]);
			setIsSending(false);
			setLastUserMessage(null);
		}
		// Intentionally exclude messages/isSending/lastUserMessage from deps:
		// the effect must only re-run on sessionId change. We use the latest
		// values via closure capture at switch-time, which is correct.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [session.sessionId]);

	// ============================================================
	// Streaming Update Batching (RAF)
	// ============================================================

	const flushScheduledRef = useRef(false);

	const flushPendingUpdates = useCallback(() => {
		flushScheduledRef.current = false;
		const activeId = activeSessionIdRef.current;

		// Apply pending updates to every slot that has any.
		// The active slot's result is mirrored to React state; background
		// slots mutate silently.
		let activeChanged = false;
		let activeResult: ChatMessage[] | null = null;

		sessionStatesRef.current.forEach((slot, sessionId) => {
			if (slot.pendingUpdates.length === 0) return;
			let next = slot.messages;
			for (const u of slot.pendingUpdates) {
				next = applySingleUpdate(next, u, slot.toolCallIndex);
			}
			slot.pendingUpdates = [];
			slot.messages = next;

			if (sessionId === activeId) {
				activeChanged = true;
				activeResult = next;
			}
		});

		if (activeChanged && activeResult !== null) {
			setMessages(activeResult);
		}
	}, []);

	const scheduleFlush = useCallback(() => {
		if (!flushScheduledRef.current) {
			flushScheduledRef.current = true;
			requestAnimationFrame(flushPendingUpdates);
		}
	}, [flushPendingUpdates]);

	const enqueueUpdate = useCallback(
		(update: SessionUpdate) => {
			const slot = getSlot(update.sessionId || null);
			if (slot.ignoreUpdates) return;

			// Drop streaming "tail" chunks that arrive shortly after a
			// cancel. Non-streaming updates (mode/config/usage/etc.) still
			// pass through so session metadata stays fresh.
			if (
				slot.cancelledAt !== null &&
				STREAMING_UPDATE_TYPES.has(update.type) &&
				Date.now() - slot.cancelledAt < CANCEL_GRACE_MS
			) {
				return;
			}

			slot.pendingUpdates.push(update);
			scheduleFlush();
		},
		[getSlot, scheduleFlush],
	);

	// Clean up on unmount
	useEffect(() => {
		return () => {
			flushScheduledRef.current = false;
			sessionStatesRef.current.clear();
		};
	}, []);

	// ============================================================
	// Message Operations (all act on the currently active session)
	// ============================================================

	const setIgnoreUpdates = useCallback(
		(ignore: boolean): void => {
			const slot = getSlot(activeSessionIdRef.current);
			slot.ignoreUpdates = ignore;
		},
		[getSlot],
	);

	const clearMessages = useCallback((): void => {
		const activeId = activeSessionIdRef.current;
		const slot = getSlot(activeId);

		// Preserve the live in-memory state when a stream is still running.
		// This protects the "switch away → agent still replies → switch back"
		// path against stale clears from session-history restore flows.
		if (slot.isSending) {
			return;
		}

		slot.sendAborted = true;
		slot.messages = [];
		slot.toolCallIndex.clear();
		slot.lastUserMessage = null;
		setSessionBusy(activeId, false);
		slot.pendingUpdates = [];

		setMessages([]);
		setLastUserMessage(null);
		setIsSending(false);
		setErrorInfo(null);
	}, [getSlot, setErrorInfo, setSessionBusy]);

	const setInitialMessages = useCallback(
		(
			history: Array<{
				role: string;
				content: Array<{ type: string; text: string }>;
				timestamp?: string;
			}>,
		): void => {
			const chatMessages: ChatMessage[] = history.map((msg) => ({
				id: crypto.randomUUID(),
				role: msg.role as "user" | "assistant",
				content: msg.content.map((c) => ({
					type: c.type as "text",
					text: c.text,
				})),
				timestamp: msg.timestamp ? new Date(msg.timestamp) : new Date(),
			}));

			const activeId = activeSessionIdRef.current;
			const slot = getSlot(activeId);
			slot.messages = chatMessages;
			slot.toolCallIndex.clear();
			rebuildToolCallIndex(chatMessages, slot.toolCallIndex);
			setSessionBusy(activeId, false);
			slot.pendingUpdates = [];

			setMessages(chatMessages);
			setIsSending(false);
			setErrorInfo(null);
		},
		[getSlot, setErrorInfo, setSessionBusy],
	);

	const setMessagesFromLocal = useCallback(
		(localMessages: ChatMessage[]): void => {
			const activeId = activeSessionIdRef.current;
			const slot = getSlot(activeId);

			// If this session is currently streaming in memory (the user
			// switched away and came back while the turn is still running),
			// keep the in-memory state — the local-storage copy is
			// necessarily stale (persistence happens only at turn end).
			if (slot.isSending) {
				return;
			}

			slot.messages = localMessages;
			slot.toolCallIndex.clear();
			rebuildToolCallIndex(localMessages, slot.toolCallIndex);
			setSessionBusy(activeId, false);
			slot.pendingUpdates = [];

			setMessages(localMessages);
			setIsSending(false);
			setErrorInfo(null);
		},
		[getSlot, setErrorInfo, setSessionBusy],
	);

	const clearError = useCallback((): void => {
		setErrorInfo(null);
	}, [setErrorInfo]);

	const shouldConvertToWsl = useMemo(() => {
		const settings = settingsAccess.getSnapshot();
		return Platform.isWin && settings.windowsWslMode;
	}, [settingsAccess]);

	const sendMessage = useCallback(
		async (content: string, options: SendMessageOptions): Promise<void> => {
			if (!session.sessionId) {
				setErrorInfo({
					title: "Cannot Send Message",
					message: "No active session. Please wait for connection.",
				});
				return;
			}

			// Capture the session this send belongs to — subsequent
			// state writes must target this slot even if the user has
			// switched to a different session by the time the agent replies.
			const targetSessionId = session.sessionId;
			const targetSlot = getSlot(targetSessionId);

			const settings = settingsAccess.getSnapshot();

			const prepared = await preparePrompt(
				{
					message: content,
					images: options.images,
					resourceLinks: options.resourceLinks,
					activeNote: options.activeNote,
					vaultBasePath: options.vaultBasePath,
					isAutoMentionDisabled: options.isAutoMentionDisabled,
					convertToWsl: shouldConvertToWsl,
					supportsEmbeddedContext:
						session.promptCapabilities?.embeddedContext ?? false,
					maxNoteLength: settings.displaySettings.maxNoteLength,
					maxSelectionLength:
						settings.displaySettings.maxSelectionLength,
				},
				vaultAccess,
				vaultAccess, // IMentionService (same object)
			);

			const userMessageContent: MessageContent[] = [];

			if (prepared.autoMentionContext) {
				userMessageContent.push({
					type: "text_with_context",
					text: content,
					autoMentionContext: prepared.autoMentionContext,
				});
			} else {
				userMessageContent.push({
					type: "text",
					text: content,
				});
			}

			if (options.images && options.images.length > 0) {
				for (const img of options.images) {
					userMessageContent.push({
						type: "image",
						data: img.data,
						mimeType: img.mimeType,
					});
				}
			}

			if (options.resourceLinks && options.resourceLinks.length > 0) {
				for (const link of options.resourceLinks) {
					userMessageContent.push({
						type: "resource_link",
						uri: link.uri,
						name: link.name,
						mimeType: link.mimeType,
						size: link.size,
					});
				}
			}

			const userMessage: ChatMessage = {
				id: crypto.randomUUID(),
				role: "user",
				content: userMessageContent,
				timestamp: new Date(),
			};

			// Mutate the slot first so background switches observe consistent state.
			targetSlot.messages = [...targetSlot.messages, userMessage];
			targetSlot.sendAborted = false;
			targetSlot.cancelledAt = null;
			setSessionBusy(targetSessionId, true);
			targetSlot.lastUserMessage = content;

			// Mirror to React state only if this slot is still active.
			if (activeSessionIdRef.current === targetSessionId) {
				setMessages(targetSlot.messages);
				setIsSending(true);
				setLastUserMessage(content);
			}

			try {
				const result = await sendPreparedPrompt(
					{
						sessionId: targetSessionId,
						agentContent: prepared.agentContent,
						displayContent: prepared.displayContent,
						authMethods: session.authMethods,
					},
					agentClient,
				);

				if (targetSlot.sendAborted) {
					// User cancelled this send; UI already reset.
					return;
				}

				if (result.success) {
					// Flush any pending RAF-buffered updates for this slot
					// so the persisted messages reflect the full turn.
					if (targetSlot.pendingUpdates.length > 0) {
						let next = targetSlot.messages;
						for (const u of targetSlot.pendingUpdates) {
							next = applySingleUpdate(
								next,
								u,
								targetSlot.toolCallIndex,
							);
						}
						targetSlot.messages = next;
						targetSlot.pendingUpdates = [];
						if (activeSessionIdRef.current === targetSessionId) {
							setMessages(next);
						}
					}
					setSessionBusy(targetSessionId, false);
					targetSlot.lastUserMessage = null;
					if (activeSessionIdRef.current === targetSessionId) {
						setIsSending(false);
						setLastUserMessage(null);
					}
					// Persist for this session (even if user has switched away).
					onSessionTurnEndRef.current?.(
						targetSessionId,
						targetSlot.messages,
					);
				} else {
					setSessionBusy(targetSessionId, false);
					if (activeSessionIdRef.current === targetSessionId) {
						setIsSending(false);
						setErrorInfo(
							result.error
								? {
										title: result.error.title,
										message: result.error.message,
										suggestion: result.error.suggestion,
									}
								: {
										title: "Send Message Failed",
										message: "Failed to send message",
									},
						);
					}
				}
			} catch (error) {
				if (targetSlot.sendAborted) {
					return;
				}
				setSessionBusy(targetSessionId, false);
				if (activeSessionIdRef.current === targetSessionId) {
					setIsSending(false);
					setErrorInfo({
						title: "Send Message Failed",
						message: `Failed to send message: ${error instanceof Error ? error.message : String(error)}`,
					});
				}
			}
		},
		[
			agentClient,
			vaultAccess,
			settingsAccess,
			session.sessionId,
			session.authMethods,
			session.promptCapabilities,
			shouldConvertToWsl,
			getSlot,
			setErrorInfo,
			setSessionBusy,
		],
	);

	/**
	 * Cancel the in-flight send for the *currently active* session.
	 *
	 * The ACP `session/cancel` notification is fire-and-forget — some agents
	 * don't promptly respond, which would otherwise leave `isSending` stuck
	 * as true until the `connection.prompt()` promise eventually resolves.
	 * This resets UI state immediately and marks the send as aborted so a
	 * late-arriving result won't re-enable `isSending` or surface a stale
	 * error.
	 */
	const cancelSend = useCallback((): void => {
		const activeId = activeSessionIdRef.current;
		const slot = getSlot(activeId);
		slot.sendAborted = true;
		slot.cancelledAt = Date.now();
		setSessionBusy(activeId, false);
		slot.lastUserMessage = null;
		// Purge any already-enqueued streaming chunks that would otherwise
		// render after we've marked the turn as stopped.
		slot.pendingUpdates = slot.pendingUpdates.filter(
			(u) => !STREAMING_UPDATE_TYPES.has(u.type),
		);
		setIsSending(false);
		setLastUserMessage(null);
	}, [getSlot, setSessionBusy]);

	// ============================================================
	// Permission State & Operations
	// ============================================================

	const activePermission = useMemo(
		() => findActivePermission(messages),
		[messages],
	);

	const hasActivePermission = activePermission !== null;

	const approvePermission = useCallback(
		async (requestId: string, optionId: string): Promise<void> => {
			try {
				await agentClient.respondToPermission(requestId, optionId);
			} catch (error) {
				setErrorInfo({
					title: "Permission Error",
					message: `Failed to respond to permission request: ${error instanceof Error ? error.message : String(error)}`,
				});
			}
		},
		[agentClient, setErrorInfo],
	);

	const approveActivePermission = useCallback(async (): Promise<boolean> => {
		if (!activePermission || activePermission.options.length === 0)
			return false;
		const option = selectOption(activePermission.options, [
			"allow_once",
			"allow_always",
		]);
		if (!option) return false;
		await approvePermission(activePermission.requestId, option.optionId);
		return true;
	}, [activePermission, approvePermission]);

	const rejectActivePermission = useCallback(async (): Promise<boolean> => {
		if (!activePermission || activePermission.options.length === 0)
			return false;
		const option = selectOption(
			activePermission.options,
			["reject_once", "reject_always"],
			(opt) =>
				opt.name.toLowerCase().includes("reject") ||
				opt.name.toLowerCase().includes("deny"),
		);
		if (!option) return false;
		await approvePermission(activePermission.requestId, option.optionId);
		return true;
	}, [activePermission, approvePermission]);

	// ============================================================
	// Return
	// ============================================================

	return {
		messages,
		isSending,
		lastUserMessage,
		busySessionIds,
		sendMessage,
		cancelSend,
		clearMessages,
		setInitialMessages,
		setMessagesFromLocal,
		clearError,
		setIgnoreUpdates,
		activePermission,
		hasActivePermission,
		approvePermission,
		approveActivePermission,
		rejectActivePermission,
		enqueueUpdate,
	};
}
