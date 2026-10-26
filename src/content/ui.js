(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	const USAGE_TOOLTIP_TAIL =
		'\n0% without a countdown: the window ended and nothing was used since.\n"no data yet": the limits arrive with your next reply.';
	const SESSION_TOOLTIP =
		'5-hour session window.\nThe bar shows your usage.\nThe line marks where you are in the window.' + USAGE_TOOLTIP_TAIL;
	const WEEKLY_TOOLTIP =
		'7-day usage window.\nThe bar shows your usage.\nThe line marks where you are in the window.' + USAGE_TOOLTIP_TAIL;

	function formatSeconds(totalSeconds) {
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;
		return `${minutes}:${String(seconds).padStart(2, '0')}`;
	}

	function formatResetCountdown(timestampMs) {
		// <= 0: reset time reached
		const diffMs = timestampMs - Date.now();
		if (diffMs <= 0) return '0s';

		// < 1 min: show seconds
		const totalSeconds = Math.floor(diffMs / 1000);
		if (totalSeconds < 60) return `${totalSeconds}s`;

		// < 1 hour: show minutes
		const totalMinutes = Math.round(totalSeconds / 60);
		if (totalMinutes < 60) return `${totalMinutes}m`;

		// < 1 day: show hours
		const hours = Math.floor(totalMinutes / 60);
		const minutes = totalMinutes % 60;
		if (hours < 24) return `${hours}h ${minutes}m`;

		// >= 1 day: show days
		const days = Math.floor(hours / 24);
		const remHours = hours % 24;
		return `${days}d ${remHours}h`;
	}

	function setupTooltip(element, tooltip, { topOffset = 10 } = {}) {
		if (!element || !tooltip) return;
		if (element.hasAttribute('data-tooltip-setup')) return;
		element.setAttribute('data-tooltip-setup', 'true');
		element.classList.add('cc-tooltipTrigger');

		let pressTimer;
		let hideTimer;

		const show = () => {
			const rect = element.getBoundingClientRect();
			tooltip.style.opacity = '1';
			const tipRect = tooltip.getBoundingClientRect();

			let left = rect.left + rect.width / 2;
			if (left + tipRect.width / 2 > window.innerWidth) left = window.innerWidth - tipRect.width / 2 - 10;
			if (left - tipRect.width / 2 < 0) left = tipRect.width / 2 + 10;

			let top = rect.top - tipRect.height - topOffset;
			if (top < 10) top = rect.bottom + 10;

			tooltip.style.left = `${left}px`;
			tooltip.style.top = `${top}px`;
			tooltip.style.transform = 'translateX(-50%)';
		};

		const hide = () => {
			tooltip.style.opacity = '0';
			clearTimeout(hideTimer);
		};

		element.addEventListener('pointerdown', (e) => {
			if (e.pointerType === 'touch' || e.pointerType === 'pen') {
				pressTimer = setTimeout(() => {
					show();
					hideTimer = setTimeout(hide, 3000);
				}, 500);
			}
		});

		element.addEventListener('pointerup', () => clearTimeout(pressTimer));
		element.addEventListener('pointercancel', () => {
			clearTimeout(pressTimer);
			hide();
		});

		element.addEventListener('pointerenter', (e) => {
			if (e.pointerType === 'mouse') show();
		});

		element.addEventListener('pointerleave', (e) => {
			if (e.pointerType === 'mouse') hide();
		});
	}

	function makeTooltip(text) {
		const tip = document.createElement('div');
		tip.className = 'bg-bg-500 text-text-000 cc-tooltip';
		tip.textContent = text;
		const appendTip = () => {
			const target = document.body || document.documentElement;
			if (target && !target.contains(tip)) {
				target.appendChild(tip);
			}
		};
		if (document.body || document.documentElement) {
			appendTip();
		} else {
			window.addEventListener('DOMContentLoaded', appendTip, { once: true });
		}
		return tip;
	}

	// A title that says nothing about the chat cannot be used to find the title element in the page.
	const GENERIC_TITLES = new Set(['claude', 'new chat', 'untitled', 'chats', 'projects', 'nov\u00fd chat']);
	const TITLE_STOP_TAGS = new Set(['HEADER', 'MAIN', 'BODY', 'HTML', 'NAV', 'ASIDE', 'SECTION', 'FORM']);
	const TITLE_SCAN_MIN_MS = 1500;
	const TITLE_SCAN_MAX_TRIES = 25;
	// Header under the title: the left padding of the header (the text starts that far in) and how far
	// up into the title's own box it starts.
	const HEADER_PAD_PX = 4;
	const UNDER_OVERLAP_PX = 2;

	const normText = (t) => String(t || '').replace(/\s+/g, ' ').trim();
	const hasElementChild = (el) => Array.from(el.children || []).some((c) => c && c.nodeType === 1);

	class CounterUI {
		constructor({ onUsageRefresh } = {}) {
			this.onUsageRefresh = onUsageRefresh || null;

			this.headerContainer = null;
			this.headerDisplay = null;
			this.lengthGroup = null;
			this.lengthDisplay = null;
			this.cachedDisplay = null;
			this.lengthBar = null;
			this.lengthTooltip = null;
			this.lastCachedUntilMs = null;
			this.pendingCache = false;
			this.headerInFallback = false;
			// 'anchor' (next to the page's title element), 'title' (a second line under the title, found
			// by the title text), 'bars' (above the usage bars), 'none' (not placed yet)
			this.headerPlacement = 'none';
			this._hiddenTicks = 0;
			this.conversationTitle = '';
			this._titleTries = 0;
			this._titleScanAt = 0;
			this._titleRejected = '';
			this._titleAnchor = null;
			this._titleLeaf = null;
			this._badRowTicks = 0;
			this._ticks = 0;

			this.usageLine = null;
			this.sessionUsageSpan = null;
			this.weeklyUsageSpan = null;
			this.sessionBar = null;
			this.sessionBarFill = null;
			this.weeklyBar = null;
			this.weeklyBarFill = null;
			this.sessionResetMs = null;
			this.weeklyResetMs = null;
			this.sessionMarker = null;
			this.weeklyMarker = null;
			this.sessionWindowStartMs = null;
			this.weeklyWindowStartMs = null;
			this.refreshingUsage = false;

			this.sessionTooltip = null;
			this.sessionHistory = [];
			this.sessionResetKey = null;

			this.domObserver = null;
		}

		getProgressChrome() {
			const root = document.documentElement;
			const modeDark = root.dataset?.mode === 'dark';
			const modeLight = root.dataset?.mode === 'light';
			const isDark = modeDark && !modeLight;

			return {
				strokeColor: isDark ? CC.COLORS.PROGRESS_OUTLINE_DARK : CC.COLORS.PROGRESS_OUTLINE_LIGHT,
				fillColor: isDark ? CC.COLORS.PROGRESS_FILL_DARK : CC.COLORS.PROGRESS_FILL_LIGHT,
				markerColor: isDark ? CC.COLORS.PROGRESS_MARKER_DARK : CC.COLORS.PROGRESS_MARKER_LIGHT,
				boldColor: isDark ? CC.COLORS.BOLD_DARK : CC.COLORS.BOLD_LIGHT
			};
		}

		refreshProgressChrome() {
			const { strokeColor, fillColor, markerColor } = this.getProgressChrome();

			const applyBarChrome = (bar, { fillWarn } = {}) => {
				if (!bar) return;
				bar.style.setProperty('--cc-stroke', strokeColor);
				bar.style.setProperty('--cc-fill', fillColor);
				bar.style.setProperty('--cc-fill-warn', fillWarn ?? fillColor);
				bar.style.setProperty('--cc-marker', markerColor);
			};

			applyBarChrome(this.lengthBar, { fillWarn: fillColor });
			applyBarChrome(this.sessionBar, { fillWarn: CC.COLORS.RED_WARNING });
			applyBarChrome(this.weeklyBar, { fillWarn: CC.COLORS.RED_WARNING });
		}

		initialize() {
			// Header container (tokens + cache timer)
			this.headerContainer = document.createElement('div');
			this.headerContainer.className = 'text-text-500 text-xs !px-1 cc-header';

			this.headerDisplay = document.createElement('span');
			this.headerDisplay.className = 'cc-headerItem';

			this.lengthGroup = document.createElement('span');
			this.lengthDisplay = document.createElement('span');
			this.cachedDisplay = document.createElement('span');
			this.cacheTimeSpan = null; // reference to inner time span

			this.lengthGroup.appendChild(this.lengthDisplay);
			this.headerDisplay.appendChild(this.lengthGroup);

			// Usage line (session + weekly)
			this._initUsageLine();

			this._setupTooltips();
			this._observeDom();
			this._observeTheme();
		}

		_observeTheme() {
			// Watch for theme changes (data-mode attribute on <html>)
			const observer = new MutationObserver(() => this.refreshProgressChrome());
			observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] });
		}

		_observeDom() {
			// Track pending reattach attempts independently
			let usageReattachPending = false;
			let headerReattachPending = false;

			this.domObserver = new MutationObserver(() => {
				const usageMissing = this.usageLine && !document.contains(this.usageLine);
				const headerMissing = !document.contains(this.headerContainer);

				if (usageMissing && !usageReattachPending) {
					usageReattachPending = true;
					CC.waitForElement(CC.DOM.CHAT_INPUT, 60000).then((el) => {
						usageReattachPending = false;
						if (el) this.attachUsageLine();
					});
				}

				if (headerMissing && !document.querySelector(CC.DOM.CHAT_HEADER_ANCHOR)) {
					this._mountHeaderFallback();
				}

				if (headerMissing && !headerReattachPending) {
					headerReattachPending = true;
					CC.waitForElement(CC.DOM.CHAT_HEADER_ANCHOR, 60000).then((el) => {
						headerReattachPending = false;
						if (el) this.attachHeader();
					});
				}
			});

			const startObserving = () => {
				const target = document.body || document.documentElement;
				if (target) {
					this.domObserver.observe(target, { childList: true, subtree: true });
				}
			};

			if (document.body || document.documentElement) {
				startObserving();
			} else {
				window.addEventListener('DOMContentLoaded', startObserving, { once: true });
			}
		}

		_initUsageLine() {
			this.usageLine = document.createElement('div');
			this.usageLine.className =
				'text-text-400 text-[11px] cc-usageRow flex flex-row items-center gap-3 w-full';

			this.sessionUsageSpan = document.createElement('span');
			this.sessionUsageSpan.className = 'cc-usageText';
			this.sessionUsageSpan.textContent = 'Session: no data yet';

			this.sessionBar = document.createElement('div');
			this.sessionBar.className = 'cc-bar cc-bar--usage';
			this.sessionBarFill = document.createElement('div');
			this.sessionBarFill.className = 'cc-bar__fill';
			this.sessionMarker = document.createElement('div');
			this.sessionMarker.className = 'cc-bar__marker cc-hidden';
			this.sessionMarker.style.left = '0%';
			this.sessionBar.appendChild(this.sessionBarFill);
			this.sessionBar.appendChild(this.sessionMarker);

			this.weeklyUsageSpan = document.createElement('span');
			this.weeklyUsageSpan.className = 'cc-usageText';
			this.weeklyUsageSpan.textContent = 'Weekly: no data yet';

			this.weeklyBar = document.createElement('div');
			this.weeklyBar.className = 'cc-bar cc-bar--usage';
			this.weeklyBarFill = document.createElement('div');
			this.weeklyBarFill.className = 'cc-bar__fill';
			this.weeklyMarker = document.createElement('div');
			this.weeklyMarker.className = 'cc-bar__marker cc-hidden';
			this.weeklyMarker.style.left = '0%';
			this.weeklyBar.appendChild(this.weeklyBarFill);
			this.weeklyBar.appendChild(this.weeklyMarker);

			this.sessionGroup = document.createElement('div');
			this.sessionGroup.className = 'cc-usageGroup';
			this.sessionGroup.appendChild(this.sessionUsageSpan);
			this.sessionGroup.appendChild(this.sessionBar);

			this.weeklyGroup = document.createElement('div');
			this.weeklyGroup.className = 'cc-usageGroup cc-usageGroup--weekly';
			this.weeklyGroup.appendChild(this.weeklyBar);
			this.weeklyGroup.appendChild(this.weeklyUsageSpan);

			this.usageLine.appendChild(this.sessionGroup);
			this.usageLine.appendChild(this.weeklyGroup);

			this.refreshProgressChrome();

			this.usageLine.addEventListener('click', async () => {
				if (!this.onUsageRefresh || this.refreshingUsage) return;
				this.refreshingUsage = true;
				this.usageLine.classList.add('cc-usageRow--dim');
				try {
					await this.onUsageRefresh();
				} finally {
					this.usageLine.classList.remove('cc-usageRow--dim');
					this.refreshingUsage = false;
				}
			});
		}

		_setupTooltips() {
			this.lengthTooltip = makeTooltip(
				"Approximate tokens (excludes system prompt).\nUses a generic tokenizer, may differ from Claude's count.\nBecomes invalid after context compaction.\nBar scale: 200k tokens (Claude's maximum context length, will compact before then)."
			);
			setupTooltip(
				this.lengthGroup,
				this.lengthTooltip,
				{ topOffset: 8 }
			);

			setupTooltip(
				this.cachedDisplay,
				makeTooltip("Messages sent while cached are significantly cheaper."),
				{ topOffset: 8 }
			);

			this.sessionTooltip = makeTooltip(
				SESSION_TOOLTIP
			);
			setupTooltip(
				this.sessionGroup,
				this.sessionTooltip,
				{ topOffset: 8 }
			);

			setupTooltip(
				this.weeklyGroup,
				makeTooltip(WEEKLY_TOOLTIP),
				{ topOffset: 8 }
			);
		}

		attach() {
			this.attachHeader();
			this.attachUsageLine();
			this.refreshProgressChrome();
		}

		/**
		 * The header anchor is specific to a claude.ai layout. Where it cannot be found, or the header
		 * ends up invisible, the token count and cache timer are shown just above the usage bars,
		 * which are mounted next to the chat input and work in every layout seen so far.
		 */
		_mountHeaderFallback() {
			if (this._mountHeaderByTitle()) return true;
			return this._mountHeaderAboveBars();
		}

		_resetHeaderStyle() {
			const st = this.headerContainer.style;
			st.paddingLeft = '';
			st.display = '';
			st.alignItems = '';
			st.marginLeft = '';
			st.marginTop = '';
			st.whiteSpace = '';
			st.position = '';
			st.left = '';
			st.top = '';
			st.zIndex = '';
			st.pointerEvents = '';
		}

		_mountHeaderAboveBars() {
			const line = this.usageLine;
			if (!line || !line.parentElement || !this.headerContainer) return false;
			if (line.previousElementSibling !== this.headerContainer) line.before(this.headerContainer);
			this._resetHeaderStyle();
			this.headerContainer.style.paddingLeft = '12px';
			this.headerInFallback = true;
			this.headerPlacement = 'bars';
			this._badRowTicks = 0;
			this._renderHeader();
			return true;
		}

		/** The chat title, as the conversation read gives it. */
		setConversationTitle(name) {
			const next = normText(name);
			if (next === this.conversationTitle) return;
			this.conversationTitle = next;
			this._titleTries = 0;
			this._titleRejected = '';
			this._titleScanAt = 0;
			if (this.headerPlacement === 'bars') this._mountHeaderByTitle();
		}

		_titleCandidates() {
			const out = [];
			const add = (t) => {
				const text = normText(t);
				if (text.length >= 2 && !GENERIC_TITLES.has(text.toLowerCase()) && !out.includes(text)) out.push(text);
			};
			add(this.conversationTitle);
			try {
				add(String(document.title || '').replace(/\s*[-\u2013\u2014|\u00b7]\s*Claude\s*$/i, ''));
			} catch {
				// ignore
			}
			return out;
		}

		/**
		 * Where the page shows the chat title, found by the title's own text: the layout of the new
		 * interface is not known, the text is. Returns the elements the header may follow, the widest
		 * wrapper that holds nothing but the title first, the title text element itself last.
		 */
		_findTitleAnchors(titles) {
			const all = document.querySelectorAll('*');
			let leaf = null;
			for (const el of all) {
				if (hasElementChild(el)) continue;
				const text = normText(el.textContent);
				if (!text || !titles.includes(text)) continue;
				if (el.closest('nav, aside, [role="navigation"], .cc-header, .cc-usageRow, .cc-tooltip, script, style')) continue;
				const r = el.getBoundingClientRect();
				if (!(r.width > 0 && r.height > 0 && r.top < 140 && r.bottom > 0)) continue;
				leaf = el;
				break;
			}
			if (!leaf) return [];
			const text = normText(leaf.textContent);
			const chain = [leaf];
			let anchor = leaf;
			while (anchor.parentElement && !TITLE_STOP_TAGS.has(anchor.parentElement.tagName) && normText(anchor.parentElement.textContent) === text) {
				anchor = anchor.parentElement;
				chain.push(anchor);
			}
			return chain.reverse();
		}

		/** Out of the row (no room taken from the title or the buttons), placed by _positionHeaderUnderTitle. */
		_styleHeaderUnderTitle() {
			this._resetHeaderStyle();
			const st = this.headerContainer.style;
			st.position = 'absolute';
			st.display = 'inline-flex';
			st.alignItems = 'center';
			st.marginLeft = '0';
			st.marginTop = '0';
			st.whiteSpace = 'nowrap';
			st.zIndex = '1';
			st.pointerEvents = 'auto';
		}

		/** Puts the header under the start of the title, measured against the element it is positioned in. */
		_positionHeaderUnderTitle(leaf) {
			const parent = this.headerContainer.offsetParent;
			if (!parent || !leaf || parent === document.body || parent === document.documentElement) return false;
			const pr = parent.getBoundingClientRect();
			const lr = leaf.getBoundingClientRect();
			const st = this.headerContainer.style;
			st.left = `${Math.round(lr.left - pr.left - HEADER_PAD_PX)}px`;
			st.top = `${Math.round(lr.bottom - pr.top - UNDER_OVERLAP_PX)}px`;
			return true;
		}

		/** The header sits right under the start of the title, inside the window. */
		_headerUnderTitle(leaf) {
			const hr = this.headerContainer.getBoundingClientRect();
			const lr = leaf.getBoundingClientRect();
			if (!(hr.width > 0 && hr.height > 0)) return false;
			if (Math.abs(hr.left - (lr.left - HEADER_PAD_PX)) > 3) return false;
			if (hr.top < lr.top + lr.height / 2 - 1) return false;
			if (hr.top - lr.bottom > 12) return false;
			const viewWidth = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : Infinity;
			return hr.right <= viewWidth + 1;
		}

		_mountHeaderByTitle() {
			if (!this.headerContainer || !document.body) return false;
			const titles = this._titleCandidates();
			if (titles.length === 0) return false;
			// An empty header has no size: whether it sits under the title cannot be checked. It is
			// placed when the token count arrives (setConversationMetrics) or by the periodic retry.
			if (!this.headerContainer.firstChild) return false;
			const key = titles.join('|');
			if (this._titleRejected === key) return false;

			const now = Date.now();
			if (now - this._titleScanAt < TITLE_SCAN_MIN_MS) return false;
			if (this._titleTries >= TITLE_SCAN_MAX_TRIES) return false;
			this._titleScanAt = now;
			this._titleTries += 1;

			const anchors = this._findTitleAnchors(titles);
			if (anchors.length === 0) return false;

			// Not outside the bar that holds the title: the first anchor, from the outside in, where the
			// header really lands under the title.
			const leaf = anchors[anchors.length - 1];
			for (const anchor of anchors) {
				if (anchor.nextElementSibling !== this.headerContainer) anchor.after(this.headerContainer);
				this._styleHeaderUnderTitle();
				this._renderHeader();
				if (this._positionHeaderUnderTitle(leaf) && this._headerUnderTitle(leaf)) {
					this._acceptTitlePlacement(anchor, leaf);
					return true;
				}
			}

			this._titleRejected = key;
			this._resetHeaderStyle();
			// back to where it was: above the bars, or out of the page until the bars exist
			if (!this._mountHeaderAboveBars()) this.headerContainer.remove();
			return false;
		}

		_acceptTitlePlacement(anchor, leaf) {
			this.headerInFallback = true;
			this.headerPlacement = 'title';
			this._badRowTicks = 0;
			this._titleAnchor = anchor;
			this._titleLeaf = leaf;
		}

		/** A header placed by the title text must stay under the title; if it does not, it goes back above the bars. */
		_checkTitlePlacement() {
			if (this.headerPlacement !== 'title' || !this.headerContainer.firstChild) {
				this._badRowTicks = 0;
				return;
			}
			const anchor = this._titleAnchor;
			const leaf = this._titleLeaf;
			const alive = !!anchor && !!leaf && document.contains(anchor) && document.contains(leaf) && document.contains(this.headerContainer);
			if (alive) this._positionHeaderUnderTitle(leaf);
			if (alive && this._headerUnderTitle(leaf)) {
				this._badRowTicks = 0;
				return;
			}
			this._badRowTicks += 1;
			if (this._badRowTicks >= 3) {
				this._titleRejected = this._titleCandidates().join('|');
				this._mountHeaderAboveBars();
			}
		}

		/** Every few seconds: while the header sits above the bars, look again for the title. */
		_retryTitleMount() {
			if (this.headerPlacement !== 'bars' || !this.headerContainer.firstChild) return;
			this._mountHeaderByTitle();
		}

		_ensureHeaderVisible() {
			if (!this.headerContainer || !this.headerContainer.firstChild) {
				this._hiddenTicks = 0;
				return;
			}
			const shown = document.contains(this.headerContainer) && this.headerContainer.getClientRects().length > 0;
			if (shown) {
				this._hiddenTicks = 0;
				return;
			}
			this._hiddenTicks += 1;
			if (this._hiddenTicks >= 3) {
				this._hiddenTicks = 0;
				if (this.headerPlacement === 'title') {
					this._titleRejected = this._titleCandidates().join('|');
					this._mountHeaderAboveBars();
				} else if (!this.headerInFallback) {
					this._mountHeaderFallback();
				}
			}
		}

		attachHeader() {
			const trigger = document.querySelector(CC.DOM.CHAT_HEADER_ANCHOR);
			if (!trigger) {
				this._mountHeaderFallback();
				return;
			}
			// New header anchors on chat-title-split / chat-title-button / conversation-title; legacy on chat-menu-trigger
			const testId = trigger.getAttribute('data-testid');
			const anchor =
				testId === 'chat-title-split' || testId === 'chat-title-button' || testId === 'conversation-title'
					? trigger
					: trigger.closest(CC.DOM.CHAT_PROJECT_WRAPPER) || trigger.parentElement;
			if (!anchor) return;
			if (anchor.nextElementSibling !== this.headerContainer) {
				anchor.after(this.headerContainer);
			}
			this.headerInFallback = false;
			this.headerPlacement = 'anchor';
			this._resetHeaderStyle();
			this._renderHeader();
			this.refreshProgressChrome();
		}

		attachUsageLine() {
			this._attachUsageLine();
			// A header waiting for the usage line (fallback mount) can be placed now.
			if (this.headerContainer && !document.contains(this.headerContainer)) this.attachHeader();
		}

		/** The usage bars are in place when they come right after the composer, or after the fallback header that sits there. */
		_followsComposer(flowChild) {
			const next = flowChild.nextElementSibling;
			if (next === this.usageLine) return true;
			return !!this.headerContainer && next === this.headerContainer && this.headerContainer.nextElementSibling === this.usageLine;
		}

		_attachUsageLine() {
			if (!this.usageLine) return;

			// Primary approach (redesigned composer): Resolve from the chat input element
			// The chat input exists on both home view and active conversation views.
			const chatInput = document.querySelector(CC.DOM.CHAT_INPUT || '[data-testid="chat-input"], div[contenteditable="true"], textarea');
			if (chatInput) {
				// The input lives inside a flow child inside .bg-surface-3:
				// .bg-surface-3 > .relative.w-full.min-w-0
				const composerFlowChild = chatInput.closest('.bg-surface-3 > .relative.w-full.min-w-0') ||
				                          chatInput.closest('.relative.w-full.min-w-0');

				if (composerFlowChild && composerFlowChild.parentElement) {
					if (!this._followsComposer(composerFlowChild)) {
						composerFlowChild.after(this.usageLine);
					}
					this.usageLine.style.paddingLeft = '12px';
					this.usageLine.style.paddingRight = '12px';
					this.usageLine.style.paddingBottom = '4px';
					this.refreshProgressChrome();
					return;
				}

				// If flow child structure differs, mount inside the composer box container
				const composerBox = chatInput.closest('.bg-surface-3') ||
				                    chatInput.closest('[data-cds="ChatComposer"]') ||
				                    chatInput.closest('fieldset') ||
				                    chatInput.closest('form');

				if (composerBox) {
					const targetBox = composerBox.querySelector(':scope > .bg-surface-3') || composerBox;
					if (targetBox && targetBox.lastElementChild !== this.usageLine) {
						targetBox.appendChild(this.usageLine);
					}
					this.usageLine.style.paddingLeft = '12px';
					this.usageLine.style.paddingRight = '12px';
					this.usageLine.style.paddingBottom = '4px';
					this.refreshProgressChrome();
					return;
				}
			}

			// Fallback approach: model selector dropdown
			const modelSelector = document.querySelector(CC.DOM.MODEL_SELECTOR_DROPDOWN);
			if (modelSelector) {
				const composer =
					modelSelector.closest(CC.DOM.COMPOSER) ||
					document.querySelector(CC.DOM.COMPOSER);
				if (composer) {
					const box = composer.querySelector(':scope > .bg-surface-3') || composer.firstElementChild;
					if (box && box.lastElementChild !== this.usageLine) {
						box.appendChild(this.usageLine);
					}
					this.usageLine.style.paddingLeft = '12px';
					this.usageLine.style.paddingRight = '12px';
					this.usageLine.style.paddingBottom = '4px';
					this.refreshProgressChrome();
					return;
				}

				const gridContainer = modelSelector.closest('[data-testid="chat-input-grid-container"]');
				const gridArea = modelSelector.closest('[data-testid="chat-input-grid-area"]');
				const findToolbarRow = (el, stopAt) => {
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
				};

				const toolbarRow =
					(gridContainer ? findToolbarRow(modelSelector, gridArea || gridContainer) : null) ||
					findToolbarRow(modelSelector) ||
					modelSelector.parentElement?.parentElement?.parentElement;
				if (toolbarRow && toolbarRow.nextElementSibling !== this.usageLine) {
					toolbarRow.after(this.usageLine);
					this.refreshProgressChrome();
					return;
				}
			}

			// Last resort fallback: input's immediate parent
			if (chatInput && chatInput.parentElement) {
				const parent = chatInput.closest('.flex-col') || chatInput.parentElement;
				if (parent && parent.lastElementChild !== this.usageLine) {
					parent.appendChild(this.usageLine);
					this.refreshProgressChrome();
				}
			}
		}

		setPendingCache(pending) {
			this.pendingCache = pending;
			if (this.cacheTimeSpan) {
				if (pending) {
					this.cacheTimeSpan.style.color = '';
				} else {
					const { boldColor } = this.getProgressChrome();
					this.cacheTimeSpan.style.color = boldColor;
				}
			}
		}

		setConversationMetrics(metrics) {
			const { totalTokens, cachedUntil } = metrics || {};
			this.pendingCache = false;
			if (!metrics) {
				// leaving the chat
				this.conversationTitle = '';
				this._titleTries = 0;
				this._titleRejected = '';
			}

			if (typeof totalTokens !== 'number') {
				this.lengthDisplay.textContent = '';
				this.cachedDisplay.textContent = '';
				this.lastCachedUntilMs = null;
				this._renderHeader();
				return;
			}

			const pct = Math.max(0, Math.min(100, (totalTokens / CC.CONST.CONTEXT_LIMIT_TOKENS) * 100));
			this.lengthDisplay.textContent = `~${totalTokens.toLocaleString()} tokens`;

			// Mini bar (hide when full - context is definitely compacted by then)
			const isFull = pct >= 99.5;
			if (isFull) {
				this.lengthDisplay.style.opacity = '0.5';
				this.lengthBar = null;
				this.lengthGroup.replaceChildren(this.lengthDisplay);
				if (this.lengthTooltip) {
					this.lengthTooltip.textContent =
						"Approximate tokens (excludes system prompt).\nUses a generic tokenizer, may differ from Claude's count.\nThis count is invalid after compaction.";
				}
			} else {
				this.lengthDisplay.style.opacity = '';
				const bar = document.createElement('div');
				bar.className = 'cc-bar cc-bar--mini';
				this.lengthBar = bar;
				const fill = document.createElement('div');
				fill.className = 'cc-bar__fill';
				fill.style.width = `${pct}%`;
				bar.appendChild(fill);
				this.refreshProgressChrome();

				const barContainer = document.createElement('span');
				barContainer.className = 'inline-flex items-center';
				barContainer.appendChild(bar);

				this.lengthGroup.replaceChildren(this.lengthDisplay, document.createTextNode('\u00A0\u00A0'), barContainer);
			}

			// Cache timer
			const now = Date.now();
			if (typeof cachedUntil === 'number' && cachedUntil > now) {
				this.lastCachedUntilMs = cachedUntil;
				const secondsLeft = Math.max(0, Math.ceil((cachedUntil - now) / 1000));
				const { boldColor } = this.getProgressChrome();
				this.cacheTimeSpan = Object.assign(document.createElement('span'), {
					className: 'cc-cacheTime',
					textContent: formatSeconds(secondsLeft)
				});
				this.cacheTimeSpan.style.color = boldColor;
				this.cachedDisplay.replaceChildren(document.createTextNode('cached for\u00A0'), this.cacheTimeSpan);
			} else {
				this.lastCachedUntilMs = null;
				this.cacheTimeSpan = null;
				this.cachedDisplay.textContent = '';
			}

			this._renderHeader();
			// A header that waited above the bars for its content can now be placed under the title.
			if (this.headerPlacement === 'bars') this._mountHeaderByTitle();
		}

		_renderHeader() {
			this.headerContainer.replaceChildren();

			const hasTokens = !!this.lengthDisplay.textContent;
			const hasCache = !!this.cachedDisplay.textContent;

			if (!hasTokens) return;

			if (hasCache) {
				const gap = this.lengthBar ? '\u00A0\u00A0' : '\u00A0';
				this.headerDisplay.replaceChildren(
					this.lengthGroup,
					document.createTextNode(gap),
					this.cachedDisplay
				);
			} else {
				this.headerDisplay.replaceChildren(this.lengthGroup);
			}

			this.headerContainer.appendChild(this.headerDisplay);
		}

		_updateSessionTooltip() {
			if (!this.sessionTooltip) return;
			const baseText = SESSION_TOOLTIP;
			if (this.sessionHistory && this.sessionHistory.length > 0) {
				const historyLine = this.sessionHistory
					.map((v) => (v === 0 ? '0' : `${v}%`))
					.join(' -> ');
				this.sessionTooltip.textContent = `${historyLine}\n${baseText}`;
			} else {
				this.sessionTooltip.textContent = baseText;
			}
		}

		_updateSessionHistory(resetsAt, currentPct) {
			if (!resetsAt) {
				this.sessionHistory = [];
				this.sessionResetKey = null;
				this._updateSessionTooltip();
				return;
			}

			const processHistory = (storedResetsAt, storedHistory) => {
				let history = [];
				if (storedResetsAt === resetsAt && Array.isArray(storedHistory) && storedHistory.length > 0) {
					history = [...storedHistory];
				} else {
					history = currentPct > 0 ? [0, currentPct] : [0];
				}

				const lastVal = history[history.length - 1];
				if (currentPct > lastVal) {
					history.push(currentPct);
					if (history.length > 5) {
						history = history.slice(-5);
					}
				} else if (currentPct < lastVal) {
					history = currentPct > 0 ? [0, currentPct] : [0];
				}

				this.sessionHistory = history;
				this.sessionResetKey = resetsAt;
				this._updateSessionTooltip();

				try {
					if (typeof chrome !== 'undefined' && chrome.storage?.local) {
						chrome.storage.local.set({
							claude_session_history: { resets_at: resetsAt, history }
						});
					}
				} catch (e) {
					// ignore storage errors
				}
			};

			if (this.sessionResetKey !== resetsAt) {
				this.sessionResetKey = resetsAt;
				try {
					if (typeof chrome !== 'undefined' && chrome.storage?.local) {
						chrome.storage.local.get(['claude_session_history'], (result) => {
							const data = result?.claude_session_history;
							processHistory(data?.resets_at, data?.history);
						});
					} else {
						processHistory(null, null);
					}
				} catch (e) {
					processHistory(null, null);
				}
			} else {
				processHistory(resetsAt, this.sessionHistory);
			}
		}

		/**
		 * One usage window, three states:
		 *  - live    { utilization, resets_at }: value and countdown
		 *  - expired { expired: true }: the reset time passed, nothing used since: 0%, no countdown
		 *  - unknown (null): no data yet, e.g. the free plan reports usage only with the first reply
		 */
		_renderWindow({ label, windowMs, w, span, fill }) {
			const live = w && !w.expired && typeof w.utilization === 'number';

			if (live) {
				const rawPct = w.utilization;
				const pct = Math.round(rawPct * 10) / 10;
				const resetMs = w.resets_at ? Date.parse(w.resets_at) : null;
				const resetText = resetMs ? ` · resets in ${formatResetCountdown(resetMs)}` : '';
				span.textContent = `${label}: ${pct}%${resetText}`;

				const width = Math.max(0, Math.min(100, rawPct));
				fill.style.width = `${width}%`;
				fill.classList.toggle('cc-warn', width >= 90);
				fill.classList.toggle('cc-full', width >= 99.5);
				return { resetMs, startMs: resetMs ? resetMs - windowMs : null, pct, live: true };
			}

			span.textContent = w && w.expired ? `${label}: 0%` : `${label}: no data yet`;
			fill.style.width = '0%';
			fill.classList.remove('cc-warn', 'cc-full');
			return { resetMs: null, startMs: null, pct: 0, live: false };
		}

		setUsage(usage) {
			this.refreshProgressChrome();

			// Bars are permanent
			this.usageLine?.classList.remove('cc-hidden');
			this.weeklyGroup?.classList.remove('cc-hidden');
			this.sessionGroup?.classList.remove('cc-usageGroup--single');
			this.weeklyUsageSpan.classList.remove('cc-hidden');
			this.weeklyBar.classList.remove('cc-hidden');

			const session = this._renderWindow({
				label: 'Session',
				windowMs: 5 * 60 * 60 * 1000,
				w: usage?.five_hour || null,
				span: this.sessionUsageSpan,
				fill: this.sessionBarFill
			});
			this.sessionResetMs = session.resetMs;
			this.sessionWindowStartMs = session.startMs;
			this._updateSessionHistory(session.live && usage.five_hour.resets_at ? usage.five_hour.resets_at : null, session.pct);

			const weekly = this._renderWindow({
				label: 'Weekly',
				windowMs: 7 * 24 * 60 * 60 * 1000,
				w: usage?.seven_day || null,
				span: this.weeklyUsageSpan,
				fill: this.weeklyBarFill
			});
			this.weeklyResetMs = weekly.resetMs;
			this.weeklyWindowStartMs = weekly.startMs;

			this._updateMarkers();
		}

		_updateMarkers() {
			const now = Date.now();

			if (this.sessionMarker && this.sessionWindowStartMs && this.sessionResetMs) {
				const total = this.sessionResetMs - this.sessionWindowStartMs;
				const elapsed = Math.max(0, Math.min(total, now - this.sessionWindowStartMs));
				const ratio = total > 0 ? elapsed / total : 0;
				const pct = Math.max(0, Math.min(100, ratio * 100));
				this.sessionMarker.classList.remove('cc-hidden');
				this.sessionMarker.style.left = `${pct}%`;
			} else if (this.sessionMarker) {
				this.sessionMarker.classList.add('cc-hidden');
			}

			if (this.weeklyMarker && this.weeklyWindowStartMs && this.weeklyResetMs) {
				const total = this.weeklyResetMs - this.weeklyWindowStartMs;
				const elapsed = Math.max(0, Math.min(total, now - this.weeklyWindowStartMs));
				const ratio = total > 0 ? elapsed / total : 0;
				const pct = Math.max(0, Math.min(100, ratio * 100));
				this.weeklyMarker.classList.remove('cc-hidden');
				this.weeklyMarker.style.left = `${pct}%`;
			} else if (this.weeklyMarker) {
				this.weeklyMarker.classList.add('cc-hidden');
			}
		}

		tick() {
			this._ensureHeaderVisible();
			this._checkTitlePlacement();
			this._ticks += 1;
			if (this._ticks % 3 === 0) this._retryTitleMount();

			// Cache countdown
			const now = Date.now();
			if (this.lastCachedUntilMs && this.lastCachedUntilMs > now) {
				const secondsLeft = Math.max(0, Math.ceil((this.lastCachedUntilMs - now) / 1000));
				if (this.cacheTimeSpan) {
					this.cacheTimeSpan.textContent = formatSeconds(secondsLeft);
				}
			} else if (this.lastCachedUntilMs && this.lastCachedUntilMs <= now) {
				this.lastCachedUntilMs = null;
				this.cacheTimeSpan = null;
				this.pendingCache = false;
				this.cachedDisplay.textContent = '';
				this._renderHeader();
			}

			// Reset countdown text + time markers
			if (this.sessionResetMs && this.sessionUsageSpan?.textContent) {
				const idx = this.sessionUsageSpan.textContent.indexOf('· resets in');
				if (idx !== -1) {
					const prefix = this.sessionUsageSpan.textContent.slice(0, idx + '· resets in '.length);
					this.sessionUsageSpan.textContent = `${prefix}${formatResetCountdown(this.sessionResetMs)}`;
				}
			}

			if (this.weeklyResetMs && this.weeklyUsageSpan?.textContent) {
				const idx = this.weeklyUsageSpan.textContent.indexOf('· resets in');
				if (idx !== -1) {
					const prefix = this.weeklyUsageSpan.textContent.slice(0, idx + '· resets in '.length);
					this.weeklyUsageSpan.textContent = `${prefix}${formatResetCountdown(this.weeklyResetMs)}`;
				}
			}

			this._updateMarkers();
		}
	}

	CC.ui = {
		CounterUI
	};
})();
