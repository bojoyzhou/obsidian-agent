/**
 * Error boundary wrapping message-rendering subtrees.
 *
 * Without this, a single malformed tool_call / markdown / rendering bug
 * would crash the entire chat view. Instead we render a recoverable fallback
 * with a "Reload" action.
 */

import * as React from "react";
import { getLogger } from "../../utils/logger";

interface Props {
	/** Subtree to guard. */
	children: React.ReactNode;
	/**
	 * Optional label included in logs and fallback UI (e.g. "message list").
	 * Helps users report bugs when multiple boundaries exist in the tree.
	 */
	label?: string;
	/**
	 * Called when the user clicks "Retry" in the fallback UI. If omitted,
	 * the boundary simply resets its own error state and re-renders children.
	 */
	onRetry?: () => void;
}

interface State {
	error: Error | null;
}

export class ChatErrorBoundary extends React.Component<Props, State> {
	constructor(props: Props) {
		super(props);
		this.state = { error: null };
	}

	static getDerivedStateFromError(error: Error): State {
		return { error };
	}

	componentDidCatch(error: Error, info: React.ErrorInfo): void {
		const logger = getLogger();
		logger.error(
			`[ChatErrorBoundary${
				this.props.label ? `:${this.props.label}` : ""
			}]`,
			error,
			info.componentStack,
		);
	}

	private handleRetry = (): void => {
		this.setState({ error: null });
		this.props.onRetry?.();
	};

	render(): React.ReactNode {
		const { error } = this.state;
		if (!error) return this.props.children;

		const label = this.props.label ?? "chat view";
		return (
			<div className="agent-client-error-boundary">
				<div className="agent-client-error-boundary-title">
					Something went wrong in the {label}.
				</div>
				<div className="agent-client-error-boundary-message">
					{error.message || String(error)}
				</div>
				<button
					type="button"
					className="agent-client-error-boundary-retry"
					onClick={this.handleRetry}
				>
					Retry
				</button>
			</div>
		);
	}
}
