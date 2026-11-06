(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

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
			this.modelGroups = {};
			this.weeklyGroup = null;
			this.weeklyUsageSpan = null;
			this.weeklyBar = null;
			this.weeklyBarFill = null;
			this.weeklyMarker = null;
			this.weeklyResetMs = null;
			this.weeklyWindowStartMs = null;
			this.overuseGroup = null;
			this.overuseUsageSpan = null;
			this.overuseBar = null;
			this.overuseBarFill = null;
			this.fiveHourIndicator = null;
			this.isNewChat = false;
			this.activeModel = 'sonnet';
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
			for (const m of (CC.MODELS || ['haiku', 'sonnet', 'opus'])) {
				if (this.modelGroups?.[m]?.bar) {
					applyBarChrome(this.modelGroups[m].bar, { fillWarn: CC.COLORS.RED_WARNING });
				}
			}
			applyBarChrome(this.weeklyBar, { fillWarn: CC.COLORS.RED_WARNING });
			applyBarChrome(this.overuseBar, { fillWarn: CC.COLORS.RED_WARNING });
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
					CC.waitForElement(CC.DOM.MODEL_SELECTOR_DROPDOWN, 60000).then((el) => {
						usageReattachPending = false;
						if (el) this.attachUsageLine();
					});
				}

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
			this.usageLine.className =
				'text-text-400 text-[11px] cc-usageRow cc-hidden flex flex-row items-center gap-4 w-full flex-nowrap';

			this.modelGroups = {};
			for (const m of (CC.MODELS || ['haiku', 'sonnet', 'opus'])) {
				const usageSpan = document.createElement('span');
				usageSpan.className = 'cc-usageText';

				const bar = document.createElement('div');
				bar.className = 'cc-bar cc-bar--usage';
				const widthPct = CC.MODEL_WIDTHS?.[m] || '15%';
				bar.style.width = widthPct;
				bar.style.flex = `0 0 ${widthPct}`;

				const barFill = document.createElement('div');
				barFill.className = 'cc-bar__fill';
				const marker = document.createElement('div');
				marker.className = 'cc-bar__marker cc-hidden';
				marker.style.left = '0%';
				bar.appendChild(barFill);
				bar.appendChild(marker);

				const group = document.createElement('div');
				group.className = 'cc-usageGroup cc-usageGroup--model';
				group.appendChild(usageSpan);
				group.appendChild(bar);

				this.modelGroups[m] = {
					group,
					usageSpan,
					bar,
					barFill,
					marker,
					resetMs: null,
					windowStartMs: null
				};
				this.usageLine.appendChild(group);
			}

			this.weeklyUsageSpan = document.createElement('span');
			this.weeklyUsageSpan.className = 'cc-usageText';

			this.weeklyBar = document.createElement('div');
			this.weeklyBar.className = 'cc-bar cc-bar--usage';
			this.weeklyBarFill = document.createElement('div');
			this.weeklyBarFill.className = 'cc-bar__fill';
			this.weeklyMarker = document.createElement('div');
			this.weeklyMarker.className = 'cc-bar__marker cc-hidden';
			this.weeklyMarker.style.left = '0%';
			this.weeklyBar.appendChild(this.weeklyBarFill);
			this.weeklyBar.appendChild(this.weeklyMarker);

			this.weeklyGroup = document.createElement('div');
			this.weeklyGroup.className = 'cc-usageGroup cc-usageGroup--weekly';
			this.weeklyGroup.appendChild(this.weeklyBar);
			this.weeklyGroup.appendChild(this.weeklyUsageSpan);
			this.usageLine.appendChild(this.weeklyGroup);

			this.overuseUsageSpan = document.createElement('span');
			this.overuseUsageSpan.className = 'cc-usageText';

			this.overuseBar = document.createElement('div');
			this.overuseBar.className = 'cc-bar cc-bar--usage';
			this.overuseBarFill = document.createElement('div');
			this.overuseBarFill.className = 'cc-bar__fill';
			this.overuseBar.appendChild(this.overuseBarFill);

			this.overuseGroup = document.createElement('div');
			this.overuseGroup.className = 'cc-usageGroup cc-usageGroup--overuse';
			this.overuseGroup.appendChild(this.overuseBar);
			this.overuseGroup.appendChild(this.overuseUsageSpan);
			this.usageLine.appendChild(this.overuseGroup);

			this.fiveHourIndicator = document.createElement('span');
			this.fiveHourIndicator.className = 'cc-usageText text-text-500 opacity-75 ml-auto mr-3 whitespace-nowrap select-none flex-shrink-0';
			this.fiveHourIndicator.textContent = '5-hour limit';
			this.usageLine.appendChild(this.fiveHourIndicator);

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

			for (const m of (CC.MODELS || ['haiku', 'sonnet', 'opus'])) {
				const mg = this.modelGroups?.[m];
				if (mg?.group) {
					const name = CC.MODEL_NAMES?.[m] || m;
					setupTooltip(
						mg.group,
						makeTooltip(`${name} 5-hour session window.\nThe bar shows your usage.\nThe line marks where you are in the window.`),
						{ topOffset: 8 }
					);
				}
			}

			setupTooltip(
				this.weeklyGroup,
				makeTooltip("7-day usage window.\nThe bar shows your usage.\nThe line marks where you are in the window."),
				{ topOffset: 8 }
			);

			setupTooltip(
				this.overuseGroup,
				makeTooltip("Overuse (extra usage) credits.\nThe bar shows your extra usage consumption beyond subscription limits."),
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
			if (!toolbarRow) return;
			if (toolbarRow.nextElementSibling !== this.usageLine) {
				toolbarRow.after(this.usageLine);
			}
			this.refreshProgressChrome();
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
				if (pct >= 90) fill.classList.add('cc-warn');
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

		setUsage(usage, { isNewChat = false, activeModel = 'sonnet' } = {}) {
			this.isNewChat = !!isNewChat;
			this.activeModel = activeModel;

			this.refreshProgressChrome();
			const modelsFiveHour = usage?.models_five_hour || {};
			const fallbackFiveHour = usage?.five_hour || null;
			const weekly = usage?.seven_day || null;
			const overuse = usage?.overuse || null;

			let fiveHourResetMs = null;
			if (fallbackFiveHour?.resets_at) {
				fiveHourResetMs = Date.parse(fallbackFiveHour.resets_at);
			} else {
				for (const m of (CC.MODELS || ['haiku', 'sonnet', 'opus'])) {
					if (modelsFiveHour[m]?.resets_at) {
						fiveHourResetMs = Date.parse(modelsFiveHour[m].resets_at);
						break;
					}
				}
			}
			this.fiveHourResetMs = fiveHourResetMs;

			if (this.fiveHourIndicator) {
				this.fiveHourIndicator.style.display = isNewChat ? '' : 'none';
				if (isNewChat) {
					const resetText = fiveHourResetMs ? ` · resets in ${formatResetCountdown(fiveHourResetMs)}` : '';
					this.fiveHourIndicator.textContent = `5h limit${resetText}`;
				}
			}

			const hasAnyUsage = !!fallbackFiveHour || !!weekly || !!overuse || Object.keys(modelsFiveHour).length > 0;
			this.usageLine?.classList.toggle('cc-hidden', !hasAnyUsage);

			// 1. Model Session Bars (5-hour limit)
			for (const m of (CC.MODELS || ['haiku', 'sonnet', 'opus'])) {
				const mg = this.modelGroups?.[m];
				if (!mg) continue;

				const session = modelsFiveHour[m] || fallbackFiveHour;
				const name = CC.MODEL_NAMES?.[m] || m;

				if (isNewChat || m === activeModel) {
					mg.group.classList.remove('cc-hidden');
					const barWidth = isNewChat ? (CC.MODEL_WIDTHS?.[m] || '96px') : '200px';
					mg.bar.style.width = barWidth;
					mg.bar.style.flex = `0 0 ${barWidth}`;
					if (session && typeof session.utilization === 'number') {
						const rawPct = session.utilization;
						const pct = Math.round(rawPct * 10) / 10;
						mg.resetMs = session.resets_at ? Date.parse(session.resets_at) : null;
						const windowHours = session.window_hours || 5;
						mg.windowStartMs = mg.resetMs ? mg.resetMs - windowHours * 60 * 60 * 1000 : null;
						const resetText = (!isNewChat && mg.resetMs) ? ` · resets in ${formatResetCountdown(mg.resetMs)}` : '';
						mg.usageSpan.textContent = `${name}: ${pct}%${resetText}`;

						const width = Math.max(0, Math.min(100, rawPct));
						mg.barFill.style.width = `${width}%`;
						mg.barFill.classList.toggle('cc-warn', width >= 90);
						mg.barFill.classList.toggle('cc-full', width >= 99.5);
					} else {
						mg.usageSpan.textContent = `${name}: 0%`;
						mg.barFill.style.width = '0%';
						mg.barFill.classList.remove('cc-warn', 'cc-full');
						mg.resetMs = null;
						mg.windowStartMs = null;
					}
				} else {
					mg.group.classList.add('cc-hidden');
				}
			}

			// 2. Weekly Bar (7-day limit)
			// Hidden on new chat site per requirement: "Show only 5 hour limit bars on the new chat site"
			// Shown on existing conversation per requirement: "Once a model is choose and you remove all the other bars, make the weekly usage limit bar come back."
			const hasWeekly = !isNewChat && weekly && typeof weekly.utilization === 'number';
			this.weeklyGroup?.classList.toggle('cc-hidden', !hasWeekly);

			if (hasWeekly) {
				this.weeklyUsageSpan.classList.remove('cc-hidden');
				this.weeklyBar.classList.remove('cc-hidden');
				this.weeklyBar.style.width = '200px';
				this.weeklyBar.style.flex = '0 0 200px';

				const rawPct = weekly.utilization;
				const pct = Math.round(rawPct * 10) / 10;
				this.weeklyResetMs = weekly.resets_at ? Date.parse(weekly.resets_at) : null;
				const weeklyHours = weekly.window_hours || (7 * 24);
				this.weeklyWindowStartMs = this.weeklyResetMs ? this.weeklyResetMs - weeklyHours * 60 * 60 * 1000 : null;
				const resetText = this.weeklyResetMs ? ` · resets in ${formatResetCountdown(this.weeklyResetMs)}` : '';
				this.weeklyUsageSpan.textContent = `Weekly: ${pct}%${resetText}`;

				const width = Math.max(0, Math.min(100, rawPct));
				this.weeklyBarFill.style.width = `${width}%`;
				this.weeklyBarFill.classList.toggle('cc-warn', width >= 90);
				this.weeklyBarFill.classList.toggle('cc-full', width >= 99.5);
			} else if (this.weeklyGroup) {
				this.weeklyUsageSpan.classList.add('cc-hidden');
				this.weeklyBar.classList.add('cc-hidden');
				this.weeklyResetMs = null;
				this.weeklyWindowStartMs = null;
				this.weeklyBarFill.classList.remove('cc-warn', 'cc-full');
			}

			// 3. Overuse Credits Bar - removed per requirement
			const hasOveruse = false;
			this.overuseGroup?.classList.toggle('cc-hidden', true);

			if (hasOveruse) {
				let label = 'Overuse';
				const pct = typeof overuse.utilization === 'number' ? Math.round(overuse.utilization * 10) / 10 : null;
				if (typeof overuse.used === 'number' && typeof overuse.limit === 'number') {
					label = `Overuse: $${overuse.used}/$${overuse.limit}${pct !== null ? ` (${pct}%)` : ''}`;
				} else if (pct !== null) {
					label = `Overuse: ${pct}%`;
				} else if (typeof overuse.used === 'number') {
					label = `Overuse: $${overuse.used}`;
				}
				this.overuseUsageSpan.textContent = label;

				const width = Math.max(0, Math.min(100, overuse.utilization || 0));
				this.overuseBarFill.style.width = `${width}%`;
				this.overuseBarFill.classList.toggle('cc-warn', width >= 90);
				this.overuseBarFill.classList.toggle('cc-full', width >= 99.5);
			}

			this._updateMarkers();
		}

		_updateMarkers() {
			const now = Date.now();

			for (const m of (CC.MODELS || ['haiku', 'sonnet', 'opus'])) {
				const mg = this.modelGroups?.[m];
				if (!mg) continue;
				const shouldShowMarker = this.isNewChat ? (m === 'sonnet') : (m === this.activeModel);
				if (shouldShowMarker && mg.marker && mg.windowStartMs && mg.resetMs) {
					const total = mg.resetMs - mg.windowStartMs;
					const elapsed = Math.max(0, Math.min(total, now - mg.windowStartMs));
					const ratio = total > 0 ? elapsed / total : 0;
					const pct = Math.max(0, Math.min(100, ratio * 100));
					mg.marker.classList.remove('cc-hidden');
					mg.marker.style.left = `${pct}%`;
				} else if (mg.marker) {
					mg.marker.classList.add('cc-hidden');
				}
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

			// Reset countdown text
			for (const m of (CC.MODELS || ['haiku', 'sonnet', 'opus'])) {
				const mg = this.modelGroups?.[m];
				if (mg?.resetMs && mg?.usageSpan?.textContent) {
					const idx = mg.usageSpan.textContent.indexOf('· resets in');
					if (idx !== -1) {
						const prefix = mg.usageSpan.textContent.slice(0, idx + '· resets in '.length);
						mg.usageSpan.textContent = `${prefix}${formatResetCountdown(mg.resetMs)}`;
					}
				}
			}

			if (this.weeklyResetMs && this.weeklyUsageSpan?.textContent) {
				const idx = this.weeklyUsageSpan.textContent.indexOf('· resets in');
				if (idx !== -1) {
					const prefix = this.weeklyUsageSpan.textContent.slice(0, idx + '· resets in '.length);
					this.weeklyUsageSpan.textContent = `${prefix}${formatResetCountdown(this.weeklyResetMs)}`;
				}
			}

			if (this.isNewChat && this.fiveHourResetMs && this.fiveHourIndicator?.textContent) {
				const idx = this.fiveHourIndicator.textContent.indexOf('· resets in');
				if (idx !== -1) {
					const prefix = this.fiveHourIndicator.textContent.slice(0, idx + '· resets in '.length);
					this.fiveHourIndicator.textContent = `${prefix}${formatResetCountdown(this.fiveHourResetMs)}`;
				}
			}

			this._updateMarkers();
		}
	}

	CC.ui = {
		CounterUI
	};
})();
