(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	const STORAGE_KEY_ENABLED  = 'cc_notify_enabled';
	const STORAGE_KEY_NOTIFIED = 'cc_notified_';
	const STORAGE_KEY_WINDOW   = 'cc_window_';

	const THRESHOLDS = [50, 75, 90];

	const TIME_WARNINGS_MS = [
		60 * 60 * 1000,  // 1 hour left
		30 * 60 * 1000,  // 30 mins left
	];

	const WINDOW_MS = {
		session: 5 * 60 * 60 * 1000,
		weekly:  7 * 24 * 60 * 60 * 1000,
	};

	// ── helpers ──────────────────────────────────────────────────────────────

	function formatMs(ms) {
		if (ms <= 0) return 'now';
		const totalMin = Math.floor(ms / 60000);
		const h = Math.floor(totalMin / 60);
		const m = totalMin % 60;
		return h > 0 ? `${h}h ${m}m` : `${m}m`;
	}

	async function getEnabled() {
		try {
			const data = await chrome.storage.local.get(STORAGE_KEY_ENABLED);
			return data[STORAGE_KEY_ENABLED] !== false;
		} catch {
			return true;
		}
	}

	// ── permission request ───────────────────────────────────────────────────

	function requestPermission() {
		if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
			Notification.requestPermission();
		}
	}

	// ── fire a notification ──────────────────────────────────────────────────

	function fire(title, body) {
		chrome.runtime.sendMessage({ type: 'cc:notify', title, body });
	}

	// ── usage threshold notifications ────────────────────────────────────────

	async function notifyIfNeeded(type, pct, resetMs) {
		if (typeof pct !== 'number' || isNaN(pct)) return;

		const enabled = await getEnabled();
		if (!enabled) return;

		if (typeof Notification !== 'undefined' && Notification.permission !== 'granted') return;

		const notifiedKey = STORAGE_KEY_NOTIFIED + type;
		const windowKey   = STORAGE_KEY_WINDOW + type;

		const windowDuration = WINDOW_MS[type] ?? WINDOW_MS.session;
		const windowStart    = resetMs ? resetMs - windowDuration : null;

		let stored = {};
		try {
			stored = await chrome.storage.local.get([notifiedKey, windowKey]);
		} catch {
			return;
		}

		if (windowStart !== null && stored[windowKey] !== windowStart) {
			await chrome.storage.local.set({ [notifiedKey]: 0, [windowKey]: windowStart });
			stored[notifiedKey] = 0;
		}

		const lastNotified = stored[notifiedKey] ?? 0;
		const hit = [...THRESHOLDS].reverse().find(t => pct >= t && lastNotified < t);
		if (hit === undefined) return;

		const label     = type === 'session' ? 'Session (5h)' : 'Weekly';
		const remaining = Math.max(0, 100 - pct).toFixed(0);
		const resetIn   = resetMs ? formatMs(resetMs - Date.now()) : null;

		const title = `⚠️ Claude ${label} usage: ${Math.round(pct)}%`;
		const body  = pct >= 100
			? (resetIn ? `Limit reached — resets in ${resetIn}` : 'Limit reached.')
			: `${remaining}% remaining` + (resetIn ? ` — resets in ${resetIn}` : '');

		fire(title, body);
		await chrome.storage.local.set({ [notifiedKey]: hit });
	}

	// ── time-based warnings (only if usage < 90%) ────────────────────────────

	async function notifyIfResetSoon(type, resetMs, usagePct) {
		if (!resetMs) return;
		if (usagePct >= 90) return; // already near limit, skip time warnings

		const enabled = await getEnabled();
		if (!enabled) return;

		if (typeof Notification !== 'undefined' && Notification.permission !== 'granted') return;

		const timeLeft = resetMs - Date.now();
		if (timeLeft <= 0) return;

		const storageKey = `cc_time_warned_${type}`;

		for (const warning of TIME_WARNINGS_MS) {
			// Fire within a 60s window of the threshold
			if (timeLeft <= warning && timeLeft > warning - 60000) {
				let stored = {};
				try {
					stored = await chrome.storage.local.get(storageKey);
				} catch {
					return;
				}
				if (stored[storageKey] === warning) return; // already fired

				const mins      = Math.round(timeLeft / 60000);
				const remaining = (100 - usagePct).toFixed(0);
				const label     = type === 'session' ? 'Session (5h)' : 'Weekly';

				fire(
					`⏰ Claude ${label} resets in ${mins} min`,
					`You still have ${remaining}% remaining — use it before it resets!`
				);
				await chrome.storage.local.set({ [storageKey]: warning });
				break;
			}
		}
	}

	// ── reset notification ───────────────────────────────────────────────────

	async function notifyOnReset(type, resetMs) {
		if (!resetMs) return;

		const enabled = await getEnabled();
		if (!enabled) return;

		if (typeof Notification !== 'undefined' && Notification.permission !== 'granted') return;

		const storageKey = `cc_reset_notified_${type}`;
		const timeSinceReset = Date.now() - resetMs;

		// Fire within 2 minutes after reset
		if (timeSinceReset >= 0 && timeSinceReset < 2 * 60 * 1000) {
			let stored = {};
			try {
				stored = await chrome.storage.local.get(storageKey);
			} catch {
				return;
			}
			if (stored[storageKey] === resetMs) return; // already fired

			const label = type === 'session' ? 'Session (5h)' : 'Weekly';
			fire(
				`✅ Claude ${label} has reset!`,
				`You now have 100% available — start a new conversation!`
			);
			await chrome.storage.local.set({ [storageKey]: resetMs });
		}
	}

	// ── toggle ───────────────────────────────────────────────────────────────

	let _onToggleCallback = null;

	async function toggle() {
		const wasEnabled = await getEnabled();
		const nowEnabled = !wasEnabled;
		await chrome.storage.local.set({ [STORAGE_KEY_ENABLED]: nowEnabled });
		if (nowEnabled) requestPermission();
		if (_onToggleCallback) _onToggleCallback(nowEnabled);
		return nowEnabled;
	}

	function onToggle(cb) {
		_onToggleCallback = cb;
		getEnabled().then(cb);
	}

	// ── export ───────────────────────────────────────────────────────────────

	CC.notifications = { notifyIfNeeded, notifyIfResetSoon, notifyOnReset, toggle, onToggle, requestPermission, getEnabled };
})();
