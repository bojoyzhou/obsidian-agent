/**
 * Modal for searching/picking one value from a list of options.
 *
 * Built on Obsidian's FuzzySuggestModal so it matches native command-palette
 * UX (keyboard navigation, fuzzy matching, instant filter).
 *
 * Used as a replacement for DropdownComponent when the option list is long
 * enough that scrolling is painful (e.g. OpenRouter's 50+ model list).
 * See competitive-analysis-report §3 / upstream issue #229.
 */

import { App, FuzzySuggestModal, FuzzyMatch } from "obsidian";

export interface PickerOption {
	value: string;
	label: string;
	/** Optional group label (e.g. provider name) shown as subdued text. */
	group?: string;
	/** Optional free-form description rendered below the label. */
	description?: string;
}

export class SearchablePickerModal extends FuzzySuggestModal<PickerOption> {
	private options: PickerOption[];
	private currentValue?: string;
	private onChoose: (value: string) => void;

	constructor(
		app: App,
		options: PickerOption[],
		currentValue: string | undefined,
		onChoose: (value: string) => void,
		placeholder?: string,
	) {
		super(app);
		this.options = options;
		this.currentValue = currentValue;
		this.onChoose = onChoose;
		if (placeholder) {
			this.setPlaceholder(placeholder);
		}
	}

	getItems(): PickerOption[] {
		return this.options;
	}

	getItemText(item: PickerOption): string {
		// Include group in the searchable surface so users can type e.g.
		// "openai gpt-5" to match an "OpenAI / GPT-5" option.
		return item.group ? `${item.group} ${item.label}` : item.label;
	}

	onChooseItem(item: PickerOption): void {
		this.onChoose(item.value);
	}

	/**
	 * Override rendering so we can show group, description, and a checkmark
	 * on the currently-selected option. FuzzySuggestModal's default only
	 * renders getItemText.
	 */
	renderSuggestion(match: FuzzyMatch<PickerOption>, el: HTMLElement): void {
		const item = match.item;
		el.addClass("agent-client-picker-item");

		const main = el.createDiv({ cls: "agent-client-picker-item-main" });
		if (item.group) {
			main.createSpan({
				cls: "agent-client-picker-item-group",
				text: `${item.group} / `,
			});
		}
		main.createSpan({
			cls: "agent-client-picker-item-label",
			text: item.label,
		});
		if (item.value === this.currentValue) {
			main.createSpan({
				cls: "agent-client-picker-item-current",
				text: "✓",
			});
		}

		if (item.description) {
			el.createDiv({
				cls: "agent-client-picker-item-desc",
				text: item.description,
			});
		}
	}
}
