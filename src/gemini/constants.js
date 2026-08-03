(() => {
	'use strict';

	const GC = (globalThis.GeminiCounter = globalThis.GeminiCounter || {});

	GC.CONST = Object.freeze({
		FIVE_HOUR_MS: 5 * 60 * 60 * 1000,
		SEVEN_DAY_MS: 7 * 24 * 60 * 60 * 1000,
		STORAGE_KEY: 'gc:usage:v1',
		BRIDGE_SCRIPT_ID: 'gc-bridge-script',
		MARKER: 'GeminiCounter',
		// A network send and the DOM fallback for the same prompt must not both count.
		SEND_DEDUPE_MS: 2000,
		// How long the DOM fallback waits for a matching request before counting it itself.
		DOM_FALLBACK_MS: 800
	});

	// Google's Gemini brand gradient.
	GC.GRADIENT = Object.freeze(['#1BA1E3', '#5489D6', '#9B72CB', '#D96570', '#F49C46']);

	GC.COLORS = Object.freeze({
		TRACK_DARK: '#3c4043',
		TRACK_LIGHT: '#c4c7c5',
		TEXT_DARK: '#c4c7c5',
		TEXT_LIGHT: '#5f6368',
		MARKER_DARK: '#ffffff',
		MARKER_LIGHT: '#111111',
		RED_WARNING: '#ce2029'
	});

	// --- Calibration ---------------------------------------------------------
	// Google publishes no compute budget for the Gemini app, so these are
	// estimates, not documented figures. Tune them here as real throttling is
	// observed; nothing else in the module hardcodes a cost.

	GC.MODEL_WEIGHTS = Object.freeze({
		flash: 1,
		pro: 4,
		thinking: 8
	});

	GC.FEATURE_WEIGHTS = Object.freeze({
		deepResearch: 20,
		imageGen: 5,
		video: 40
	});

	GC.DEFAULT_MODEL = 'pro';

	GC.TIERS = Object.freeze(['free', 'pro', 'ultra']);

	GC.TIER_NAMES = Object.freeze({
		free: 'Free',
		pro: 'Pro',
		ultra: 'Ultra'
	});

	// Credits per 5-hour window. Google states Pro is ~4x and Ultra ~20x the
	// standard (free) allowance.
	GC.TIER_BUDGETS = Object.freeze({
		free: 100,
		pro: 400,
		ultra: 2000
	});

	GC.DEFAULT_TIER = 'pro';

	// Weekly budget = 5-hour budget x this. A 7-day span holds ~33.6 five-hour
	// windows, so a multiplier well below that is what makes the weekly cap bind
	// before you could exhaust every window.
	GC.WEEKLY_MULTIPLIER = 10;

	// --- DOM ------------------------------------------------------------------
	// Gemini is an Angular app with no stable test ids. Everything below is a
	// prioritised candidate list: first hit wins, and the UI re-attaches itself
	// if the SPA tears the row out.

	GC.DOM = Object.freeze({
		COMPOSER: [
			'input-area-v2',
			'input-container',
			'rich-textarea',
			'.ql-editor',
			'[contenteditable="true"][role="textbox"]',
			'[data-node-type="input-area"]'
		],
		MODEL_PICKER: [
			'bard-mode-switcher button',
			'[data-test-id="bard-mode-menu-button"]',
			'[data-test-id="mode-switcher-trigger"]',
			'button[aria-haspopup="menu"] .logo-pill-label-container',
			'.gds-mode-switch-button'
		],
		SEND_BUTTON: [
			'button.send-button',
			'[data-test-id="send-button"]',
			'button[aria-label*="Send" i]',
			'button[mattooltip*="Send" i]'
		]
	});

	GC.MODEL_NAMES = Object.freeze({
		flash: 'Flash',
		pro: 'Pro',
		thinking: 'Thinking'
	});
})();
