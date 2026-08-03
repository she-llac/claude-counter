(() => {
	'use strict';

	const GC = (globalThis.GeminiCounter = globalThis.GeminiCounter || {});
	if (GC.__started) return;
	GC.__started = true;

	// Inject before anything else so the bridge wraps fetch/XHR ahead of Angular.
	const bridgeReady = GC.injectBridgeOnce();

	const estimator = new GC.UsageEstimator();
	let ui = null;

	function whenBodyReady() {
		if (document.body) return Promise.resolve();
		return new Promise((resolve) => {
			document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
		});
	}

	/** Resolve once the composer anchor exists, or null on timeout. */
	function waitForAnchor(timeoutMs = 60000) {
		return new Promise((resolve) => {
			if (ui?.attach()) {
				resolve(true);
				return;
			}

			let timeoutId;
			const observer = new MutationObserver(() => {
				if (ui?.attach()) {
					if (timeoutId) clearTimeout(timeoutId);
					observer.disconnect();
					resolve(true);
				}
			});
			observer.observe(document.body, { childList: true, subtree: true });

			timeoutId = setTimeout(() => {
				observer.disconnect();
				resolve(false);
			}, timeoutMs);
		});
	}

	// --- Model + feature detection -------------------------------------------

	function normalizeModelName(raw) {
		if (!raw || typeof raw !== 'string') return null;
		const lower = raw.toLowerCase();
		// Order matters: "3.1 Pro Thinking" is a thinking model, not a pro one.
		if (lower.includes('thinking') || lower.includes('deep think')) return 'thinking';
		if (lower.includes('flash') || lower.includes('fast')) return 'flash';
		if (lower.includes('pro')) return 'pro';
		return null;
	}

	function detectModel() {
		const el = GC.queryFirst(GC.DOM.MODEL_PICKER);
		if (el) {
			const m = normalizeModelName(el.textContent || '');
			if (m) return m;
		}
		return GC.DEFAULT_MODEL;
	}

	const FEATURE_PATTERNS = [
		{ key: 'deepResearch', re: /deep research/i },
		{ key: 'imageGen', re: /create image|image generation|nano banana/i },
		{ key: 'video', re: /\bveo\b|create video|video generation/i }
	];

	/** Best-effort: which expensive tool chips are toggled on right now. */
	function detectFeatures() {
		const found = new Set();
		let candidates;
		try {
			candidates = document.querySelectorAll(
				'[aria-pressed="true"], [aria-selected="true"], .is-selected, .toolbox-drawer-item-button.is-selected'
			);
		} catch {
			return [];
		}

		for (const el of candidates) {
			const text = el.textContent || el.getAttribute('aria-label') || '';
			if (!text) continue;
			for (const { key, re } of FEATURE_PATTERNS) {
				if (re.test(text)) found.add(key);
			}
		}
		return Array.from(found);
	}

	// --- Send detection -------------------------------------------------------
	// A prompt can be signalled twice: by the network interceptor and by the DOM
	// fallback. Both feed one "send cycle", which commits at most once.

	let cycle = null;

	function commit(c) {
		if (!c || c.counted) return;
		c.counted = true;
		if (c.timer) {
			clearTimeout(c.timer);
			c.timer = null;
		}
		estimator.record({ model: detectModel(), features: detectFeatures() });
		render();
	}

	function signalSend(source) {
		const now = Date.now();

		if (cycle && now - cycle.openedAt < GC.CONST.SEND_DEDUPE_MS) {
			// The network is the trustworthy signal; if it lands while the DOM
			// fallback is still pending, commit now instead of waiting it out.
			if (source === 'network' && !cycle.counted) commit(cycle);
			return;
		}

		cycle = { openedAt: now, counted: false, timer: null };

		if (source === 'network') {
			commit(cycle);
		} else {
			const c = cycle;
			c.timer = setTimeout(() => commit(c), GC.CONST.DOM_FALLBACK_MS);
		}
	}

	function isSendAction(target) {
		if (!(target instanceof Element)) return false;
		for (const sel of GC.DOM.SEND_BUTTON) {
			try {
				if (target.closest(sel)) return true;
			} catch {
				// invalid selector; skip
			}
		}
		return false;
	}

	function installDomFallback() {
		document.addEventListener(
			'click',
			(e) => {
				if (isSendAction(e.target)) signalSend('dom');
			},
			true
		);

		document.addEventListener(
			'keydown',
			(e) => {
				if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
				const el = e.target;
				if (!(el instanceof Element)) return;
				const editable = el.closest('[contenteditable="true"], textarea, rich-textarea');
				if (editable) signalSend('dom');
			},
			true
		);
	}

	// --- Render ---------------------------------------------------------------

	function render() {
		if (!ui) return;
		ui.setUsage(estimator.snapshot());
	}

	// --- Boot -----------------------------------------------------------------

	async function boot() {
		await whenBodyReady();
		await estimator.load();

		ui = new GC.ui.GeminiUsageUI({
			onTierCycle: () => {
				estimator.cycleTier();
				render();
			}
		});
		ui.initialize();

		render();
		waitForAnchor();

		installDomFallback();

		await bridgeReady;
		GC.bridge.on('gc:prompt_sent', () => signalSend('network'));

		const onUrlChange = () => waitForAnchor(30000);
		window.addEventListener('gc:urlchange', onUrlChange);
		window.addEventListener('popstate', onUrlChange);

		setInterval(() => {
			// roll() zeroes an expired window; re-render so the bar drops to 0
			// even if the user has not sent anything since.
			if (estimator.roll()) render();
			ui.tick();
		}, 1000);
	}

	boot();
})();
