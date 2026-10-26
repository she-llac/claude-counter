'use strict';

// Minimal chrome.storage.local with onChanged, enough for the content scripts and main.js tests.

function createFakeChrome(initial = {}) {
	const data = { ...initial };
	const changeListeners = [];

	function pick(keys) {
		if (keys === null || keys === undefined) return { ...data };
		if (typeof keys === 'string') return keys in data ? { [keys]: data[keys] } : {};
		if (Array.isArray(keys)) return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]]));
		const out = {};
		for (const k of Object.keys(keys)) out[k] = k in data ? data[k] : keys[k];
		return out;
	}

	function emit(changes) {
		if (Object.keys(changes).length === 0) return;
		for (const fn of changeListeners) fn(changes, 'local');
	}

	const local = {
		get(keys, cb) {
			const result = JSON.parse(JSON.stringify(pick(keys)));
			if (cb) setImmediate(() => cb(result));
		},
		set(obj, cb) {
			const changes = {};
			for (const k of Object.keys(obj)) {
				const copy = JSON.parse(JSON.stringify(obj[k]));
				changes[k] = { oldValue: data[k], newValue: copy };
				data[k] = copy;
			}
			setImmediate(() => {
				emit(changes);
				if (cb) cb();
			});
		},
		remove(keys, cb) {
			const list = Array.isArray(keys) ? keys : [keys];
			const changes = {};
			for (const k of list) {
				if (k in data) {
					changes[k] = { oldValue: data[k] };
					delete data[k];
				}
			}
			setImmediate(() => {
				emit(changes);
				if (cb) cb();
			});
		}
	};

	return {
		chrome: {
			storage: { local, onChanged: { addListener: (fn) => changeListeners.push(fn) } },
			runtime: { getURL: (p) => `chrome-extension://test/${p}` }
		},
		data
	};
}

/** Promise flavour of the storage calls. */
function promiseStorage(fake) {
	const area = fake.chrome.storage.local;
	return {
		get: (keys) => new Promise((r) => area.get(keys, r)),
		set: (obj) => new Promise((r) => area.set(obj, r)),
		remove: (keys) => new Promise((r) => area.remove(keys, r))
	};
}

module.exports = { createFakeChrome, promiseStorage };
