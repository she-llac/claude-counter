(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	/**
	 * DOM Discovery Engine
	 *
	 * Three-layer fallback for finding UI injection points:
	 *   Layer 1 (Exact)     — Known data-testid selectors from CC.SELECTORS
	 *   Layer 2 (Heuristic) — Structural patterns (contenteditable, button groups)
	 *   Layer 3 (Floating)  — Standalone positioned widget (always works)
	 *
	 * When Claude updates their DOM, Layer 1 breaks gracefully.
	 * Layer 2 catches the change. Layer 3 guarantees visibility.
	 */
	CC.DOMDiscovery = {

		// ---------------------------------------------------------------
		// Public API
		// ---------------------------------------------------------------

		/**
		 * Find a suitable anchor element for the token counter header.
		 * @returns {{ element: Element, method: string, confidence: string }}
		 */
		findHeaderAnchor() {
			// Layer 1: Try known selectors
			for (const selector of CC.SELECTORS.headerAnchors) {
				const el = document.querySelector(selector);
				if (el) {
					// Walk up to the wrapper or parent
					const anchor = el.closest('.chat-project-wrapper') || el.parentElement;
					if (anchor) {
						return { element: anchor, method: 'exact-' + selector, confidence: 'high' };
					}
				}
			}

			// Layer 2: Heuristic — find by structural patterns
			const heuristic = this._findHeaderByHeuristic();
			if (heuristic) {
				return { element: heuristic, method: 'heuristic-header', confidence: 'medium' };
			}

			// Layer 3: Floating
			return { element: document.body, method: 'floating', confidence: 'low' };
		},

		/**
		 * Find a suitable anchor element for the usage bars.
		 * @returns {{ element: Element, method: string, confidence: string }}
		 */
		findUsageAnchor() {
			// Layer 1: model-selector-dropdown (confirmed present June 2026)
			const modelBtn = document.querySelector(CC.SELECTORS.modelSelector);
			if (modelBtn) {
				const toolbar = this._findToolbarRow(modelBtn);
				if (toolbar) {
					return { element: toolbar, method: 'exact-toolbar', confidence: 'high' };
				}
			}

			// Layer 2: Find by chat-input area
			const chatInput = document.querySelector(CC.SELECTORS.chatInput);
			if (chatInput) {
				const toolbar = this._findToolbarNear(chatInput);
				if (toolbar) {
					return { element: toolbar, method: 'heuristic-chatinput', confidence: 'medium' };
				}
			}

			// Layer 3: Floating
			return { element: document.body, method: 'floating', confidence: 'low' };
		},

		/**
		 * Detect the active model from the model selector UI.
		 * @returns {{ name: string, family: string, contextLimit: number }}
		 */
		detectModel() {
			const btn = document.querySelector(CC.SELECTORS.modelSelector);
			if (!btn) {
				return { name: 'unknown', family: 'unknown', contextLimit: CC.CONST.DEFAULT_CONTEXT_LIMIT };
			}

			const label = btn.getAttribute('aria-label') || '';
			// Label patterns observed:
			//   "Model: Sonnet 4.6 Medium"     → model = "Sonnet 4.6"
			//   "Model: Haiku 4.5 Extended"     → model = "Haiku 4.5"
			//   "Model: Opus 4.8 High"          → model = "Opus 4.8"
			//   "Model: Fable 5"                → model = "Fable 5"
			//   "Model: Sonnet 4.6"             → model = "Sonnet 4.6"
			const match = label.match(/Model:\s*(.+?)(?:\s+(?:Low|Medium|High|Max|Ultra|Extended))?$/i);
			const modelName = match?.[1]?.trim() || 'unknown';

			// Match against known model families (fact-based context limits)
			const family = Object.keys(CC.MODEL_CONTEXTS).find(k =>
				modelName.toLowerCase().includes(k)
			);

			return {
				name: modelName,
				family: family || 'unknown',
				contextLimit: CC.MODEL_CONTEXTS[family] || CC.CONST.DEFAULT_CONTEXT_LIMIT,
			};
		},

		/**
		 * Sample the current theme from Claude's actual rendered colors.
		 * Falls back to prefers-color-scheme media query.
		 * @returns {{ isDark: boolean, bgColor: string|null, textColor: string|null }}
		 */
		sampleTheme() {
			// Try multiple elements to find one with an opaque background
			const candidates = [
				document.body,
				document.querySelector('main'),
				document.querySelector('[role="main"]'),
			].filter(Boolean);

			for (const el of candidates) {
				const bg = getComputedStyle(el).backgroundColor;
				if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') {
					const isDark = this._luminance(bg) < 0.5;
					return { isDark, bgColor: bg, textColor: getComputedStyle(el).color };
				}
			}

			// Fallback: OS-level preference
			const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
			return { isDark, bgColor: null, textColor: null };
		},

		// ---------------------------------------------------------------
		// Internal helpers
		// ---------------------------------------------------------------

		/**
		 * Walk up from an anchor element to find the toolbar row.
		 * A toolbar row is a flex-row container with multiple buttons.
		 */
		_findToolbarRow(el, stopAt) {
			let cur = el;
			while (cur && cur !== document.body) {
				if (stopAt && cur === stopAt) break;
				if (cur !== el && cur.nodeType === 1) {
					const style = window.getComputedStyle(cur);
					if (style.display === 'flex' && style.flexDirection === 'row') {
						const buttons = cur.querySelectorAll('button').length;
						if (buttons > 1) return cur;
					}
				}
				cur = cur.parentElement;
			}
			return null;
		},

		/**
		 * Find a toolbar-like container near an element.
		 * Searches siblings and parent's children.
		 */
		_findToolbarNear(el) {
			// Check siblings first
			const parent = el.parentElement;
			if (!parent) return null;

			// Walk up a few levels looking for a flex-row with buttons
			let container = parent;
			for (let i = 0; i < 5 && container && container !== document.body; i++) {
				const style = window.getComputedStyle(container);
				if (style.display === 'flex' && style.flexDirection === 'row') {
					const buttons = container.querySelectorAll('button').length;
					if (buttons > 1) return container;
				}
				container = container.parentElement;
			}

			return null;
		},

		/**
		 * Heuristic: find the header area by structural patterns.
		 * Looks for a nav or header-like element near the top of the page.
		 */
		_findHeaderByHeuristic() {
			// Look for a top-level nav or header containing user-menu or sidebar toggles
			const userMenu = document.querySelector(CC.SELECTORS.userMenu);
			if (userMenu) {
				// Walk up to find a header-level container
				let container = userMenu.parentElement;
				for (let i = 0; i < 5 && container && container !== document.body; i++) {
					const tag = container.tagName.toLowerCase();
					if (tag === 'header' || tag === 'nav') return container;

					// Check if it looks like a header bar (fixed/sticky, spans width)
					const style = window.getComputedStyle(container);
					if ((style.position === 'fixed' || style.position === 'sticky') &&
						parseInt(style.width) > window.innerWidth * 0.5) {
						return container;
					}
					container = container.parentElement;
				}
			}

			return null;
		},

		/**
		 * Calculate relative luminance from a CSS color string.
		 * Used to determine if a background is dark or light.
		 */
		_luminance(colorStr) {
			// Parse rgb/rgba string
			const match = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
			if (!match) return 0.5; // Unknown → assume middle

			const [, r, g, b] = match.map(Number);
			// Relative luminance formula (sRGB)
			const toLinear = (c) => {
				const s = c / 255;
				return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
			};
			return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
		},
	};
})();
