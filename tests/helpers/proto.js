'use strict';

// Tiny protobuf / Connect frame builder for tests. Only what the tests need.
// A message is an array of fields: [number, type, value]
//   'v' varint (Number), 's' string, 'b' raw bytes, 'm' nested message (array of fields), 'd' double (fixed64 LE)

function varintBytes(n) {
	const out = [];
	let v = n;
	while (v >= 128) {
		out.push((v % 128) | 0x80);
		v = Math.floor(v / 128);
	}
	out.push(v);
	return out;
}

function encodeFields(fields) {
	const parts = [];
	for (const [num, type, value] of fields) {
		if (type === 'v') {
			parts.push(Buffer.from([...varintBytes(num * 8), ...varintBytes(value)]));
		} else if (type === 'd') {
			const b = Buffer.alloc(8);
			b.writeDoubleLE(value, 0);
			parts.push(Buffer.from(varintBytes(num * 8 + 1)), b);
		} else {
			let body;
			if (type === 's') body = Buffer.from(value, 'utf8');
			else if (type === 'b') body = Buffer.from(value);
			else if (type === 'm') body = encodeFields(value);
			else throw new Error(`unknown field type ${type}`);
			parts.push(Buffer.from([...varintBytes(num * 8 + 2), ...varintBytes(body.length)]), body);
		}
	}
	return Buffer.concat(parts);
}

function connectFrame(flags, payload) {
	const body = Buffer.from(payload);
	const head = Buffer.alloc(5);
	head[0] = flags;
	head.writeUInt32BE(body.length, 1);
	return Buffer.concat([head, body]);
}

function plainFrame(fields) {
	return connectFrame(0, encodeFields(fields));
}

function endFrame(obj) {
	return connectFrame(2, Buffer.from(JSON.stringify(obj)));
}

function fromHex(hex) {
	return Buffer.from(hex.replace(/\s+/g, ''), 'hex');
}

// ---- event builders (shapes taken from the real captures) ----

function eventFrame(cursor, extraFields, counter = 1) {
	return plainFrame([[1, 'm', [[10, 'm', [[1, 's', cursor]]], [11, 'v', counter], ...extraFields]]]);
}

function textDeltaFrame(cursor, blockId, text) {
	return eventFrame(cursor, [[2, 'm', [[1, 's', blockId], [2, 's', text]]]]);
}

function blockDoneFrame(cursor, blockId, groupId, text) {
	return eventFrame(cursor, [[1, 'm', [[5, 'm', [[1, 's', blockId], [2, 's', groupId], [4, 'v', 1], [9, 's', text], [10, 'm', [[1, 'v', 2]]], [24, 'v', 1]]]]]]);
}

function sessionStatusFrame(cursor, sessionId, status) {
	return eventFrame(cursor, [[14, 'm', [[1, 'm', [[1, 's', sessionId]]], [2, 'v', status]]]], 2);
}

function keepaliveFrame() {
	return plainFrame([[1, 'm', [[6, 's', '']]]]);
}

// Snapshot-like payload (what the gzip frames carry). No limits inside.
function snapshotPayload(cursor, title, state) {
	const item = [
		[1, 's', '00000000-0000-4000-8000-000000000001'],
		...(title ? [[2, 's', title]] : []),
		[3, 'v', state],
		[4, 'm', [[1, 'v', 1791743562], [2, 'v', 964188000]]],
		[5, 'm', [[1, 'v', 1791743563], [2, 'v', 692117000]]],
		[6, 'm', [[2, 's', 'claude-haiku-5-5']]],
		[8, 'm', [[1, 's', 'type.googleapis.com/anthropic.bard.api.v1alpha.SandboxFileActivity']]]
	];
	return encodeFields([[1, 'm', [[10, 'm', [[1, 's', cursor]]], [11, 'v', 1], [1, 'm', [[2, 'm', item]]]]]]);
}

// Limits payload built from scratch, so tests can vary the window order and field numbers.
// A utilization of null leaves the double out, the way the server does for 0.0 (proto3 default).
// Every event has its own id, as on the real stream; a test that wants a replay passes the same cursor again.
let cursorCounter = 0;
function limitsPayload({ cursor = `${1791743563668 + 1000 * ++cursorCounter}-0`, windows, claim = 'five_hour', overageReason = 'overage_not_provisioned', eventField = 4, windowField = 13 } = {}) {
	const entries = windows.map(([key, status, resetsAt, utilization]) => [
		windowField,
		'm',
		[[1, 's', key], [2, 'm', [[1, 'v', status], [2, 'm', [[1, 'v', resetsAt]]], ...(utilization === null ? [] : [[3, 'd', utilization]])]]]
	]);
	const limits = [[1, 'v', 1], [5, 'v', 0], [6, 's', overageReason], [9, 's', claim], ...entries];
	return encodeFields([[1, 'm', [[10, 'm', [[1, 's', cursor]]], [11, 'v', 2], [eventField, 'm', limits]]]]);
}

module.exports = {
	encodeFields,
	connectFrame,
	plainFrame,
	endFrame,
	fromHex,
	eventFrame,
	textDeltaFrame,
	blockDoneFrame,
	sessionStatusFrame,
	keepaliveFrame,
	snapshotPayload,
	limitsPayload
};
