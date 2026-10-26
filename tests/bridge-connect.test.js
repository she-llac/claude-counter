'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');

const fixtures = require('./fixtures/frames.json');
const proto = require('./helpers/proto');
const { createBridgeEnv, streamResponse, readAll, settle, splitAt, STREAM_URL, PERFORM_URL } = require('./helpers/bridge-harness');

const frame = (name) => proto.fromHex(fixtures.frames[name].hex);
const EXPECTED = {
	'5h': { status: 1, resets_at: 1791749400, utilization: 0.76 },
	'7d': { status: 1, resets_at: 1791990000, utilization: 0.25 }
};

// Fail a test if anything rejects without a handler (the bridge must never leak rejections into the page).
const unhandled = [];
process.on('unhandledRejection', (reason) => unhandled.push(reason));
test.afterEach(() => {
	assert.deepEqual(unhandled.splice(0), [], 'unhandled rejection');
});

async function runStream(chunks, { contentType } = {}) {
	let response;
	const env = createBridgeEnv({
		originalFetch: async () => {
			response = streamResponse(chunks, { contentType });
			return response;
		}
	});
	const returned = await env.fetch(STREAM_URL, { method: 'POST', body: new Uint8Array([0, 0, 0, 0, 0]) });
	const bytes = await readAll(returned);
	await settle();
	return { env, returned, response, bytes };
}

function limits(env) {
	return env.events('cc:message_limit');
}

test('T01 limits frame: windows, claim and overage reason are read', async () => {
	const { env } = await runStream([frame('limits_5h_first')]);
	assert.equal(limits(env).length, 1);
	const [msg] = limits(env);
	assert.deepEqual(msg.windows, EXPECTED);
	assert.equal(msg.representativeClaim, fixtures.expected_limits.representativeClaim);
	assert.equal(msg.overageDisabledReason, fixtures.expected_limits.overageDisabledReason);
	assert.equal(env.events('cc:turn_end').length, 1);
});

test('T01b the shape matches what the old SSE path delivers (utilization is a fraction, resets_at epoch seconds)', async () => {
	const { env } = await runStream([frame('limits_5h_first')]);
	const [msg] = limits(env);
	const old = fixtures.old_sse_message_limit.message_limit;
	assert.deepEqual(Object.keys(msg.windows['5h']).sort(), ['resets_at', 'status', 'utilization']);
	assert.equal(typeof msg.windows['5h'].utilization, 'number');
	assert.equal(typeof msg.windows['5h'].resets_at, 'number');
	assert.equal(typeof old.windows['5h'].utilization, 'number');
	assert.ok(msg.windows['5h'].utilization <= 1);
});

test('T02 window order does not matter (real 7d-first and 5h-first frames)', async () => {
	const a = await runStream([frame('limits_7d_first')]);
	const b = await runStream([frame('limits_5h_first')]);
	const c = await runStream([frame('limits_5h_first_turn2')]);
	assert.deepEqual(limits(a.env)[0].windows, EXPECTED);
	assert.deepEqual(limits(a.env)[0].windows, limits(b.env)[0].windows);
	assert.deepEqual(limits(b.env)[0].windows, limits(c.env)[0].windows);
});

test('T03 keepalive frames produce nothing', async () => {
	const { env } = await runStream([frame('keepalive'), frame('keepalive'), proto.keepaliveFrame()]);
	assert.equal(limits(env).length, 0);
	assert.equal(env.events('cc:turn_end').length, 0);
});

test('T04 text deltas, block done, session status and snapshots are ignored', async () => {
	const frames = [
		frame('text_delta_emoji'),
		proto.textDeltaFrame('1791743563661-0', 'cblk_aaaaaaaaaaaaaaaaaaaaaaaa', 'Contains 5h and 7d as plain text'),
		proto.blockDoneFrame('1791743563661-1', 'cblk_aaaaaaaaaaaaaaaaaaaaaaaa', 'dgrp_bbbbbbbbbbbbbbbbbbbbbbbb', 'Ahoj! 5h 7d'),
		proto.sessionStatusFrame('1791744119988-0', 'sess_0e23b6d9f7e814d7', 2),
		proto.connectFrame(0, proto.snapshotPayload('1791743563016-0', 'Greeting 5h', 1))
	];
	const { env } = await runStream(frames);
	assert.equal(limits(env).length, 0);
	assert.equal(env.events('cc:turn_end').length, 0);
});

test('T05 end frames (cadence, max_age, errors) end the stream cleanly', async () => {
	const frames = [
		proto.endFrame({ metadata: { 'Stream-Close-Reason': ['cadence'] } }),
		proto.endFrame({ metadata: { 'Stream-Close-Reason': ['max_age'] } }),
		proto.endFrame({ error: { code: 'not_found', message: 'This conversation could not be found.', details: [] }, metadata: {} }),
		proto.endFrame({ error: { code: 'resource_exhausted', message: 'Too many recent attempts' } }),
		frame('end_cadence')
	];
	const { env } = await runStream(frames);
	assert.equal(limits(env).length, 0);
});

test('T06 chunking: same result for every split point and for 1-byte chunks', async () => {
	const whole = Buffer.concat([frame('keepalive'), frame('text_delta_emoji'), frame('limits_7d_first'), frame('end_cadence')]);
	for (let i = 0; i <= whole.length; i++) {
		const { env } = await runStream(splitAt(whole, [i]));
		assert.equal(limits(env).length, 1, `split at ${i}`);
		assert.deepEqual(limits(env)[0].windows, EXPECTED, `split at ${i}`);
	}
	const oneByte = splitAt(whole, [...Array(whole.length).keys()].slice(1));
	const { env } = await runStream(oneByte);
	assert.equal(limits(env).length, 1);
	assert.deepEqual(limits(env)[0].windows, EXPECTED);
});

test('T06b two splits inside the limits frame still give one result', async () => {
	const whole = Buffer.concat([frame('keepalive'), frame('limits_5h_first'), frame('end_cadence')]);
	for (const [a, b] of [[3, 20], [10, 11], [9 + 4, 9 + 6], [9 + 60, 9 + 61], [30, 100]]) {
		const { env } = await runStream(splitAt(whole, [a, b]));
		assert.equal(limits(env).length, 1, `splits ${a},${b}`);
	}
});

test('T07 gzip frames: packed limits are read, snapshots and corrupted frames are ignored', async () => {
	const payload = frame('limits_5h_first').subarray(5);
	const gzFrame = proto.connectFrame(1, zlib.gzipSync(payload));
	const { env } = await runStream([gzFrame]);
	assert.equal(limits(env).length, 1);
	assert.deepEqual(limits(env)[0].windows, EXPECTED);

	const snapshot = proto.connectFrame(1, zlib.gzipSync(proto.snapshotPayload('1791743563016-0', 'Greeting', 1)));
	const corrupted = Buffer.from(gzFrame);
	corrupted[12] ^= 0xff;
	corrupted[20] ^= 0xff;
	const garbage = proto.connectFrame(1, Buffer.from('this is not gzip at all'));
	const { env: env2 } = await runStream([snapshot, corrupted, garbage, frame('limits_7d_first')]);
	assert.equal(limits(env2).length, 1, 'only the real plain limits frame counts');
});

test('T07b a gzip frame keeps its order relative to plain frames', async () => {
	const gz = proto.connectFrame(1, zlib.gzipSync(proto.limitsPayload({ windows: [['5h', 1, 1791749400, 0.5], ['7d', 1, 1791990000, 0.1]] })));
	const plain = proto.connectFrame(0, proto.limitsPayload({ windows: [['5h', 1, 1791749400, 0.6], ['7d', 1, 1791990000, 0.2]] }));
	const { env } = await runStream([gz, plain]);
	const values = limits(env).map((m) => m.windows['5h'].utilization);
	assert.deepEqual(values, [0.5, 0.6]);
});

test('T08 old SSE path: unchanged result, Connect handler not involved', async () => {
	const sse = `event: message_limit\ndata: ${JSON.stringify(fixtures.old_sse_message_limit)}\n\n`;
	let response;
	const env = createBridgeEnv({
		originalFetch: async () => {
			response = streamResponse([Buffer.from(sse)], { contentType: 'text/event-stream; charset=utf-8' });
			return response;
		}
	});
	const returned = await env.fetch('https://claude.ai/api/organizations/org-1/chat_conversations/c-1/completion', { method: 'POST' });
	await readAll(returned);
	await settle();

	assert.deepEqual(limits(env), [fixtures.old_sse_message_limit.message_limit]);
	assert.equal(env.events('cc:turn_end').length, 0, 'the old path does not emit turn_end');
	assert.equal(env.events('cc:generation_start').length, 1);
});

test('T08b the SSE handler is not invoked for StreamTimeline even if a frame looks like SSE text', async () => {
	const fake = Buffer.from(`event: message_limit\ndata: ${JSON.stringify(fixtures.old_sse_message_limit)}\n\n`);
	const { env } = await runStream([fake]);
	assert.equal(limits(env).length, 0);
});

test('T10 repeated limits events: delivered each time, identical values are fine, empty ones are ignored', async () => {
	const frames = [frame('limits_5h_first'), frame('limits_7d_first'), frame('limits_5h_first_turn2')];
	const { env } = await runStream(frames);
	assert.equal(limits(env).length, 3);
	for (const m of limits(env)) assert.deepEqual(m.windows, EXPECTED);

	const noWindows = proto.connectFrame(0, proto.limitsPayload({ windows: [] }));
	const { env: env2 } = await runStream([noWindows]);
	assert.equal(limits(env2).length, 0);
	assert.equal(env2.events('cc:turn_end').length, 0);

	const changed = proto.connectFrame(0, proto.limitsPayload({ windows: [['7d', 1, 1791990000, 0.3], ['5h', 1, 1791749400, 0.8]] }));
	const { env: env3 } = await runStream([frame('limits_5h_first'), changed]);
	assert.equal(limits(env3).at(-1).windows['5h'].utilization, 0.8);
	assert.equal(limits(env3).at(-1).windows['7d'].utilization, 0.3);
});

test('T10b the same event sent again (stream reopened) is not a new reply, a new event with identical limits is', async () => {
	// same event twice in one stream, and again in a second stream of the same page
	let response;
	const env = createBridgeEnv({
		originalFetch: async () => {
			response = streamResponse([frame('limits_5h_first'), frame('limits_5h_first')]);
			return response;
		}
	});
	await readAll(await env.fetch(STREAM_URL, { method: 'POST', body: new Uint8Array([0, 0, 0, 0, 0]) }));
	await settle();
	await readAll(await env.fetch(STREAM_URL, { method: 'POST', body: new Uint8Array([0, 0, 0, 0, 0]) }));
	await settle();
	assert.equal(limits(env).length, 1);
	assert.equal(env.events('cc:turn_end').length, 1, 'no second cache timer for a replayed event');

	// real fixtures: the second reply has other event id and the very same limits
	const { env: env2 } = await runStream([frame('limits_5h_first'), frame('limits_5h_first_turn2')]);
	assert.equal(limits(env2).length, 2);
	assert.equal(env2.events('cc:turn_end').length, 2);
});

test('T10c only the last 32 event ids are remembered', async () => {
	const frames = [];
	for (let i = 0; i < 40; i++) frames.push(proto.connectFrame(0, proto.limitsPayload({ windows: [['5h', 1, 1791749400, 0.5]], cursor: `1791800000${String(i).padStart(3, '0')}-0` })));
	const first = frames[0];
	const { env } = await runStream([...frames, first]);
	assert.equal(limits(env).length, 41, 'the first event was forgotten by then, so it counts again');
	const { env: env2 } = await runStream([...frames.slice(0, 31), frames[10]]);
	assert.equal(limits(env2).length, 31, 'one of the last 32 is still known');
});

test('T11 page is not disturbed: identical bytes, same Response object, body not locked', async () => {
	const whole = Buffer.concat([frame('keepalive'), frame('limits_5h_first'), frame('end_cadence')]);
	const { env, returned, response, bytes } = await runStream(splitAt(whole, [7, 50, 90]));
	assert.equal(returned, response);
	assert.deepEqual(bytes, whole);
	assert.equal(limits(env).length, 1);
});

test('T11b page cancelling or aborting the stream is not an error', async () => {
	// Page cancels after the first chunk
	let response;
	const env = createBridgeEnv({
		originalFetch: async () => {
			response = streamResponse([frame('keepalive'), frame('limits_5h_first')], { delayMs: 5 });
			return response;
		}
	});
	const returned = await env.fetch(STREAM_URL, { method: 'POST' });
	const reader = returned.body.getReader();
	await reader.read();
	await reader.cancel();
	await settle(60);

	// Network error in the middle of the stream (ERR_ABORTED in Chrome)
	const failing = new ReadableStream({
		start(controller) {
			controller.enqueue(new Uint8Array(frame('keepalive')));
			setTimeout(() => controller.error(new TypeError('network error')), 5);
		}
	});
	const env2 = createBridgeEnv({ originalFetch: async () => new Response(failing, { headers: { 'content-type': 'application/connect+proto' } }) });
	const returned2 = await env2.fetch(STREAM_URL, { method: 'POST' });
	await assert.rejects(() => readAll(returned2), /network error/);
	await settle(60);
	assert.equal(limits(env2).length, 0);
});

test('T11c truncated stream (cut inside a frame) produces nothing and no error', async () => {
	const cut = frame('limits_5h_first').subarray(0, 60);
	const { env } = await runStream([cut]);
	assert.equal(limits(env).length, 0);
});

test('T11d absurd frame length stops parsing quietly', async () => {
	const evil = Buffer.from([0, 0xff, 0xff, 0xff, 0xff, 1, 2, 3]);
	const { env } = await runStream([evil, frame('limits_5h_first')]);
	assert.equal(limits(env).length, 0);
});

test('T12 other requests are untouched and emit nothing new', async () => {
	const urls = [
		'https://claude.ai/api/organizations/org-1/usage',
		'https://claude.ai/api/organizations/org-1/chat_conversations/c-1?tree=true&rendering_mode=messages&render_all_tools=true',
		'https://claude.ai/api/event_logging/batch',
		'https://claude.ai/api/rum',
		'https://claude.ai/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/ReportViewing'
	];
	for (const url of urls) {
		let original;
		const env = createBridgeEnv({
			originalFetch: async () => {
				original = new Response('{}', { headers: { 'content-type': 'application/json' } });
				return original;
			}
		});
		const returned = await env.fetch(url, { method: url.includes('event_logging') || url.includes('rum') || url.includes('Report') ? 'POST' : 'GET' });
		await settle(10);
		assert.equal(returned, original, url);
		for (const type of ['cc:message_limit', 'cc:turn_end', 'cc:generation_start']) {
			assert.equal(env.events(type).length, 0, `${type} for ${url}`);
		}
	}
});

test('T13 PerformAction is passed through unchanged and is not treated as a turn start', async () => {
	let original;
	const env = createBridgeEnv({
		originalFetch: async () => {
			original = new Response(null, { status: 200, headers: { 'content-type': 'application/proto' } });
			return original;
		}
	});
	const returned = await env.fetch(PERFORM_URL, { method: 'POST', body: new Uint8Array([1, 2, 3]) });
	await settle(10);
	assert.equal(returned, original);
	assert.equal(env.events('cc:generation_start').length, 0, 'the page calls PerformAction when a chat is opened or while typing');
	assert.equal(env.events('cc:message_limit').length, 0);
});

test('T13b StreamTimeline requests given as a Request object are recognised too', async () => {
	const response = streamResponse([frame('limits_5h_first')]);
	const env2 = createBridgeEnv({ originalFetch: async () => response });
	const returned = await env2.fetch(new Request(STREAM_URL, { method: 'POST', body: 'x' }));
	await readAll(returned);
	await settle();
	assert.equal(limits(env2).length, 1);
});

test('T13c the old generation_start triggers still work', async () => {
	const env = createBridgeEnv({ originalFetch: async () => new Response('', { status: 200 }) });
	await env.fetch('https://claude.ai/api/organizations/o/chat_conversations/c/completion', { method: 'POST' });
	await env.fetch('https://claude.ai/api/organizations/o/chat_conversations/c/retry_completion', { method: 'POST' });
	await env.fetch('https://claude.ai/api/organizations/o/chat_conversations/c/completion', { method: 'GET' });
	assert.equal(env.events('cc:generation_start').length, 2);
});

test('field numbers changed: the fallback finds the windows by their "5h" / "7d" keys', async () => {
	const moved = proto.connectFrame(
		0,
		proto.limitsPayload({ windows: [['7d', 1, 1791990000, 0.25], ['5h', 1, 1791749400, 0.76]], eventField: 7, windowField: 20 })
	);
	const { env } = await runStream([moved]);
	assert.equal(limits(env).length, 1);
	assert.deepEqual(limits(env)[0].windows, EXPECTED);
	assert.equal(limits(env)[0].representativeClaim, 'five_hour');
});

test('fallback does not invent limits from unrelated data', async () => {
	// an entry with the right key but no double, and a double outside the plausible range
	const noDouble = proto.encodeFields([[1, 'm', [[7, 'm', [[20, 'm', [[1, 's', '5h'], [2, 'm', [[1, 'v', 1]]]]]]]]]]);
	const huge = proto.encodeFields([[1, 'm', [[7, 'm', [[20, 'm', [[1, 's', '5h'], [2, 'm', [[1, 'v', 1], [3, 'd', 1e9]]]]]]]]]]);
	const { env } = await runStream([proto.connectFrame(0, noDouble), proto.connectFrame(0, huge)]);
	assert.equal(limits(env).length, 0);
});

test('a random binary frame never throws', async () => {
	const frames = [];
	let seed = 12345;
	const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
	for (let i = 0; i < 200; i++) {
		const bytes = Buffer.alloc(1 + Math.floor(rnd() * 120));
		for (let j = 0; j < bytes.length; j++) bytes[j] = Math.floor(rnd() * 256);
		frames.push(proto.connectFrame(rnd() < 0.2 ? 1 : 0, bytes));
	}
	const { env } = await runStream(frames);
	assert.equal(limits(env).length, 0);
});

test('bridge still answers the content script requests (hash)', async () => {
	const env = createBridgeEnv({ originalFetch: async () => new Response('') });
	const id = env.request('hash', { text: 'abc' });
	await settle(20);
	const reply = env.messages.find((m) => m.type === 'cc:response' && m.requestId === id);
	assert.ok(reply && reply.ok);
	assert.match(reply.payload.hash, /^[0-9a-f]{16}$/);
});

test('T14 a window without a utilization double is a window with nothing used (proto3 leaves out 0.0)', async () => {
	const payload = proto.limitsPayload({ windows: [['5h', 1, 1791749400, null], ['7d', 1, 1791990000, 0.25]] });
	const { env } = await runStream([proto.connectFrame(0, payload)]);
	assert.equal(limits(env).length, 1);
	const [msg] = limits(env);
	assert.deepEqual(msg.windows['5h'], { status: 1, resets_at: 1791749400, utilization: 0 });
	assert.equal(msg.windows['7d'].utilization, 0.25);
});

test('T14b an entry with neither status, reset time nor utilization is not invented', async () => {
	const payload = proto.limitsPayload({ windows: [['5h', 0, 0, null]] });
	const { env } = await runStream([proto.connectFrame(0, payload)]);
	const [msg] = limits(env);
	// status 0 and resets_at 0 are still present as fields, so the entry is a window of zero use;
	// what must never happen is a utilization that is NaN or missing
	if (msg) assert.ok(Number.isFinite(msg.windows['5h'].utilization));
});

test('T15 conversation request: an error status or an error body is a failed request, not an empty chat', async () => {
	const cases = [
		['HTTP 429', () => new Response('{"error":"slow down"}', { status: 429 })],
		['error body with 200', () => new Response('{"type":"error","error":{"type":"overloaded_error"}}', { status: 200 })],
		['not JSON', () => new Response('<html>blocked</html>', { status: 200 })]
	];
	for (const [name, make] of cases) {
		const env = createBridgeEnv({ originalFetch: async () => make() });
		const id = env.request('conversation', { orgId: 'o', conversationId: 'c' });
		await settle(30);
		const reply = env.messages.find((m) => m.type === 'cc:response' && m.requestId === id);
		assert.ok(reply, name);
		assert.equal(reply.ok, false, name);
		assert.equal(env.events('cc:conversation').length, 0, name);
	}
});

test('T15b conversation request: a real conversation is delivered and answered', async () => {
	const body = { uuid: 'c', chat_messages: [], current_leaf_message_uuid: null };
	const env = createBridgeEnv({ originalFetch: async () => new Response(JSON.stringify(body), { status: 200 }) });
	const id = env.request('conversation', { orgId: 'o', conversationId: 'c' });
	await settle(30);
	const reply = env.messages.find((m) => m.type === 'cc:response' && m.requestId === id);
	assert.equal(reply.ok, true);
	assert.equal(env.events('cc:conversation').length, 1);
});
