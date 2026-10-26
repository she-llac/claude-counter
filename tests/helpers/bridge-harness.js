'use strict';

// Runs the real src/injected/bridge.js against a fake window, so the tests exercise the shipped
// file and not a copy. bridge.js is a plain script; it is wrapped in a function that receives
// the few browser objects it touches. Everything else (Response, ReadableStream, URL, ...) are
// the real Node globals, the same ones the page would see.

const fs = require('fs');
const path = require('path');

const BRIDGE_PATH = path.join(__dirname, '../../src/injected/bridge.js');
const STREAM_URL = 'https://claude.ai/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/StreamTimeline';
const PERFORM_URL = 'https://claude.ai/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/PerformAction';

function createBridgeEnv({ originalFetch, location } = {}) {
	const source = fs.readFileSync(BRIDGE_PATH, 'utf8');
	const messages = [];
	const listeners = {};

	const window = {
		fetch: originalFetch,
		location: location || { pathname: '/chat/00000000-0000-4000-8000-000000000001' },
		postMessage(data) {
			messages.push(data);
			for (const fn of listeners.message || []) fn({ source: window, data });
		},
		addEventListener(type, fn) {
			(listeners[type] = listeners[type] || []).push(fn);
		},
		removeEventListener() {},
		dispatchEvent() {}
	};
	const history = { pushState() {}, replaceState() {} };
	const documentElement = { dataset: {} };
	const document = { documentElement };

	new Function('window', 'history', 'document', 'location', source)(window, history, document, window.location);

	return {
		window,
		messages,
		documentElement,
		events(type) {
			return messages.filter((m) => m && m.cc === 'ClaudeCounter' && m.type === type).map((m) => m.payload);
		},
		fetch: (...args) => window.fetch(...args),
		/** Send a request to the bridge the way the content script does. */
		request(kind, payload) {
			const requestId = `t-${Math.random().toString(16).slice(2)}`;
			window.postMessage({ cc: 'ClaudeCounter', type: 'cc:request', requestId, kind, payload });
			return requestId;
		},
		post(type, payload) {
			window.postMessage({ cc: 'ClaudeCounter', type, payload });
		}
	};
}

function streamResponse(chunks, { contentType = 'application/connect+proto', status = 200, delayMs = 0 } = {}) {
	let i = 0;
	const body = new ReadableStream({
		async pull(controller) {
			if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
			if (i < chunks.length) controller.enqueue(new Uint8Array(chunks[i++]));
			else controller.close();
		}
	});
	return new Response(body, { status, headers: { 'content-type': contentType } });
}

async function readAll(response) {
	return Buffer.from(await response.arrayBuffer());
}

/** Let the bridge's background reader (and gunzip) finish. */
async function settle(ms = 30) {
	await new Promise((r) => setTimeout(r, ms));
	await new Promise((r) => setImmediate(r));
}

function splitAt(buffer, offsets) {
	const parts = [];
	let prev = 0;
	for (const o of [...offsets, buffer.length]) {
		parts.push(buffer.subarray(prev, o));
		prev = o;
	}
	return parts.filter((p) => p.length > 0);
}

module.exports = { createBridgeEnv, streamResponse, readAll, settle, splitAt, STREAM_URL, PERFORM_URL };
