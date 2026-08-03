(() => {
	'use strict';

	const GC = (globalThis.GeminiCounter = globalThis.GeminiCounter || {});

	function getStorageArea() {
		try {
			return globalThis.browser?.storage?.local || globalThis.chrome?.storage?.local || null;
		} catch {
			return null;
		}
	}

	/**
	 * chrome.storage.local when running as an extension, localStorage otherwise
	 * (the userscript build has no extension APIs). Both are local-only.
	 */
	const store = {
		async get(key) {
			const area = getStorageArea();
			if (area) {
				try {
					const result = await new Promise((resolve, reject) => {
						const maybePromise = area.get(key, (items) => {
							const err = globalThis.chrome?.runtime?.lastError;
							if (err) reject(new Error(err.message));
							else resolve(items);
						});
						// Firefox returns a promise instead of using the callback.
						if (maybePromise && typeof maybePromise.then === 'function') {
							maybePromise.then(resolve, reject);
						}
					});
					return result?.[key] ?? null;
				} catch {
					// fall through to localStorage
				}
			}
			try {
				const raw = localStorage.getItem(key);
				return raw ? JSON.parse(raw) : null;
			} catch {
				return null;
			}
		},

		async set(key, value) {
			const area = getStorageArea();
			if (area) {
				try {
					await new Promise((resolve, reject) => {
						const maybePromise = area.set({ [key]: value }, () => {
							const err = globalThis.chrome?.runtime?.lastError;
							if (err) reject(new Error(err.message));
							else resolve();
						});
						if (maybePromise && typeof maybePromise.then === 'function') {
							maybePromise.then(resolve, reject);
						}
					});
					return;
				} catch {
					// fall through to localStorage
				}
			}
			try {
				localStorage.setItem(key, JSON.stringify(value));
			} catch {
				// storage full or blocked; usage tracking degrades to in-memory
			}
		}
	};

	function emptyWindow() {
		return { start: null, credits: 0 };
	}

	function sanitizeWindow(w) {
		if (!w || typeof w !== 'object') return emptyWindow();
		const start = typeof w.start === 'number' && Number.isFinite(w.start) ? w.start : null;
		const credits = typeof w.credits === 'number' && Number.isFinite(w.credits) && w.credits > 0 ? w.credits : 0;
		// A window with credits but no anchor is meaningless; drop both.
		if (start === null) return emptyWindow();
		return { start, credits };
	}

	/**
	 * Estimates Gemini usage locally.
	 *
	 * Gemini exposes no usage endpoint, so usage is inferred from prompts the
	 * user sends, weighted per model. Windows are *anchored*, mirroring Claude:
	 * the window opens on the first prompt after the previous one expired and
	 * closes a fixed span later, which gives us a real resets_at for the
	 * countdown and the window-progress marker.
	 */
	class UsageEstimator {
		constructor() {
			this.state = {
				fiveHour: emptyWindow(),
				sevenDay: emptyWindow(),
				tier: GC.DEFAULT_TIER
			};
			this.loaded = false;
			this._saveTimer = null;
		}

		async load() {
			const raw = await store.get(GC.CONST.STORAGE_KEY);
			if (raw && typeof raw === 'object') {
				this.state.fiveHour = sanitizeWindow(raw.fiveHour);
				this.state.sevenDay = sanitizeWindow(raw.sevenDay);
				this.state.tier = GC.TIERS.includes(raw.tier) ? raw.tier : GC.DEFAULT_TIER;
			}
			this.loaded = true;
			this.roll();
			return this.state;
		}

		_scheduleSave() {
			if (this._saveTimer) clearTimeout(this._saveTimer);
			this._saveTimer = setTimeout(() => {
				this._saveTimer = null;
				store.set(GC.CONST.STORAGE_KEY, this.state);
			}, 250);
		}

		/** Expire any window whose span has elapsed. Returns true if anything reset. */
		roll(now = Date.now()) {
			let changed = false;

			const expire = (win, spanMs) => {
				if (win.start !== null && now >= win.start + spanMs) {
					win.start = null;
					win.credits = 0;
					return true;
				}
				return false;
			};

			if (expire(this.state.fiveHour, GC.CONST.FIVE_HOUR_MS)) changed = true;
			if (expire(this.state.sevenDay, GC.CONST.SEVEN_DAY_MS)) changed = true;

			if (changed) this._scheduleSave();
			return changed;
		}

		/**
		 * @param {string} model - normalized model key (flash | pro | thinking)
		 * @param {string[]} [features] - keys into GC.FEATURE_WEIGHTS
		 */
		creditsFor(model, features = []) {
			const base = GC.MODEL_WEIGHTS[model] ?? GC.MODEL_WEIGHTS[GC.DEFAULT_MODEL];
			let cost = base;
			for (const f of features) {
				const extra = GC.FEATURE_WEIGHTS[f];
				if (typeof extra === 'number') cost += extra;
			}
			return cost;
		}

		record({ model = GC.DEFAULT_MODEL, features = [] } = {}, now = Date.now()) {
			this.roll(now);
			const cost = this.creditsFor(model, features);

			for (const win of [this.state.fiveHour, this.state.sevenDay]) {
				if (win.start === null) win.start = now;
				win.credits += cost;
			}

			this._scheduleSave();
			return cost;
		}

		getTier() {
			return this.state.tier;
		}

		setTier(tier) {
			if (!GC.TIERS.includes(tier)) return;
			this.state.tier = tier;
			this._scheduleSave();
		}

		cycleTier() {
			const idx = GC.TIERS.indexOf(this.state.tier);
			const next = GC.TIERS[(idx + 1) % GC.TIERS.length];
			this.setTier(next);
			return next;
		}

		budgets() {
			const fiveHour = GC.TIER_BUDGETS[this.state.tier] ?? GC.TIER_BUDGETS[GC.DEFAULT_TIER];
			return { fiveHour, sevenDay: fiveHour * GC.WEEKLY_MULTIPLIER };
		}

		/**
		 * Snapshot shaped like the Claude module's normalized usage object, so
		 * the UI reads utilization (0-100) and resets_at the same way.
		 */
		snapshot(now = Date.now()) {
			this.roll(now);
			const budget = this.budgets();

			const build = (win, spanMs, limit) => {
				const utilization = limit > 0 ? Math.max(0, Math.min(100, (win.credits / limit) * 100)) : 0;
				return {
					utilization,
					credits: win.credits,
					limit,
					window_start: win.start,
					resets_at: win.start !== null ? win.start + spanMs : null,
					window_ms: spanMs
				};
			};

			return {
				five_hour: build(this.state.fiveHour, GC.CONST.FIVE_HOUR_MS, budget.fiveHour),
				seven_day: build(this.state.sevenDay, GC.CONST.SEVEN_DAY_MS, budget.sevenDay),
				tier: this.state.tier
			};
		}
	}

	GC.UsageEstimator = UsageEstimator;
})();
