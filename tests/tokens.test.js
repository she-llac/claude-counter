'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '../src');
const ROOT = '00000000-0000-4000-8000-000000000000';

// The real tokenizer and tokens.js, as the extension loads them.
const context = vm.createContext({
	console,
	TextEncoder,
	TextDecoder,
	Uint8Array,
	Uint16Array,
	Uint32Array,
	ArrayBuffer,
	RegExp,
	Error,
	Symbol,
	Number,
	String,
	BigInt,
	Date,
	Map,
	Set,
	WeakSet,
	JSON,
	Math,
	Object,
	Array,
	Promise,
	crypto: require('crypto').webcrypto
});
context.globalThis = context;
for (const file of ['content/constants.js', 'vendor/o200k_base.js', 'content/tokens.js']) {
	vm.runInContext(fs.readFileSync(path.join(SRC, file), 'utf8'), context, { filename: file });
}
const { computeConversationMetrics } = context.ClaudeCounter.tokens;

const msg = (uuid, parent, sender, createdAt, content, extra = {}) => ({
	uuid,
	parent_message_uuid: parent,
	sender,
	created_at: createdAt,
	content,
	attachments: [],
	...extra
});
const text = (t) => ({ type: 'text', text: t });

test('TK01 token count of a simple chat and the end of the cache window', async () => {
	const conv = {
		current_leaf_message_uuid: 'm2',
		chat_messages: [
			msg('m1', ROOT, 'human', '2026-10-14T08:11:59.000000Z', [text('Hello there')]),
			msg('m2', 'm1', 'assistant', '2026-10-14T08:12:00.339644Z', [text('Hi! How can I help you today?')])
		]
	};
	const m = await computeConversationMetrics(conv);
	assert.equal(m.trunkMessageCount, 2);
	assert.ok(m.totalTokens > 5 && m.totalTokens < 30, `tokens ${m.totalTokens}`);
	assert.equal(m.cachedUntil, Date.parse('2026-10-14T08:12:00.339644Z') + 5 * 60 * 1000);
});

test('TK02 only the current branch is counted', async () => {
	const conv = {
		current_leaf_message_uuid: 'b2',
		chat_messages: [
			msg('m1', ROOT, 'human', '2026-10-14T08:00:00Z', [text('question')]),
			msg('a1', 'm1', 'assistant', '2026-10-14T08:00:05Z', [text('first answer '.repeat(200))]),
			msg('b2', 'm1', 'assistant', '2026-10-14T08:01:00Z', [text('short')])
		]
	};
	const m = await computeConversationMetrics(conv);
	assert.equal(m.trunkMessageCount, 2);
	assert.ok(m.totalTokens < 20);
});

test('TK03 thinking and images are not counted, tool calls and results are', async () => {
	const base = [msg('m1', ROOT, 'human', '2026-10-14T08:00:00Z', [text('go')])];
	const plain = { current_leaf_message_uuid: 'a1', chat_messages: [...base, msg('a1', 'm1', 'assistant', '2026-10-14T08:00:05Z', [text('done')])] };
	const withThinking = {
		current_leaf_message_uuid: 'a1',
		chat_messages: [
			...base,
			msg('a1', 'm1', 'assistant', '2026-10-14T08:00:05Z', [
				{ type: 'thinking', thinking: 'secret reasoning '.repeat(500) },
				{ type: 'image', source: { data: 'x'.repeat(5000) } },
				text('done')
			])
		]
	};
	const withTools = {
		current_leaf_message_uuid: 'a1',
		chat_messages: [
			...base,
			msg('a1', 'm1', 'assistant', '2026-10-14T08:00:05Z', [
				{ type: 'tool_use', id: 't1', name: 'search', input: { query: 'weather in Prague' } },
				{ type: 'tool_result', tool_use_id: 't1', is_error: false, content: [{ type: 'text', text: 'Sunny, 18 degrees' }] },
				text('done')
			])
		]
	};
	const a = await computeConversationMetrics(plain);
	const b = await computeConversationMetrics(withThinking);
	const c = await computeConversationMetrics(withTools);
	assert.equal(b.totalTokens, a.totalTokens);
	assert.ok(c.totalTokens > a.totalTokens + 10);
});

test('TK04 attachments with extracted text are counted', async () => {
	const conv = {
		current_leaf_message_uuid: 'm1',
		chat_messages: [msg('m1', ROOT, 'human', '2026-10-14T08:00:00Z', [text('see file')], { attachments: [{ extracted_content: 'lorem ipsum '.repeat(100) }] })]
	};
	const m = await computeConversationMetrics(conv);
	assert.ok(m.totalTokens > 150);
});

test('TK05 an assistant message that is still being written (empty content) does not break it', async () => {
	const conv = {
		current_leaf_message_uuid: 'a1',
		chat_messages: [msg('m1', ROOT, 'human', '2026-10-14T08:00:00Z', [text('hi')]), msg('a1', 'm1', 'assistant', '2026-10-14T08:00:01Z', [])]
	};
	const m = await computeConversationMetrics(conv);
	assert.equal(m.trunkMessageCount, 2);
	assert.equal(m.cachedUntil, Date.parse('2026-10-14T08:00:01Z') + 5 * 60 * 1000);
});

test('TK06 a chat without a leaf, without messages or a loop in the parents does not hang or throw', async () => {
	assert.equal((await computeConversationMetrics({ chat_messages: [] })).totalTokens, 0);
	assert.equal((await computeConversationMetrics({})).trunkMessageCount, 0);
	assert.equal((await computeConversationMetrics(null)).trunkMessageCount, 0);

	const loop = {
		current_leaf_message_uuid: 'a',
		chat_messages: [msg('a', 'b', 'assistant', '2026-10-14T08:00:00Z', [text('x')]), msg('b', 'a', 'human', '2026-10-14T08:00:00Z', [text('y')])]
	};
	const m = await computeConversationMetrics(loop);
	assert.equal(m.trunkMessageCount, 2);
});

test('TK07 a very long chat is counted in reasonable time', async () => {
	const messages = [];
	let parent = ROOT;
	for (let i = 0; i < 400; i++) {
		const id = `m${i}`;
		messages.push(msg(id, parent, i % 2 ? 'assistant' : 'human', new Date(Date.UTC(2026, 9, 14, 8, 0, i)).toISOString(), [text('Lorem ipsum dolor sit amet. '.repeat(120))]));
		parent = id;
	}
	const started = Date.now();
	const m = await computeConversationMetrics({ current_leaf_message_uuid: parent, chat_messages: messages });
	assert.equal(m.trunkMessageCount, 400);
	assert.ok(m.totalTokens > 100000);
	assert.ok(Date.now() - started < 10000, `took ${Date.now() - started} ms`);
});
