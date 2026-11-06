(() => {
	'use strict';

	const GC = (globalThis.GeminiCounter = globalThis.GeminiCounter || {});

	function formatResetCountdown(timestampMs) {
		const diffMs = timestampMs - Date.now();
		if (diffMs <= 0) return '0s';

		const totalSeconds = Math.floor(diffMs / 1000);
		if (totalSeconds < 60) return `${totalSeconds}s`;

		const totalMinutes = Math.round(totalSeconds / 60);
		if (totalMinutes < 60) return `${totalMinutes}m`;

		const hours = Math.floor(totalMinutes / 60);
		const minutes = totalMinutes % 60;
		if (hours < 24) return `${hours}h ${minutes}m`;

		const days = Math.floor(hours / 24);
		const remHours = hours % 24;
		return `${days}d ${remHours}h`;
	}

	function makeTooltip(text) {
		const tip = document.createElement('div');
		tip.className = 'cc-tooltip gc-tooltip';
		tip.textContent = text;
		document.body.appendChild(tip);
		return tip;
	}

	function setupTooltip(element, tooltip, { topOffset = 10 } = {}) {
		if (!element || !tooltip) return;
		if (element.hasAttribute('data-gc-tooltip-setup')) return;
		element.setAttribute('data-gc-tooltip-setup', 'true');
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

	function queryFirst(selectors) {
		for (const sel of selectors) {
			try {
				const el = document.querySelector(sel);
				if (el) return el;
			} catch {
				// invalid selector for this browser; try the next
			}
		}
		return null;
	}

	GC.queryFirst = queryFirst;

	/**
	 * Gemini has no stable test ids, so find the composer via a priority list
	 * and then walk up to its outer wrapper. Inserting after `.ql-editor` alone
	 * would drop the row *inside* the input box.
	 */
	function findComposerAnchor() {
		const OUTER_TAGS = new Set(['INPUT-AREA-V2', 'INPUT-CONTAINER']);

		const el = queryFirst(GC.DOM.COMPOSER);
		if (!el) return null;
		if (OUTER_TAGS.has(el.tagName)) return el;

		// Climb while the box keeps getting wider, stopping before we reach a
		// container tall enough to be the whole chat panel.
		let best = el;
		let cur = el.parentElement;
		let hops = 0;
		const maxHeight = window.innerHeight * 0.5;

		while (cur && cur !== document.body && hops < 8) {
			if (OUTER_TAGS.has(cur.tagName)) return cur;
			const rect = cur.getBoundingClientRect();
			if (rect.height > maxHeight) break;
			if (rect.width > best.getBoundingClientRect().width) best = cur;
			cur = cur.parentElement;
			hops += 1;
		}

		return best;
	}

	class GeminiUsageUI {
		constructor({ onTierCycle } = {}) {
			this.onTierCycle = onTierCycle || null;

			this.row = null;
			this.groups = {};
			this.tierButton = null;
			this.domObserver = null;
			this.snapshot = null;

			this._reattachPending = false;
		}

		isDark() {
			const cls = `${document.body?.className || ''} ${document.documentElement?.className || ''}`;
			if (/\bdark[-_]?theme\b/i.test(cls)) return true;
			if (/\blight[-_]?theme\b/i.test(cls)) return false;
			return !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
		}

		refreshChrome() {
			if (!this.row) return;
			const dark = this.isDark();
			const stroke = dark ? GC.COLORS.TRACK_DARK : GC.COLORS.TRACK_LIGHT;
			const marker = dark ? GC.COLORS.MARKER_DARK : GC.COLORS.MARKER_LIGHT;

			this.row.style.setProperty('--gc-text', dark ? GC.COLORS.TEXT_DARK : GC.COLORS.TEXT_LIGHT);
			this.row.style.setProperty('--gc-stroke', stroke);

			// .cc-bar declares --cc-stroke/--cc-marker/--cc-fill-warn on itself,
			// which shadows anything inherited from the row, so these have to be
			// set per bar (inline style wins over the stylesheet declaration).
			for (const key of ['five_hour', 'seven_day']) {
				const bar = this.groups[key]?.bar;
				if (!bar) continue;
				bar.style.setProperty('--cc-stroke', stroke);
				bar.style.setProperty('--cc-marker', marker);
				bar.style.setProperty('--cc-fill-warn', GC.COLORS.RED_WARNING);
			}
		}

		initialize() {
			this._buildRow();
			this._setupTooltips();
			this._observeDom();
			this._observeTheme();
		}

		_buildBar() {
			const bar = document.createElement('div');
			bar.className = 'cc-bar cc-bar--usage cc-bar--gemini';

			const fill = document.createElement('div');
			fill.className = 'cc-bar__fill';
			fill.style.setProperty('--cc-pct', '0%');

			const marker = document.createElement('div');
			marker.className = 'cc-bar__marker cc-hidden';
			marker.style.left = '0%';

			bar.appendChild(fill);
			bar.appendChild(marker);
			return { bar, fill, marker };
		}

		_buildRow() {
			this.row = document.createElement('div');
			this.row.className = 'gc-usageRow cc-hidden';

			for (const key of ['five_hour', 'seven_day']) {
				const label = document.createElement('span');
				label.className = 'gc-usageText';

				const { bar, fill, marker } = this._buildBar();

				const group = document.createElement('div');
				group.className = 'gc-usageGroup';
				group.appendChild(label);
				group.appendChild(bar);

				this.groups[key] = { group, label, bar, fill, marker, resetMs: null, startMs: null };
				this.row.appendChild(group);
			}

			this.tierButton = document.createElement('button');
			this.tierButton.type = 'button';
			this.tierButton.className = 'gc-tierButton';
			this.tierButton.textContent = 'Pro · est.';
			this.tierButton.addEventListener('click', (e) => {
				e.preventDefault();
				e.stopPropagation();
				this.onTierCycle?.();
			});
			this.row.appendChild(this.tierButton);

			this.refreshChrome();
		}

		_setupTooltips() {
			setupTooltip(
				this.groups.five_hour.group,
				makeTooltip(
					'Estimated 5-hour usage window.\nThe bar shows your usage; the line marks where you are in the window.\nGemini publishes no usage API, so this is estimated from prompts you send, weighted by model.'
				),
				{ topOffset: 8 }
			);

			setupTooltip(
				this.groups.seven_day.group,
				makeTooltip(
					'Estimated weekly usage window.\nGemini refreshes your limit every 5 hours until you reach this weekly cap.\nEstimated locally, not read from Google.'
				),
				{ topOffset: 8 }
			);

			setupTooltip(
				this.tierButton,
				makeTooltip('Your Google AI plan. Click to cycle Free / Pro / Ultra.\nThis scales the estimated budget.\n"est." is a reminder that these numbers are estimates.'),
				{ topOffset: 8 }
			);
		}

		_observeTheme() {
			const observer = new MutationObserver(() => this.refreshChrome());
			observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
			if (document.body) {
				observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
			}
			window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => this.refreshChrome());
		}

		_observeDom() {
			this.domObserver = new MutationObserver(() => {
				if (!this.row || document.contains(this.row) || this._reattachPending) return;
				this._reattachPending = true;
				// Let the SPA finish its re-render before hunting for the anchor.
				setTimeout(() => {
					this._reattachPending = false;
					this.attach();
				}, 200);
			});
			this.domObserver.observe(document.body, { childList: true, subtree: true });
		}

		attach() {
			if (!this.row) return false;
			const anchor = findComposerAnchor();
			if (!anchor) return false;
			if (anchor.nextElementSibling !== this.row) {
				anchor.after(this.row);
			}
			this.refreshChrome();
			return true;
		}

		setTierLabel(tier) {
			if (!this.tierButton) return;
			this.tierButton.textContent = `${GC.TIER_NAMES[tier] || tier} · est.`;
		}

		setUsage(snapshot) {
			if (!snapshot) return;
			this.snapshot = snapshot;
			this.refreshChrome();
			this.setTierLabel(snapshot.tier);

			// Always visible: a 0% bar is useful information on Gemini, where
			// there is no native usage display at all.
			this.row?.classList.remove('cc-hidden');

			const labels = { five_hour: '5h', seven_day: 'Weekly' };

			for (const key of ['five_hour', 'seven_day']) {
				const g = this.groups[key];
				const win = snapshot[key];
				if (!g || !win) continue;

				const rawPct = typeof win.utilization === 'number' ? win.utilization : 0;
				const pct = Math.round(rawPct * 10) / 10;
				const width = Math.max(0, Math.min(100, rawPct));

				g.resetMs = win.resets_at;
				g.startMs = win.window_start;

				const resetText = g.resetMs ? ` · resets in ${formatResetCountdown(g.resetMs)}` : '';
				g.label.textContent = `${labels[key]}: ${pct}%${resetText}`;

				g.fill.style.setProperty('--cc-pct', `${width}%`);
				g.fill.classList.toggle('cc-warn', width >= 90);
				g.fill.classList.toggle('cc-full', width >= 99.5);
			}

			this._updateMarkers();
		}

		_updateMarkers() {
			const now = Date.now();
			for (const key of ['five_hour', 'seven_day']) {
				const g = this.groups[key];
				if (!g?.marker) continue;

				if (g.startMs && g.resetMs && g.resetMs > g.startMs) {
					const total = g.resetMs - g.startMs;
					const elapsed = Math.max(0, Math.min(total, now - g.startMs));
					const pct = Math.max(0, Math.min(100, (elapsed / total) * 100));
					g.marker.classList.remove('cc-hidden');
					g.marker.style.left = `${pct}%`;
				} else {
					g.marker.classList.add('cc-hidden');
				}
			}
		}

		tick() {
			for (const key of ['five_hour', 'seven_day']) {
				const g = this.groups[key];
				if (!g?.resetMs || !g.label.textContent) continue;
				const idx = g.label.textContent.indexOf('· resets in');
				if (idx === -1) continue;
				const prefix = g.label.textContent.slice(0, idx + '· resets in '.length);
				g.label.textContent = `${prefix}${formatResetCountdown(g.resetMs)}`;
			}
			this._updateMarkers();
		}
	}

	GC.ui = { GeminiUsageUI, formatResetCountdown };
})();
