'use strict';

// Runs the real content scripts (src/content/*.js) in a vm context with a fake window, document and
// chrome.storage, so tests exercise the shipped files. Only what the scripts touch is faked.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createFakeChrome } = require('./fake-chrome');

const SRC = path.join(__dirname, '../../src');

function createFakeDocument() {
	const documentElement = { dataset: {} };
	return {
		documentElement,
		body: null,
		cookie: '',
		hidden: false,
		contains: () => false,
		getElementById: () => null,
		querySelector: () => null,
		querySelectorAll: () => [],
		createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, appendChild() {}, addEventListener() {} }),
		addEventListener() {}
	};
}

function createContentEnv({ files, storage = {}, pathname = '/chat/00000000-0000-4000-8000-000000000001', extraGlobals = {} }) {
	const fake = createFakeChrome(storage);
	const listeners = {};
	const document = createFakeDocument();
	const location = { pathname };

	const window = {
		location,
		innerWidth: 1280,
		innerHeight: 800,
		addEventListener(type, fn) {
			(listeners[type] = listeners[type] || []).push(fn);
		},
		removeEventListener(type, fn) {
			listeners[type] = (listeners[type] || []).filter((f) => f !== fn);
		},
		dispatchEvent(event) {
			for (const fn of listeners[event.type] || []) fn(event);
		},
		postMessage(data) {
			setImmediate(() => {
				for (const fn of listeners.message || []) fn({ source: window, data });
			});
		}
	};

	const context = vm.createContext({
		window,
		document,
		location,
		navigator: { userAgent: 'test-agent' },
		chrome: fake.chrome,
		console,
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
		setImmediate,
		atob,
		btoa,
		TextEncoder,
		TextDecoder,
		Blob,
		DecompressionStream,
		Uint8Array,
		ArrayBuffer,
		Promise,
		Date,
		JSON,
		Math,
		Object,
		Array,
		Set,
		Map,
		WeakSet,
		Number,
		String,
		RegExp,
		Error,
		Symbol,
		URL,
		crypto: require('crypto').webcrypto,
		fetch: async () => {
			throw new Error('fetch is not available in tests');
		},
		...extraGlobals
	});
	context.globalThis = context;

	function load(list) {
		for (const file of list) {
			vm.runInContext(fs.readFileSync(path.join(SRC, file), 'utf8'), context, { filename: file });
		}
	}
	load(files);

	return {
		context,
		window,
		document,
		location,
		chrome: fake.chrome,
		storageData: fake.data,
		load,
		/** Deliver a message to the content script the way the page world does. */
		send(data) {
			window.postMessage({ cc: 'ClaudeCounter', ...data });
		},
		/** A message from another window (an iframe, for example). */
		sendForeign(data) {
			setImmediate(() => {
				for (const fn of listeners.message || []) fn({ source: {}, data: { cc: 'ClaudeCounter', ...data } });
			});
		},
		fire(type, event = {}) {
			for (const fn of listeners[type] || []) fn({ type, ...event });
		},
		async settle(ms = 20) {
			await new Promise((r) => setTimeout(r, ms));
			await new Promise((r) => setImmediate(r));
		}
	};
}

module.exports = { createContentEnv, createFakeDocument, SRC };
