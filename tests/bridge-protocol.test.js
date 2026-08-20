// @vitest-environment jsdom

// Behavioral tests for the content-script side of the postMessage bridge
// (src/content/bridge-client.js) against the documented wire protocol:
//
//   content script  -> window.postMessage({cc:'ClaudeCounter', type:'cc:request', requestId, kind, payload}, '*')
//   page script     -> window.postMessage({cc:'ClaudeCounter', type:'cc:response', requestId, ok, payload, error}, '*')
//   page script     -> window.postMessage({cc:'ClaudeCounter', type:'<event>', payload}, '*')  (events)
//
// The fake here replaces the *other process* (the injected page script), never
// the unit under test. jsdom's window.postMessage does not set event.source
// (known limitation), so the fake page side replies with a hand-dispatched
// MessageEvent carrying `source: window` — exactly what a real same-window
// postMessage delivers. That same knob lets us test the client's
// source-filtering behavior directly.

import { describe, it, expect, afterEach } from 'vitest';

await import('../src/content/constants.js');
await import('../src/content/bridge-client.js');
const CC = globalThis.ClaudeCounter;

function reply(data, { source = window } = {}) {
	window.dispatchEvent(new MessageEvent('message', { data, source }));
}

const installed = [];
function onRequest(handler) {
	const listener = (event) => {
		const d = event.data;
		if (!d || d.cc !== 'ClaudeCounter' || d.type !== 'cc:request') return;
		handler(d);
	};
	window.addEventListener('message', listener);
	installed.push(listener);
}

afterEach(() => {
	while (installed.length) window.removeEventListener('message', installed.pop());
});

describe('request/response', () => {
	it('resolves with the payload of a matching cc:response', async () => {
		let seen; // asserted after the await — a throw inside the listener would misreport as a timeout
		onRequest((req) => {
			seen = req;
			reply({ cc: 'ClaudeCounter', type: 'cc:response', requestId: req.requestId, ok: true, payload: { five_hour: 42 } });
		});
		const result = await CC.bridge.request('usage', { orgId: 'org-123' }, { timeoutMs: 1000 });
		expect(seen.kind).toBe('usage');
		expect(seen.payload).toEqual({ orgId: 'org-123' });
		expect(result).toEqual({ five_hour: 42 });
	});

	it('rejects with the reported error when ok is false', async () => {
		onRequest((req) => {
			reply({ cc: 'ClaudeCounter', type: 'cc:response', requestId: req.requestId, ok: false, error: 'no such org' });
		});
		await expect(CC.bridge.request('usage', { orgId: 'bad' }, { timeoutMs: 1000 })).rejects.toThrow('no such org');
	});

	it('times out when the page side never answers', async () => {
		await expect(CC.bridge.request('conversation', { conversationId: 'c1' }, { timeoutMs: 60 })).rejects.toThrow(
			/timed out/
		);
	});

	it('ignores responses lacking the cc marker', async () => {
		onRequest((req) => {
			// A same-shape message without the marker must be ignored...
			reply({ type: 'cc:response', requestId: req.requestId, ok: true, payload: 'unmarked' });
			// ...so the later, properly marked response is the one that wins.
			reply({ cc: 'ClaudeCounter', type: 'cc:response', requestId: req.requestId, ok: true, payload: 'marked' });
		});
		const result = await CC.bridge.request('hash', { text: 'x' }, { timeoutMs: 1000 });
		expect(result).toBe('marked');
	});

	it('ignores responses whose source is not this window', async () => {
		onRequest((req) => {
			reply(
				{ cc: 'ClaudeCounter', type: 'cc:response', requestId: req.requestId, ok: true, payload: 'foreign' },
				{ source: null }
			);
			reply({ cc: 'ClaudeCounter', type: 'cc:response', requestId: req.requestId, ok: true, payload: 'same-window' });
		});
		const result = await CC.bridge.request('hash', { text: 'y' }, { timeoutMs: 1000 });
		expect(result).toBe('same-window');
	});

	it('ignores responses for unknown request ids', async () => {
		onRequest((req) => {
			reply({ cc: 'ClaudeCounter', type: 'cc:response', requestId: 'not-this-one', ok: true, payload: 'stray' });
			reply({ cc: 'ClaudeCounter', type: 'cc:response', requestId: req.requestId, ok: true, payload: 'mine' });
		});
		const result = await CC.bridge.request('hash', { text: 'z' }, { timeoutMs: 1000 });
		expect(result).toBe('mine');
	});
});

describe('events', () => {
	it('delivers marked event payloads to subscribed listeners', () => {
		const received = [];
		const unsubscribe = CC.bridge.on('cc:message_limit', (payload) => received.push(payload));

		reply({ cc: 'ClaudeCounter', type: 'cc:message_limit', payload: { windows: { '5h': { utilization: 0.5 } } } });
		expect(received).toEqual([{ windows: { '5h': { utilization: 0.5 } } }]);

		reply({ type: 'cc:message_limit', payload: 'unmarked' }); // no marker -> not delivered
		reply({ cc: 'ClaudeCounter', type: 'cc:message_limit', payload: 'foreign' }, { source: null }); // wrong source
		expect(received).toHaveLength(1);

		unsubscribe();
		reply({ cc: 'ClaudeCounter', type: 'cc:message_limit', payload: 'after-unsubscribe' });
		expect(received).toHaveLength(1);
	});
});
