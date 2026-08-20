// Test loader for the extension's content scripts.
//
// The shipped sources are IIFEs that attach to `globalThis` (no modules, no
// exports) — the browser loads them as plain <script>s in manifest order.
// Tests replicate that: side-effect imports in the same relative order
// (constants → vendor tokenizer → tokens), then exercise the public
// `globalThis.ClaudeCounter` surface. bridge-client.js is intentionally
// omitted — it needs `window` at import time and is covered by the
// jsdom-env bridge-protocol tests.

export const ROOT_UUID = '00000000-0000-4000-8000-000000000000';

export async function loadContentScripts() {
	await import('../../src/content/constants.js');
	const vendor = await import('../../src/vendor/o200k_base.js');
	// The vendor file is UMD. A plain browser <script> sets the global; some
	// module transforms capture it as an export instead. Normalize to the
	// global the shipped code reads (`tokens.js` looks up
	// `globalThis.GPTTokenizer_o200k_base`).
	if (!globalThis.GPTTokenizer_o200k_base && vendor?.default) {
		globalThis.GPTTokenizer_o200k_base = vendor.default;
	}
	if (!globalThis.GPTTokenizer_o200k_base?.countTokens) {
		throw new Error('vendored o200k tokenizer failed to load — test harness problem, not an extension bug');
	}
	await import('../../src/content/tokens.js');
	return globalThis.ClaudeCounter;
}

// --- conversation payload builders (shape mirrors claude.ai's conversation API) ---

export function makeMessage({
	uuid,
	parent = ROOT_UUID,
	sender = 'human',
	content = [],
	attachments,
	created_at
} = {}) {
	const msg = {
		uuid,
		parent_message_uuid: parent,
		sender,
		content
	};
	if (attachments !== undefined) msg.attachments = attachments;
	if (created_at !== undefined) msg.created_at = created_at;
	return msg;
}

export function textMessage(uuid, text, extra = {}) {
	return makeMessage({ uuid, content: [{ type: 'text', text }], ...extra });
}

export function makeConversation(messages, leafUuid) {
	return {
		chat_messages: messages,
		current_leaf_message_uuid: leafUuid
	};
}
