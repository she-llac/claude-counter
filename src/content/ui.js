(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	const IS_ES = /^es\b/i.test(document.documentElement.lang || navigator.language || '');
	const L = IS_ES
		? {
				session: 'Sesión',
				weekly: 'Semana',
				resetsIn: 'Se reinicia en',
				sessionTip: 'Ventana de uso de 5 horas.\nLa barra muestra tu consumo; la línea vertical, cuánto pasó de la ventana.\nClic para actualizar.',
				weeklyTip: 'Ventana de uso de 7 días.\nLa barra muestra tu consumo; la línea vertical, cuánto pasó de la ventana.\nClic para actualizar.'
			}
		: {
				session: 'Session',
				weekly: 'Week',
				resetsIn: 'Resets in',
				sessionTip: '5-hour session window.\nThe bar shows your usage; the tick marks elapsed time.\nClick to refresh.',
				weeklyTip: '7-day usage window.\nThe bar shows your usage; the tick marks elapsed time.\nClick to refresh.'
			};

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
		document.body.appendChild(tip);
		return tip;
	}

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
			let headerReattachPending = false;

			this.domObserver = new MutationObserver(() => {
				// Re-place the usage row whenever it is missing or no longer in the right spot
				if (this._usageMisplaced()) this._scheduleUsageReattach(150);
				const headerMissing = !document.contains(this.headerContainer);

				if (headerMissing && !headerReattachPending) {
					headerReattachPending = true;
					CC.waitForElement(CC.DOM.CHAT_MENU_TRIGGER, 60000).then((el) => {
						headerReattachPending = false;
						if (el) this.attachHeader();
					});
				}
			});
			this.domObserver.observe(document.body, { childList: true, subtree: true });
		}

		_initUsageLine() {
			this.usageLine = document.createElement('div');
			this.usageLine.className = 'cc-usageRow cc-hidden';

			const makeGroup = (label, extraClass) => {
				const group = document.createElement('div');
				group.className = `cc-usageGroup ${extraClass}`;
				const labelEl = Object.assign(document.createElement('span'), { className: 'cc-usageLabel', textContent: label });
				const bar = document.createElement('div');
				bar.className = 'cc-bar cc-bar--usage';
				const fill = document.createElement('div');
				fill.className = 'cc-bar__fill';
				const marker = document.createElement('div');
				marker.className = 'cc-bar__marker cc-hidden';
				bar.append(fill, marker);
				const pct = Object.assign(document.createElement('span'), { className: 'cc-usagePct' });
				const reset = Object.assign(document.createElement('span'), { className: 'cc-usageReset' });
				group.append(labelEl, bar, pct, reset);
				return { group, bar, fill, marker, pct, reset };
			};

			const sess = makeGroup(L.session, 'cc-usageGroup--session');
			const week = makeGroup(L.weekly, 'cc-usageGroup--weekly');

			this.sessionGroup = sess.group;
			this.sessionBar = sess.bar;
			this.sessionBarFill = sess.fill;
			this.sessionMarker = sess.marker;
			this.sessionUsageSpan = sess.pct;
			this.sessionResetSpan = sess.reset;

			this.weeklyGroup = week.group;
			this.weeklyBar = week.bar;
			this.weeklyBarFill = week.fill;
			this.weeklyMarker = week.marker;
			this.weeklyUsageSpan = week.pct;
			this.weeklyResetSpan = week.reset;

			this.usageLine.append(this.sessionGroup, this.weeklyGroup);
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

			setupTooltip(
				this.sessionGroup,
				makeTooltip(L.sessionTip),
				{ topOffset: 8 }
			);

			setupTooltip(
				this.weeklyGroup,
				makeTooltip(L.weeklyTip),
				{ topOffset: 8 }
			);
		}

		attach() {
			this.attachHeader();
			this.attachUsageLine();
			this.refreshProgressChrome();
		}

		attachHeader() {
			const chatMenu = document.querySelector(CC.DOM.CHAT_MENU_TRIGGER);
			if (!chatMenu) return;
			const anchor = chatMenu.closest(CC.DOM.CHAT_PROJECT_WRAPPER) || chatMenu.parentElement;
			if (!anchor) return;
			if (anchor.nextElementSibling !== this.headerContainer) {
				anchor.after(this.headerContainer);
			}
			this._renderHeader();
			this.refreshProgressChrome();
		}

		attachUsageLine() {
			if (!this.usageLine) return;
			const modelSelector = document.querySelector(CC.DOM.MODEL_SELECTOR_DROPDOWN);
			if (!modelSelector) return;

			// The composer toolbars are absolutely positioned inside the input, so the row
			// must live OUTSIDE the visible composer box. Preferred spot: the right side of
			// claude.ai's own strip under the box (the "chin": Manual · Output / icons), so
			// we don't add any vertical space. Fallback: a compact line right below.
			const box = this._findComposerBox(modelSelector);
			if (!box || !box.parentElement) {
				this._scheduleUsageReattach(300);
				return;
			}

			if (this._usageAnchor && this._usageAnchor !== box) this._usageAnchor.removeAttribute('data-cc-anchor');
			this._usageAnchor = box;
			box.setAttribute('data-cc-anchor', '1');

			const chin = this._findChin(box);
			this._placeUsage(box, chin, chin ? 'chin' : 'below');
			this._fitUsage();
			this._observeFit();
			this.refreshProgressChrome();
		}

		_findChin(box) {
			const next = box.nextElementSibling;
			if (!next || next === this.usageLine) return null;
			const style = window.getComputedStyle(next);
			if (style.display === 'none' || style.position === 'absolute' || style.position === 'fixed') return null;
			const h = next.getBoundingClientRect().height;
			if (h < 20 || h > 90) return null;
			return next;
		}

		_placeUsage(box, chin, mode) {
			const row = this.usageLine;
			row.classList.toggle('cc-usageRow--chin', mode === 'chin');
			row.classList.toggle('cc-usageRow--below', mode !== 'chin');
			if (mode === 'chin') {
				if (row.parentElement !== chin) chin.appendChild(row);
				this._usageParent = chin;
			} else {
				const after = mode === 'afterChin' && chin ? chin : box;
				if (after.nextElementSibling !== row) after.after(row);
				this._usageParent = after.parentElement;
			}
			this._usageMode = mode;
			this._usageChin = chin;
		}

		// Make sure the row never collides with claude.ai's own chin content.
		_fitUsage() {
			const row = this.usageLine;
			if (!row || row.classList.contains('cc-hidden')) return;
			const box = this._usageAnchor;
			const chin = this._usageChin;
			row.classList.remove('cc-compact');

			if (!chin) {
				if (this._usageMode !== 'below') this._placeUsage(box, null, 'below');
				return;
			}
			if (this._usageMode !== 'chin') this._placeUsage(box, chin, 'chin');

			const collides = () => {
				const rr = row.getBoundingClientRect();
				let rightmost = chin.getBoundingClientRect().left;
				for (const el of chin.querySelectorAll('button, a, [role="tab"], [role="button"]')) {
					if (row.contains(el)) continue;
					const r = el.getBoundingClientRect();
					if (r.width && r.height) rightmost = Math.max(rightmost, r.right);
				}
				return rr.left < rightmost + 16;
			};

			if (!collides()) return;
			row.classList.add('cc-compact');
			if (!collides()) return;
			row.classList.remove('cc-compact');
			this._placeUsage(box, chin, 'afterChin');
		}

		_observeFit() {
			if (this._fitObserver) this._fitObserver.disconnect();
			if (!('ResizeObserver' in window) || !this._usageAnchor) return;
			let raf = 0;
			this._fitObserver = new ResizeObserver(() => {
				cancelAnimationFrame(raf);
				raf = requestAnimationFrame(() => this._fitUsage());
			});
			this._fitObserver.observe(this._usageAnchor);
			if (this._usageChin) this._fitObserver.observe(this._usageChin);
		}

		_scheduleUsageReattach(delay = 200) {
			if (this._usageReattachTimer) return;
			this._usageReattachTimer = setTimeout(() => {
				this._usageReattachTimer = null;
				this.attachUsageLine();
			}, delay);
		}

		_usageMisplaced() {
			if (!this.usageLine) return false;
			const ms = document.querySelector(CC.DOM.MODEL_SELECTOR_DROPDOWN);
			if (!ms) return false; // no composer on this page
			if (!document.contains(this.usageLine)) return true;
			const box = this._usageAnchor;
			if (!box || !document.contains(box) || !box.contains(ms)) return true;
			if (this.usageLine.parentElement !== this._usageParent) return true;
			// claude.ai rendered its chin after we placed the row below the box
			if (this._usageMode === 'below' && this._findChin(box)) return true;
			return false;
		}

		_findComposerBox(modelSelector) {
			const editor =
				document.querySelector('[data-testid="chat-input"]') ||
				document.querySelector('.ProseMirror[contenteditable="true"]') ||
				document.querySelector('[contenteditable="true"]') ||
				document.querySelector('fieldset textarea, form textarea');
			if (!editor) return null;

			// Lowest common ancestor of editor and model selector.
			// Note: claude.ai positions the toolbars ABSOLUTELY at the bottom of this
			// element, so anything inserted inside it gets covered by the buttons.
			let lca = modelSelector.parentElement;
			while (lca && !lca.contains(editor)) lca = lca.parentElement;
			if (!lca || lca === document.body || lca === document.documentElement) return null;

			// Climb to the visible composer box (rounded + background/border/shadow)
			// and insert the usage row AFTER it, i.e. outside and below the box.
			const isVisualBox = (el) => {
				const s = window.getComputedStyle(el);
				const radius = parseFloat(s.borderTopLeftRadius) || 0;
				const hasBg = s.backgroundColor && s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent';
				const hasBorder = (parseFloat(s.borderTopWidth) || 0) > 0;
				const hasShadow = s.boxShadow && s.boxShadow !== 'none';
				return radius >= 8 && (hasBg || hasBorder || hasShadow);
			};
			let box = lca;
			for (let i = 0; i < 8 && box && box !== document.body; i++) {
				if (box.tagName === 'FIELDSET' || box.tagName === 'FORM') break;
				if (isVisualBox(box)) return box;
				box = box.parentElement;
			}
			// Fallback: just outside the toolbar's positioning context
			return lca.parentElement && lca.parentElement !== document.body ? lca : null;
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

		setConversationMetrics({ totalTokens, cachedUntil } = {}) {
			this.pendingCache = false;

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

		setUsage(usage) {
			this.refreshProgressChrome();
			const session = usage?.five_hour || null;
			const weekly = usage?.seven_day || null;
			const hasSession = !!(session && typeof session.utilization === 'number');
			const hasWeekly = !!(weekly && typeof weekly.utilization === 'number');
			const wasHidden = this.usageLine?.classList.contains('cc-hidden');
			this.usageLine?.classList.toggle('cc-hidden', !hasSession && !hasWeekly);

			const apply = (win, { group, fill, pct, reset }, hours) => {
				if (!win || typeof win.utilization !== 'number') {
					group.classList.add('cc-hidden');
					return { resetMs: null, startMs: null };
				}
				group.classList.remove('cc-hidden');
				const raw = Math.max(0, Math.min(100, win.utilization));
				pct.textContent = `${raw < 10 ? Math.round(raw * 10) / 10 : Math.round(raw)}%`;
				fill.style.width = `${raw}%`;
				fill.classList.toggle('cc-caution', raw >= 75 && raw < 90);
				fill.classList.toggle('cc-warn', raw >= 90);
				fill.classList.toggle('cc-full', raw >= 99.5);
				const resetMs = win.resets_at ? Date.parse(win.resets_at) : null;
				reset.textContent = resetMs ? formatResetCountdown(resetMs) : '';
				reset.title = resetMs ? `${L.resetsIn} ${formatResetCountdown(resetMs)}` : '';
				return { resetMs, startMs: resetMs ? resetMs - hours * 3600 * 1000 : null };
			};

			const s1 = apply(session, { group: this.sessionGroup, fill: this.sessionBarFill, pct: this.sessionUsageSpan, reset: this.sessionResetSpan }, 5);
			this.sessionResetMs = s1.resetMs;
			this.sessionWindowStartMs = s1.startMs;

			const s2 = apply(weekly, { group: this.weeklyGroup, fill: this.weeklyBarFill, pct: this.weeklyUsageSpan, reset: this.weeklyResetSpan }, 24 * 7);
			this.weeklyResetMs = s2.resetMs;
			this.weeklyWindowStartMs = s2.startMs;

			this._updateMarkers();
			if (wasHidden) requestAnimationFrame(() => this._fitUsage());
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

			// Reset countdowns + time markers
			if (this.sessionResetMs && this.sessionResetSpan) {
				this.sessionResetSpan.textContent = formatResetCountdown(this.sessionResetMs);
			}
			if (this.weeklyResetMs && this.weeklyResetSpan) {
				this.weeklyResetSpan.textContent = formatResetCountdown(this.weeklyResetMs);
			}

			this._updateMarkers();
		}
	}

	CC.ui = {
		CounterUI
	};
})();
