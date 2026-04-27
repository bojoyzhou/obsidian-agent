import * as React from "react";
const { useRef, useEffect, useImperativeHandle, forwardRef } = React;
import { setIcon } from "obsidian";

/**
 * Renders an Obsidian Lucide icon via setIcon().
 * Used as a replacement for emoji icons to match Obsidian's native UI.
 */
export function LucideIcon({
	name,
	className,
}: {
	name: string;
	className?: string;
}) {
	const ref = useRef<HTMLSpanElement>(null);

	useEffect(() => {
		if (ref.current) {
			setIcon(ref.current, name);
		}
	}, [name]);

	return <span ref={ref} className={className} />;
}

interface HeaderButtonProps {
	iconName: string;
	tooltip: string;
	onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
}

export const HeaderButton = forwardRef<HTMLButtonElement, HeaderButtonProps>(
	function HeaderButton({ iconName, tooltip, onClick }, ref) {
		const buttonRef = useRef<HTMLButtonElement>(null);

		// Expose the button ref to parent components
		useImperativeHandle(ref, () => buttonRef.current!, []);

		useEffect(() => {
			if (buttonRef.current) {
				setIcon(buttonRef.current, iconName);
			}
		}, [iconName]);

		return (
			<button
				ref={buttonRef}
				title={tooltip}
				onClick={onClick}
				className="clickable-icon agent-client-header-button"
			/>
		);
	},
);

interface IconActionButtonProps {
	/** Lucide icon name — setIcon() only reruns when this changes. */
	iconName: string;
	/** Extra class to merge with the button element. */
	className?: string;
	/** Native title/tooltip text. */
	title?: string;
	/** Accessible label (aria-label) for icon-only buttons. */
	ariaLabel?: string;
	/** Click handler. */
	onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
	/** Whether the button is disabled. */
	disabled?: boolean;
	/** Button type — defaults to "button" so it never submits forms. */
	type?: "button" | "submit" | "reset";
}

/**
 * Plain icon-only button that uses setIcon() via useEffect, so the underlying
 * `<svg>` is only rebuilt when `iconName` actually changes.
 *
 * Prefer this over inline `ref={(el) => setIcon(el, ...)}` patterns — inline
 * refs recreate the SVG on every render, which can swallow clicks when
 * mousedown and mouseup straddle a re-render (upstream #232).
 */
export const IconActionButton = forwardRef<
	HTMLButtonElement,
	IconActionButtonProps
>(function IconActionButton(
	{ iconName, className, title, ariaLabel, onClick, disabled, type },
	ref,
) {
	const buttonRef = useRef<HTMLButtonElement>(null);
	useImperativeHandle(ref, () => buttonRef.current!, []);

	useEffect(() => {
		if (buttonRef.current) {
			setIcon(buttonRef.current, iconName);
		}
	}, [iconName]);

	return (
		<button
			ref={buttonRef}
			className={className}
			title={title}
			aria-label={ariaLabel}
			onClick={onClick}
			disabled={disabled}
			type={type ?? "button"}
		/>
	);
});
