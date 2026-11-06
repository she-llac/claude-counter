(() => {
	'use strict';

	const GC = (globalThis.GeminiCounter = globalThis.GeminiCounter || {});

	function getRuntime() {
		return globalThis.browser?.runtime || globalThis.chrome?.runtime || null;
	}

	class BridgeClient {
		constructor() {
			this._listeners = new Map();

			window.addEventListener('message', (event) => {
				if (event.source !== window) return;
				const data = event.data;
				if (!data || data.gc !== GC.CONST.MARKER) return;
				this._emit(data.type, data.payload);
			});
		}

		_emit(type, payload) {
			const listeners = this._listeners.get(type);
			if (!listeners) return;
			for (const fn of listeners) {
				try {
					fn(payload);
				} catch {
					// one bad listener must not stop the others
				}
			}
		}

		on(type, fn) {
			if (!this._listeners.has(type)) this._listeners.set(type, new Set());
			this._listeners.get(type).add(fn);
			return () => this._listeners.get(type)?.delete(fn);
		}
	}

	let bridgeReadyPromise = null;

	function injectBridgeOnce() {
		if (bridgeReadyPromise) return bridgeReadyPromise;

		const runtime = getRuntime();
		if (!runtime?.getURL) return Promise.resolve(false);

		if (document.getElementById(GC.CONST.BRIDGE_SCRIPT_ID)) {
			return Promise.resolve(true);
		}

		bridgeReadyPromise = new Promise((resolve) => {
			const script = document.createElement('script');
			script.id = GC.CONST.BRIDGE_SCRIPT_ID;
			script.src = runtime.getURL('src/gemini/injected/bridge.js');
			script.onload = () => resolve(true);
			script.onerror = () => resolve(false);
			(document.head || document.documentElement).appendChild(script);
		});

		return bridgeReadyPromise;
	}

	GC.bridge = new BridgeClient();
	GC.injectBridgeOnce = injectBridgeOnce;
})();
