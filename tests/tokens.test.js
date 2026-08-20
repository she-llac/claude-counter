// Characterization tests for CC.tokens.computeConversationMetrics.
//
// All tests feed crafted conversation payloads through the real shipped code,
// including the real vendored o200k_base tokenizer. Exact token counts below
// were computed once from that tokenizer and locked in as characterization
// values:
//   "hello world"                                   -> 2
//   "The quick brown fox jumps over the lazy dog."  -> 10
//   "hello\nworld"                                  -> 3
//   "attached content"                              -> 2
//
// No bridge is present in this file, so the token cache's fingerprint path is
// inert and every message is counted directly (cache behavior is covered in
// tokens-cache.test.js).

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadContentScripts, makeConversation, makeMessage, textMessage, ROOT_UUID } from './helpers/load.js';

const CC = await loadContentScripts();
const metrics = (conv) => CC.tokens.computeConversationMetrics(conv);

describe('trunk reconstruction', () => {
	it('walks leaf-to-root and counts only the active branch, not abandoned siblings', async () => {
		// root -> A -> B1 (abandoned sibling, 10 tokens)
		//           -> B2 (active leaf,       2 tokens)
		const conv = makeConversation(
			[
				textMessage('trunk-a', 'The quick brown fox jumps over the lazy dog.'), // parent = ROOT, 10 tokens
				textMessage('trunk-b1', 'The quick brown fox jumps over the lazy dog.', { parent: 'trunk-a' }), // abandoned sibling
				textMessage('trunk-b2', 'hello world', { parent: 'trunk-a' }) // active leaf, 2 tokens
			],
			'trunk-b2'
		);
		const m = await metrics(conv);
		expect(m.trunkMessageCount).toBe(2); // A + B2, not B1
		expect(m.totalTokens).toBe(10 + 2); // = 12; including the abandoned sibling would give 22
	});

	it('returns zero metrics for empty chat_messages', async () => {
		const m = await metrics(makeConversation([], 'no-such-leaf'));
		expect(m).toEqual({ trunkMessageCount: 0, totalTokens: 0, lastAssistantMs: null, cachedUntil: null });
	});

	it('returns zero metrics when current_leaf_message_uuid is missing', async () => {
		const conv = { chat_messages: [textMessage('lonely-1', 'hello world')] };
		const m = await metrics(conv);
		expect(m).toEqual({ trunkMessageCount: 0, totalTokens: 0, lastAssistantMs: null, cachedUntil: null });
	});

	it('returns zero metrics when the leaf uuid is not among the messages', async () => {
		const conv = makeConversation([textMessage('present-1', 'hello world')], 'absent-leaf');
		const m = await metrics(conv);
		expect(m.trunkMessageCount).toBe(0);
		expect(m.totalTokens).toBe(0);
	});

	it('counts a partial trunk when the parent chain breaks mid-walk', async () => {
		// leaf C -> B -> X (X absent, not ROOT): trunk is [B, C]
		const conv = makeConversation(
			[
				textMessage('orphan-b', 'hello world', { parent: 'orphan-x-missing' }),
				textMessage('orphan-c', 'hello world', { parent: 'orphan-b' })
			],
			'orphan-c'
		);
		const m = await metrics(conv);
		expect(m.trunkMessageCount).toBe(2);
		expect(m.totalTokens).toBe(4);
	});

	it('terminates at the all-zeros ROOT uuid', async () => {
		const conv = makeConversation([textMessage('root-child', 'hello world', { parent: ROOT_UUID })], 'root-child');
		const m = await metrics(conv);
		expect(m.trunkMessageCount).toBe(1);
		expect(m.totalTokens).toBe(2);
	});

	it('handles non-array chat_messages defensively', async () => {
		const m = await metrics({ chat_messages: 'not-an-array', current_leaf_message_uuid: 'x' });
		expect(m.trunkMessageCount).toBe(0);
		expect(m.totalTokens).toBe(0);
	});

	// Regression guard: buildTrunk originally had no cycle guard, so a
	// parent chain A -> B -> A looped forever (found by probing; fixed with
	// a visited set). The probe still runs in a child process killed after
	// 2s, because a regression would reintroduce a busy synchronous loop
	// that no in-process timeout can interrupt.
	it('terminates when the parent chain contains a cycle', () => {
		const probe = fileURLToPath(new URL('./helpers/cycle-probe.cjs', import.meta.url));
		const res = spawnSync(process.execPath, [probe], { timeout: 2000, encoding: 'utf8' });
		expect(res.stderr).not.toMatch(/Error/); // probe loaded cleanly — not a harness crash
		expect(res.stdout).toContain('DONE');
		expect(res.status).toBe(0);
	}, 10000);
});

describe('countable-content rules', () => {
	it('gives zero tokens for thinking, redacted_thinking, image, and document blocks', async () => {
		const conv = makeConversation(
			[
				makeMessage({
					uuid: 'uncounted-1',
					content: [
						{ type: 'thinking', thinking: 'The quick brown fox jumps over the lazy dog.' },
						{ type: 'redacted_thinking', data: 'The quick brown fox jumps over the lazy dog.' },
						{ type: 'image', source: { data: 'aGVsbG8gd29ybGQ=' } },
						{ type: 'document', title: 'The quick brown fox' }
					]
				})
			],
			'uncounted-1'
		);
		const m = await metrics(conv);
		expect(m.trunkMessageCount).toBe(1);
		expect(m.totalTokens).toBe(0);
	});

	it('counts text blocks; multiple blocks in one message join with a newline', async () => {
		// "hello" + "world" joined -> "hello\nworld" -> 3 tokens (not 2+2)
		const twoBlocks = makeConversation(
			[
				makeMessage({
					uuid: 'join-two',
					content: [
						{ type: 'text', text: 'hello' },
						{ type: 'text', text: 'world' }
					]
				})
			],
			'join-two'
		);
		const oneBlock = makeConversation([textMessage('join-one', 'hello\nworld')], 'join-one');
		const mTwo = await metrics(twoBlocks);
		const mOne = await metrics(oneBlock);
		expect(mTwo.totalTokens).toBe(3);
		expect(mTwo.totalTokens).toBe(mOne.totalTokens);
	});

	it('serializes tool_use deterministically regardless of key insertion order', async () => {
		const inputAB = { alpha: 1, beta: { gamma: 'g', delta: 'd' } };
		const inputBA = { beta: { delta: 'd', gamma: 'g' }, alpha: 1 };
		const toolConv = (uuid, input) =>
			makeConversation(
				[makeMessage({ uuid, content: [{ type: 'tool_use', id: 'toolu_01', name: 'calculator', input }] })],
				uuid
			);
		const mAB = await metrics(toolConv('tool-order-ab', inputAB));
		const mBA = await metrics(toolConv('tool-order-ba', inputBA));
		expect(mAB.totalTokens).toBeGreaterThan(0);
		expect(mAB.totalTokens).toBe(mBA.totalTokens);
	});

	it('serializes tool_result deterministically regardless of key insertion order', async () => {
		const contentAB = [{ type: 'text', text: 'result' }];
		const resultConv = (uuid, block) => makeConversation([makeMessage({ uuid, content: [block] })], uuid);
		const mAB = await metrics(
			resultConv('toolres-ab', { type: 'tool_result', tool_use_id: 'toolu_01', is_error: false, content: contentAB })
		);
		const mBA = await metrics(
			resultConv('toolres-ba', { content: contentAB, is_error: false, tool_use_id: 'toolu_01', type: 'tool_result' })
		);
		expect(mAB.totalTokens).toBeGreaterThan(0);
		expect(mAB.totalTokens).toBe(mBA.totalTokens);
	});

	it('does not throw on tool_use with a circular input object', async () => {
		const input = { name: 'loop' };
		input.self = input;
		const conv = makeConversation(
			[makeMessage({ uuid: 'tool-circular', content: [{ type: 'tool_use', id: 'toolu_02', name: 'looper', input }] })],
			'tool-circular'
		);
		const m = await metrics(conv);
		expect(m.totalTokens).toBeGreaterThan(0); // serialized with a [Circular] placeholder, still counted
	});

	it('counts attachment extracted_content', async () => {
		const conv = makeConversation(
			[makeMessage({ uuid: 'attach-1', content: [], attachments: [{ file_name: 'a.txt', extracted_content: 'attached content' }] })],
			'attach-1'
		);
		const m = await metrics(conv);
		expect(m.totalTokens).toBe(2);
	});

	it('treats non-array message content as empty', async () => {
		const conv = makeConversation([makeMessage({ uuid: 'badcontent-1', content: 'not an array' })], 'badcontent-1');
		const m = await metrics(conv);
		expect(m.trunkMessageCount).toBe(1);
		expect(m.totalTokens).toBe(0);
	});
});

describe('token counting with the real o200k tokenizer', () => {
	it('produces stable exact counts for known strings', async () => {
		const m1 = await metrics(makeConversation([textMessage('exact-1', 'hello world')], 'exact-1'));
		expect(m1.totalTokens).toBe(2);
		const m2 = await metrics(
			makeConversation([textMessage('exact-2', 'The quick brown fox jumps over the lazy dog.')], 'exact-2')
		);
		expect(m2.totalTokens).toBe(10);
	});

	it('counts empty or missing text as zero', async () => {
		const conv = makeConversation(
			[
				textMessage('empty-1', ''),
				makeMessage({ uuid: 'empty-2', parent: 'empty-1', content: [{ type: 'text' }] })
			],
			'empty-2'
		);
		const m = await metrics(conv);
		expect(m.trunkMessageCount).toBe(2);
		expect(m.totalTokens).toBe(0);
	});
});

describe('cache-window math', () => {
	const T1 = '2026-08-15T12:00:00.000Z';
	const T2 = '2026-08-15T12:10:00.000Z';
	const FIVE_MIN = 5 * 60 * 1000;

	it('sets cachedUntil to the last assistant created_at plus five minutes', async () => {
		const conv = makeConversation(
			[
				textMessage('cw-h1', 'hello world'),
				textMessage('cw-a1', 'hello world', { parent: 'cw-h1', sender: 'assistant', created_at: T1 })
			],
			'cw-a1'
		);
		const m = await metrics(conv);
		expect(m.lastAssistantMs).toBe(Date.parse(T1));
		expect(m.cachedUntil).toBe(Date.parse(T1) + FIVE_MIN);
	});

	it('returns null cachedUntil for a user-only conversation', async () => {
		const conv = makeConversation([textMessage('cw-solo', 'hello world', { created_at: T1 })], 'cw-solo');
		const m = await metrics(conv);
		expect(m.lastAssistantMs).toBeNull();
		expect(m.cachedUntil).toBeNull();
	});

	it('picks the latest of multiple assistant messages regardless of trunk order', async () => {
		// Later assistant (T2) sits earlier in the trunk than the T1 assistant.
		const conv = makeConversation(
			[
				textMessage('cw-m1', 'hello world', { sender: 'assistant', created_at: T2 }),
				textMessage('cw-m2', 'hello world', { parent: 'cw-m1' }),
				textMessage('cw-m3', 'hello world', { parent: 'cw-m2', sender: 'assistant', created_at: T1 })
			],
			'cw-m3'
		);
		const m = await metrics(conv);
		expect(m.lastAssistantMs).toBe(Date.parse(T2));
		expect(m.cachedUntil).toBe(Date.parse(T2) + FIVE_MIN);
	});
});

describe('operation without a bridge', () => {
	it('still counts tokens when CC.bridge is absent (hashing unavailable)', async () => {
		expect(CC.bridge).toBeUndefined(); // node env: bridge-client.js is not loaded here
		const m = await metrics(makeConversation([textMessage('nobridge-1', 'hello world')], 'nobridge-1'));
		expect(m.totalTokens).toBe(2);
	});
});
