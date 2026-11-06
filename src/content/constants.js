(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	CC.DOM = Object.freeze({
		CHAT_MENU_TRIGGER: '[data-testid="chat-menu-trigger"]',
		MODEL_SELECTOR_DROPDOWN: '[data-testid="model-selector-dropdown"]',
		CHAT_PROJECT_WRAPPER: '.chat-project-wrapper',
		BRIDGE_SCRIPT_ID: 'cc-bridge-script'
	});

	CC.CONST = Object.freeze({
		CACHE_WINDOW_MS: 5 * 60 * 1000,
		CONTEXT_LIMIT_TOKENS: 200000
	});

	CC.COLORS = Object.freeze({
		PROGRESS_FILL_DARK: '#d97757',
		PROGRESS_FILL_LIGHT: '#c96442',
		PROGRESS_OUTLINE_DARK: '#787877',
		PROGRESS_OUTLINE_LIGHT: '#bfbfbf',
		PROGRESS_MARKER_DARK: '#ffffff',
		PROGRESS_MARKER_LIGHT: '#111111',
		RED_WARNING: '#ce2029',
		BOLD_LIGHT: '#141413',
		BOLD_DARK: '#faf9f5'
	});

	CC.MODELS = Object.freeze(['haiku', 'sonnet', 'opus']);

	CC.MODEL_NAMES = Object.freeze({
		haiku: 'Haiku',
		sonnet: 'Sonnet',
		opus: 'Opus',
		fable: 'Fable'
	});

	CC.MODEL_WIDTHS = Object.freeze({
		haiku: '96px',
		sonnet: '96px',
		opus: '96px'
	});

	CC.MODEL_USAGE_MULTIPLIERS = Object.freeze({
		haiku: 1 / 3,
		sonnet: 1.0,
		opus: 2.0
	});
})();

