import { useRef, useCallback, useEffect } from "react";
import { Notice } from "obsidian";
import { SessionHistoryModal } from "../ui/SessionHistoryModal";
import { getLogger } from "../utils/logger";
import type AgentClientPlugin from "../plugin";
import type { UseAgentReturn } from "./useAgent";
import type { UseSessionHistoryReturn } from "./useSessionHistory";

/**
 * Hook for managing the session history modal lifecycle.
 *
 * Encapsulates modal creation, props synchronization, and
 * session operation callbacks (restore, fork, delete).
 *
 * ## Stability notes
 *
 * Previous iterations of this hook rebuilt `handleOpenHistory` and the
 * props-sync `useEffect` on nearly every render because their dep lists
 * included the full set of `sessionHistory.*` fields. That made the
 * hook's return identity churn and cascaded into upstream components,
 * which in a few reported cases caused runaway re-render loops
 * (see upstream #232's bug notes).
 *
 * We now:
 *   - Stash the latest callbacks + sessionHistory + flags in refs, so
 *     the returned `handleOpenHistory` is permanently stable.
 *   - Run the props-sync effect only when the fields that *actually*
 *     appear in the modal's props change (sessions / loading / error /
 *     hasMore / localSessionIds / flags / cwd). Handler identity is
 *     read from refs at sync time.
 *
 * @param plugin - Plugin instance for app access
 * @param agent - Agent hook for clearMessages
 * @param sessionHistory - Session history hook for operations
 * @param vaultPath - Current working directory
 * @param isSessionReady - Whether the session is ready
 * @param debugMode - Whether debug mode is enabled
 */
export function useHistoryModal(
	plugin: AgentClientPlugin,
	agent: UseAgentReturn,
	sessionHistory: UseSessionHistoryReturn,
	vaultPath: string,
	isSessionReady: boolean,
	debugMode: boolean,
	onAgentCwdChange?: (cwd: string) => void,
): {
	handleOpenHistory: () => void;
} {
	const logger = getLogger();
	const historyModalRef = useRef<SessionHistoryModal | null>(null);

	// ============================================================
	// Latest-value refs (avoid useCallback dep churn)
	// ============================================================

	const agentRef = useRef(agent);
	agentRef.current = agent;

	const sessionHistoryRef = useRef(sessionHistory);
	sessionHistoryRef.current = sessionHistory;

	const vaultPathRef = useRef(vaultPath);
	vaultPathRef.current = vaultPath;

	const isSessionReadyRef = useRef(isSessionReady);
	isSessionReadyRef.current = isSessionReady;

	const debugModeRef = useRef(debugMode);
	debugModeRef.current = debugMode;

	const onAgentCwdChangeRef = useRef(onAgentCwdChange);
	onAgentCwdChangeRef.current = onAgentCwdChange;

	// ============================================================
	// Stable handlers (deps: [] — reads through refs)
	// ============================================================

	const handleRestoreSession = useCallback(
		async (sessionId: string, cwd: string) => {
			try {
				logger.log(`[ChatPanel] Restoring session: ${sessionId}`);
				agentRef.current.clearMessages();
				await sessionHistoryRef.current.restoreSession(sessionId, cwd);
				onAgentCwdChangeRef.current?.(cwd);
				new Notice("[Agent Client] Session restored");
			} catch (error) {
				new Notice("[Agent Client] Failed to restore session");
				logger.error("Session restore error:", error);
			}
		},
		[logger],
	);

	const handleForkSession = useCallback(
		async (sessionId: string, cwd: string) => {
			try {
				logger.log(`[ChatPanel] Forking session: ${sessionId}`);
				agentRef.current.clearMessages();
				await sessionHistoryRef.current.forkSession(sessionId, cwd);
				onAgentCwdChangeRef.current?.(cwd);
				new Notice("[Agent Client] Session forked");
			} catch (error) {
				new Notice("[Agent Client] Failed to fork session");
				logger.error("Session fork error:", error);
			}
		},
		[logger],
	);

	const handleDeleteSession = useCallback(
		async (sessionId: string) => {
			try {
				logger.log(`[ChatPanel] Deleting session: ${sessionId}`);
				await sessionHistoryRef.current.deleteSession(sessionId);
				new Notice("[Agent Client] Session deleted");
			} catch (error) {
				new Notice("[Agent Client] Failed to delete session");
				logger.error("Session delete error:", error);
			}
		},
		[logger],
	);

	const handleEditTitle = useCallback(
		async (sessionId: string, newTitle: string, sessionCwd: string) => {
			try {
				await sessionHistoryRef.current.updateSessionTitle(
					sessionId,
					newTitle,
					sessionCwd,
				);
				new Notice("[Agent Client] Title updated");
			} catch (error) {
				new Notice("[Agent Client] Failed to update title");
				logger.error("Title update error:", error);
			}
		},
		[logger],
	);

	const handleLoadMore = useCallback(() => {
		void sessionHistoryRef.current.loadMoreSessions();
	}, []);

	const handleFetchSessions = useCallback((cwd?: string) => {
		void sessionHistoryRef.current.fetchSessions(cwd);
	}, []);

	// Build the modal props object from the latest refs + the incoming
	// session-history snapshot. Extracted so both the creation and the
	// sync effect share identical shape.
	const buildProps = useCallback(() => {
		const sh = sessionHistoryRef.current;
		return {
			sessions: sh.sessions,
			loading: sh.loading,
			error: sh.error,
			hasMore: sh.hasMore,
			currentCwd: vaultPathRef.current,
			canList: sh.canList,
			canRestore: sh.canRestore,
			canFork: sh.canFork,
			isUsingLocalSessions: sh.isUsingLocalSessions,
			localSessionIds: sh.localSessionIds,
			isAgentReady: isSessionReadyRef.current,
			debugMode: debugModeRef.current,
			onRestoreSession: handleRestoreSession,
			onForkSession: handleForkSession,
			onDeleteSession: handleDeleteSession,
			onEditTitle: handleEditTitle,
			onLoadMore: handleLoadMore,
			onFetchSessions: handleFetchSessions,
		};
	}, [
		handleRestoreSession,
		handleForkSession,
		handleDeleteSession,
		handleEditTitle,
		handleLoadMore,
		handleFetchSessions,
	]);

	// ============================================================
	// Open / sync
	// ============================================================

	const handleOpenHistory = useCallback(() => {
		if (!historyModalRef.current) {
			historyModalRef.current = new SessionHistoryModal(
				plugin.app,
				buildProps(),
			);
		} else {
			// Modal already exists — refresh its props before reopening so
			// the user sees the latest data immediately.
			historyModalRef.current.updateProps(buildProps());
		}
		historyModalRef.current.open();
		void sessionHistoryRef.current.fetchSessions(vaultPathRef.current);
	}, [plugin.app, buildProps]);

	// Keep modal props in sync when the *underlying data* changes. Handler
	// identities are not listed — they come through the buildProps closure
	// which only changes when a handler itself changes (stable here).
	useEffect(() => {
		if (!historyModalRef.current) return;
		historyModalRef.current.updateProps(buildProps());
	}, [
		sessionHistory.sessions,
		sessionHistory.loading,
		sessionHistory.error,
		sessionHistory.hasMore,
		sessionHistory.canList,
		sessionHistory.canRestore,
		sessionHistory.canFork,
		sessionHistory.isUsingLocalSessions,
		sessionHistory.localSessionIds,
		vaultPath,
		isSessionReady,
		debugMode,
		buildProps,
	]);

	return { handleOpenHistory };
}
