'use strict';

// A manual clock: Date, setTimeout and setInterval move only when advance() is called.

function createClock(startMs = Date.UTC(2026, 9, 14, 12, 0, 0)) {
	let now = startMs;
	let nextId = 1;
	const timers = new Map(); // id -> { at, fn, every }

	class FakeDate extends Date {
		constructor(...args) {
			if (args.length === 0) super(now);
			else super(...args);
		}
		static now() {
			return now;
		}
	}

	function setTimeoutFake(fn, ms = 0) {
		const id = nextId++;
		timers.set(id, { at: now + Math.max(0, ms), fn, every: null });
		return id;
	}
	function setIntervalFake(fn, ms = 0) {
		const id = nextId++;
		timers.set(id, { at: now + Math.max(1, ms), fn, every: Math.max(1, ms) });
		return id;
	}
	function clear(id) {
		timers.delete(id);
	}

	async function flush() {
		for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
	}

	async function advance(ms) {
		const target = now + ms;
		for (;;) {
			let nextId_ = null;
			let nextAt = Infinity;
			for (const [id, t] of timers) {
				if (t.at < nextAt) {
					nextAt = t.at;
					nextId_ = id;
				}
			}
			if (nextId_ === null || nextAt > target) break;
			const t = timers.get(nextId_);
			now = Math.max(now, nextAt);
			if (t.every) t.at = now + t.every;
			else timers.delete(nextId_);
			try {
				t.fn();
			} catch (e) {
				// a failing callback must not stop the clock
			}
			await flush();
		}
		now = target;
		await flush();
	}

	return {
		Date: FakeDate,
		setTimeout: setTimeoutFake,
		clearTimeout: clear,
		setInterval: setIntervalFake,
		clearInterval: clear,
		advance,
		flush,
		get now() {
			return now;
		},
		pendingTimers: () => timers.size
	};
}

module.exports = { createClock };
