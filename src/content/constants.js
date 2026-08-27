(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	CC.DOM = Object.freeze({
		// Older layout: title stack in the sidebar-adjacent header.
		CHAT_MENU_TRIGGER: '[data-testid="chat-menu-trigger"]',
		CHAT_PROJECT_WRAPPER: '.chat-project-wrapper',
		// Current layout: title lives in a horizontal header row.
		CHAT_HEADER_ROW: '[data-testid="chat-header"]',
		CHAT_TITLE_SPLIT: '[data-testid="chat-title-split"]',
		// Either layout - used to wait for whichever header anchor exists.
		HEADER_ANCHOR: '[data-testid="chat-menu-trigger"], [data-testid="chat-title-split"]',
		MODEL_SELECTOR_DROPDOWN: '[data-testid="model-selector-dropdown"]',
		// Current layout: the composer's flex column. Its last child sits below the input
		// box and the chin under it, in normal flow.
		COMPOSER_COLUMN: '[data-cds="ChatComposer"], fieldset[data-perf-region="composer"]',
		// Strip under the input box holding the disclaimer + model selector. Collapsed to
		// nothing on a fresh chat, where the model selector sits in the input box instead.
		COMPOSER_CHIN: '[data-cds="ChatComposerChin"]',
		// Older layout: the composer was a grid rather than a column.
		COMPOSER_GRID: '[data-testid="chat-input-grid-container"]',
		COMPOSER_GRID_AREA: '[data-testid="chat-input-grid-area"]',
		COMPOSER_ROOT:
			'[data-cds="ChatComposer"], fieldset[data-perf-region="composer"], [data-testid="chat-input-grid-container"]',
		BRIDGE_SCRIPT_ID: 'cc-bridge-script'
	});

	CC.CONST = Object.freeze({
		CACHE_WINDOW_MS: 5 * 60 * 1000,
		CONTEXT_LIMIT_TOKENS: 200000
	});

	CC.COLORS = Object.freeze({
		PROGRESS_FILL_DARK: '#2c84db',
		PROGRESS_FILL_LIGHT: '#5aa6ff',
		PROGRESS_OUTLINE_DARK: '#787877',
		PROGRESS_OUTLINE_LIGHT: '#bfbfbf',
		PROGRESS_MARKER_DARK: '#ffffff',
		PROGRESS_MARKER_LIGHT: '#111111',
		RED_WARNING: '#ce2029',
		BOLD_LIGHT: '#141413',
		BOLD_DARK: '#faf9f5'
	});
})();
