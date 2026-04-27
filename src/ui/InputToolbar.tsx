import * as React from "react";
const { useRef, useEffect, useCallback } = React;
import { setIcon, DropdownComponent, App } from "obsidian";

import {
	flattenConfigSelectOptions,
	type SessionModeState,
	type SessionModelState,
	type SessionUsage,
	type SessionConfigOption,
	type SessionConfigSelectGroup,
} from "../types/session";
import {
	SearchablePickerModal,
	type PickerOption,
} from "./SearchablePickerModal";

// ============================================================================
// Searchable picker threshold
// ============================================================================

/**
 * When a selector has more than this many options, we swap the native
 * DropdownComponent for a FuzzySuggestModal-based picker. Lists of 50+
 * models (e.g. OpenRouter) are painful to scroll — see issue #229.
 * Small lists (mode: usually 2–4, provider lists: 5–10) keep the inline
 * dropdown so users don't pay a modal-roundtrip cost for trivial choices.
 */
const SEARCHABLE_PICKER_THRESHOLD = 12;

// ============================================================================
// Obsidian Dropdown Hook
// ============================================================================

/**
 * Hook for managing an Obsidian DropdownComponent lifecycle.
 * Handles creation, option population, value sync, and cleanup.
 *
 * Only used for short option lists; large lists are rendered via the
 * searchable picker modal instead.
 */
function useObsidianDropdown(
	containerRef: React.RefObject<HTMLDivElement | null>,
	options: Array<{ value: string; label: string }> | undefined,
	currentValue: string | undefined,
	onChangeRef: React.RefObject<((value: string) => void) | undefined>,
	enabled: boolean,
): void {
	const instanceRef = useRef<DropdownComponent | null>(null);

	// Create/destroy dropdown when options change
	useEffect(() => {
		const containerEl = containerRef.current;
		if (!containerEl) return;

		if (!enabled || !options || options.length <= 1) {
			if (instanceRef.current) {
				containerEl.empty();
				instanceRef.current = null;
			}
			return;
		}

		if (!instanceRef.current) {
			const dropdown = new DropdownComponent(containerEl);
			instanceRef.current = dropdown;

			for (const opt of options) {
				dropdown.addOption(opt.value, opt.label);
			}

			if (currentValue) {
				dropdown.setValue(currentValue);
			}

			dropdown.onChange((value) => {
				onChangeRef.current?.(value);
			});
		}

		return () => {
			if (instanceRef.current) {
				containerEl.empty();
				instanceRef.current = null;
			}
		};
	}, [options, containerRef, onChangeRef, currentValue, enabled]);

	// Sync value when it changes externally
	useEffect(() => {
		if (instanceRef.current && currentValue) {
			instanceRef.current.setValue(currentValue);
		}
	}, [currentValue]);
}

// ============================================================================
// Searchable Selector Button (used when option count > threshold)
// ============================================================================

interface SearchableSelectorButtonProps {
	app: App;
	options: PickerOption[];
	currentValue: string | undefined;
	onChange: (value: string) => void;
	placeholder: string;
	cssClass?: string;
	titleText?: string;
}

function SearchableSelectorButton({
	app,
	options,
	currentValue,
	onChange,
	placeholder,
	cssClass,
	titleText,
}: SearchableSelectorButtonProps) {
	const buttonRef = useRef<HTMLButtonElement>(null);
	const iconRef = useRef<HTMLSpanElement>(null);
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;

	// Resolve current label for button text
	const currentLabel = (() => {
		const match = options.find((o) => o.value === currentValue);
		if (!match) return placeholder;
		return match.group ? `${match.group} / ${match.label}` : match.label;
	})();

	useEffect(() => {
		if (iconRef.current) {
			setIcon(iconRef.current, "chevron-down");
		}
	}, []);

	const openPicker = useCallback(() => {
		const modal = new SearchablePickerModal(
			app,
			options,
			currentValue,
			(value) => onChangeRef.current(value),
			placeholder,
		);
		modal.open();
	}, [app, options, currentValue, placeholder]);

	return (
		<div
			className={`agent-client-searchable-selector ${cssClass ?? ""}`}
			title={titleText ?? placeholder}
		>
			<button
				ref={buttonRef}
				type="button"
				className="agent-client-searchable-selector-button"
				onClick={openPicker}
			>
				<span className="agent-client-searchable-selector-label">
					{currentLabel}
				</span>
				<span
					ref={iconRef}
					className="agent-client-searchable-selector-icon"
				/>
			</button>
		</div>
	);
}

// ============================================================================
// Utility Functions
// ============================================================================

/** Format token count for display (e.g., 21367 → "21.4K", 200000 → "200K") */
function formatTokenCount(tokens: number): string {
	if (tokens < 1000) return String(tokens);
	const k = tokens / 1000;
	return k >= 100 ? `${Math.round(k)}K` : `${k.toFixed(1)}K`;
}

/** Get CSS class for usage percentage color thresholds */
function getUsageColorClass(percentage: number): string {
	if (percentage >= 90) return "agent-client-usage-danger";
	if (percentage >= 80) return "agent-client-usage-warning";
	if (percentage >= 70) return "agent-client-usage-caution";
	return "agent-client-usage-normal";
}

// ============================================================================
// InputToolbar
// ============================================================================

export interface InputToolbarProps {
	isSending: boolean;
	isButtonDisabled: boolean;
	hasContent: boolean;
	onSendOrStop: () => void;
	modes?: SessionModeState;
	onModeChange?: (modeId: string) => void;
	models?: SessionModelState;
	onModelChange?: (modelId: string) => void;
	configOptions?: SessionConfigOption[];
	onConfigOptionChange?: (configId: string, value: string) => void;
	usage?: SessionUsage;
	isSessionReady: boolean;
	/** Obsidian App instance (used to open searchable picker modals) */
	app: App;
}

export function InputToolbar({
	isSending,
	isButtonDisabled,
	hasContent,
	onSendOrStop,
	modes,
	onModeChange,
	models,
	onModelChange,
	configOptions,
	onConfigOptionChange,
	usage,
	isSessionReady,
	app,
}: InputToolbarProps) {
	// Refs
	const sendButtonRef = useRef<HTMLButtonElement>(null);
	const modeDropdownRef = useRef<HTMLDivElement>(null);
	const modelDropdownRef = useRef<HTMLDivElement>(null);
	const configOptionsRef = useRef<HTMLDivElement>(null);
	const configDropdownInstances = useRef<Map<string, DropdownComponent>>(
		new Map(),
	);

	// Stable callback refs
	const onModeChangeRef = useRef(onModeChange);
	onModeChangeRef.current = onModeChange;

	const onModelChangeRef = useRef(onModelChange);
	onModelChangeRef.current = onModelChange;

	const onConfigOptionChangeRef = useRef(onConfigOptionChange);
	onConfigOptionChangeRef.current = onConfigOptionChange;

	/**
	 * Update send button icon color based on state.
	 */
	const updateIconColor = useCallback(
		(svg: SVGElement) => {
			svg.classList.remove(
				"agent-client-icon-sending",
				"agent-client-icon-active",
				"agent-client-icon-inactive",
			);

			if (isSending) {
				svg.classList.add("agent-client-icon-sending");
			} else {
				svg.classList.add(
					hasContent
						? "agent-client-icon-active"
						: "agent-client-icon-inactive",
				);
			}
		},
		[isSending, hasContent],
	);

	// Update send button icon based on sending state
	useEffect(() => {
		if (sendButtonRef.current) {
			const iconName = isSending ? "square" : "send-horizontal";
			setIcon(sendButtonRef.current, iconName);
			const svg = sendButtonRef.current.querySelector("svg");
			if (svg) {
				updateIconColor(svg);
			}
		}
	}, [isSending, updateIconColor]);

	// Update icon color when hasContent changes
	useEffect(() => {
		if (sendButtonRef.current) {
			const svg = sendButtonRef.current.querySelector("svg");
			if (svg) {
				updateIconColor(svg);
			}
		}
	}, [updateIconColor]);

	// Mode dropdown — mode lists are always short; inline dropdown is fine.
	const modeOptions = modes?.availableModes?.map((m) => ({
		value: m.id,
		label: m.name,
	}));
	useObsidianDropdown(
		modeDropdownRef,
		modeOptions,
		modes?.currentModeId,
		onModeChangeRef,
		true,
	);

	// Legacy model dropdown — large provider lists (OpenRouter 50+) are
	// painful to scroll. Swap to searchable picker above the threshold.
	const modelOptions = models?.availableModels?.map((m) => ({
		value: m.modelId,
		label: m.name,
	}));
	const legacyModelUseSearchable =
		!!modelOptions && modelOptions.length > SEARCHABLE_PICKER_THRESHOLD;
	useObsidianDropdown(
		modelDropdownRef,
		modelOptions,
		models?.currentModelId,
		onModelChangeRef,
		!legacyModelUseSearchable,
	);

	const legacyModelPickerOptions: PickerOption[] = (
		models?.availableModels ?? []
	).map((m) => ({
		value: m.modelId,
		label: m.name,
		description: m.description,
	}));

	// Initialize configOptions dropdowns (dynamic, replaces mode/model when present).
	// Each configOption renders either a DropdownComponent (small list) or
	// a searchable-picker button (large list, e.g. OpenCode provider-model
	// groups). The searchable-button DOM is created imperatively here too,
	// to keep all config-option UI inside a single imperative container
	// (avoids React/Obsidian DOM ownership conflicts).
	useEffect(() => {
		const containerEl = configOptionsRef.current;
		if (!containerEl) return;

		// Clean up existing dropdowns
		containerEl.empty();
		configDropdownInstances.current.clear();

		if (!configOptions || configOptions.length === 0) return;

		for (const option of configOptions) {
			// Flatten options (handle both flat and grouped)
			const flatOptions = flattenConfigSelectOptions(option.options);

			// Only show if there are multiple values
			if (flatOptions.length <= 1) continue;

			// Create wrapper div with appropriate class based on category
			const categoryClass = option.category
				? `agent-client-config-selector-${option.category}`
				: "agent-client-config-selector";
			const wrapperEl = containerEl.createDiv({
				cls: `agent-client-config-selector ${categoryClass}`,
				attr: { title: option.description ?? option.name },
			});

			const isGrouped =
				option.options.length > 0 && "group" in option.options[0];

			// Build picker options once (used by both paths).
			const pickerOptions: PickerOption[] = isGrouped
				? (option.options as SessionConfigSelectGroup[]).flatMap(
						(group) =>
							group.options.map((opt) => ({
								value: opt.value,
								label: opt.name,
								group: group.name,
								description: opt.description ?? undefined,
							})),
					)
				: flatOptions.map((opt) => ({
						value: opt.value,
						label: opt.name,
						description: opt.description ?? undefined,
					}));

			const useSearchable =
				pickerOptions.length > SEARCHABLE_PICKER_THRESHOLD;

			if (useSearchable) {
				// Searchable button — opens FuzzySuggestModal on click.
				const buttonEl = wrapperEl.createEl("button", {
					cls: "agent-client-searchable-selector-button",
					attr: { type: "button" },
				});
				const labelEl = buttonEl.createSpan({
					cls: "agent-client-searchable-selector-label",
				});
				const iconEl = buttonEl.createSpan({
					cls: "agent-client-searchable-selector-icon",
				});
				setIcon(iconEl, "chevron-down");

				const renderLabel = (value: string) => {
					const match = pickerOptions.find(
						(o) => o.value === value,
					);
					if (!match) {
						labelEl.setText(option.name);
						return;
					}
					labelEl.setText(
						match.group
							? `${match.group} / ${match.label}`
							: match.label,
					);
				};
				renderLabel(option.currentValue);

				const configId = option.id;
				buttonEl.addEventListener("click", () => {
					const modal = new SearchablePickerModal(
						app,
						pickerOptions,
						option.currentValue,
						(value) => {
							// Optimistic label update — real state flows back
							// through onConfigOptionChangeRef → session update.
							renderLabel(value);
							onConfigOptionChangeRef.current?.(configId, value);
						},
						option.description ?? option.name,
					);
					modal.open();
				});
			} else {
				const dropdownContainer = wrapperEl.createDiv();
				const dropdown = new DropdownComponent(dropdownContainer);

				// Add options (with group prefix for grouped options)
				if (isGrouped) {
					for (const group of option.options as SessionConfigSelectGroup[]) {
						for (const opt of group.options) {
							dropdown.addOption(
								opt.value,
								`${group.name} / ${opt.name}`,
							);
						}
					}
				} else {
					for (const opt of flatOptions) {
						dropdown.addOption(opt.value, opt.name);
					}
				}

				// Set current value
				dropdown.setValue(option.currentValue);

				// Handle change
				const configId = option.id;
				dropdown.onChange((value) => {
					if (onConfigOptionChangeRef.current) {
						onConfigOptionChangeRef.current(configId, value);
					}
				});

				// Add chevron icon
				const iconEl = wrapperEl.createSpan({
					cls: "agent-client-config-selector-icon",
				});
				setIcon(iconEl, "chevron-down");

				configDropdownInstances.current.set(option.id, dropdown);
			}
		}

		return () => {
			containerEl.empty();
			configDropdownInstances.current.clear();
		};
	}, [configOptions, app]);

	return (
		<div className="agent-client-chat-input-actions">
			{/* Context Usage Indicator (left-aligned via margin-right: auto) */}
			{usage && (
				<span
					className={`agent-client-usage-indicator ${getUsageColorClass(Math.round((usage.used / usage.size) * 100))}`}
					aria-label={
						usage.cost
							? `${formatTokenCount(usage.used)} / ${formatTokenCount(usage.size)} tokens\n$${usage.cost.amount.toFixed(2)}`
							: `${formatTokenCount(usage.used)} / ${formatTokenCount(usage.size)} tokens`
					}
				>
					{Math.round((usage.used / usage.size) * 100)}%
				</span>
			)}

			{/* Config Options (supersedes legacy mode/model selectors) */}
			{configOptions && configOptions.length > 0 ? (
				<div
					ref={configOptionsRef}
					className="agent-client-config-options-container"
				/>
			) : (
				<>
					{/* Legacy Mode Selector */}
					{modes && modes.availableModes.length > 1 && (
						<div
							className="agent-client-mode-selector"
							title={
								modes.availableModes.find(
									(m) => m.id === modes.currentModeId,
								)?.description ?? "Select mode"
							}
						>
							<div ref={modeDropdownRef} />
							<span
								className="agent-client-mode-selector-icon"
								ref={(el) => {
									if (el) setIcon(el, "chevron-down");
								}}
							/>
						</div>
					)}

					{/* Legacy Model Selector */}
					{models && models.availableModels.length > 1 && (
						<>
							{legacyModelUseSearchable ? (
								<SearchableSelectorButton
									app={app}
									options={legacyModelPickerOptions}
									currentValue={models.currentModelId}
									onChange={(value) =>
										onModelChangeRef.current?.(value)
									}
									placeholder="Select model"
									cssClass="agent-client-model-selector"
									titleText={
										models.availableModels.find(
											(m) =>
												m.modelId ===
												models.currentModelId,
										)?.description ?? "Select model"
									}
								/>
							) : (
								<div
									className="agent-client-model-selector"
									title={
										models.availableModels.find(
											(m) =>
												m.modelId ===
												models.currentModelId,
										)?.description ?? "Select model"
									}
								>
									<div ref={modelDropdownRef} />
									<span
										className="agent-client-model-selector-icon"
										ref={(el) => {
											if (el)
												setIcon(el, "chevron-down");
										}}
									/>
								</div>
							)}
						</>
					)}
				</>
			)}

			{/* Send/Stop Button */}
			<button
				ref={sendButtonRef}
				onClick={onSendOrStop}
				disabled={isButtonDisabled}
				className={`agent-client-chat-send-button ${isSending ? "sending" : ""} ${isButtonDisabled ? "agent-client-disabled" : ""}`}
				title={
					!isSessionReady
						? "Connecting..."
						: isSending
							? "Stop generation"
							: "Send message"
				}
			></button>
		</div>
	);
}
