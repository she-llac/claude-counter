'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createUiEnv, iso, START } = require('./helpers/ui-harness');

const HOUR = 3600 * 1000;

function texts(env) {
	return { session: env.ui.sessionUsageSpan.textContent, weekly: env.ui.weeklyUsageSpan.textContent };
}

test('U01 before any data the bars say "no data yet", not 0%', () => {
	const env = createUiEnv();
	assert.deepEqual(texts(env), { session: 'Session: no data yet', weekly: 'Weekly: no data yet' });
});

test('U02 a live window shows the value, the bar and the countdown', () => {
	const env = createUiEnv();
	env.ui.setUsage({
		five_hour: { utilization: 76, resets_at: iso(START + HOUR) },
		seven_day: { utilization: 25.04, resets_at: iso(START + 49 * HOUR) }
	});
	assert.deepEqual(texts(env), { session: 'Session: 76% · resets in 1h 0m', weekly: 'Weekly: 25% · resets in 2d 1h' });
	assert.equal(env.ui.sessionBarFill.style.width, '76%');
	assert.equal(env.ui.weeklyBarFill.style.width, '25.04%');
	assert.equal(env.ui.sessionMarker.classList.contains('cc-hidden'), false);
});

test('U03 an expired window shows 0% with no countdown and no marker', () => {
	const env = createUiEnv();
	env.ui.setUsage({ five_hour: { expired: true }, seven_day: { utilization: 10, resets_at: iso(START + 5 * HOUR) } });
	assert.equal(texts(env).session, 'Session: 0%');
	assert.equal(env.ui.sessionBarFill.style.width, '0%');
	assert.equal(env.ui.sessionMarker.classList.contains('cc-hidden'), true);
	assert.equal(env.ui.sessionResetMs, null);
	assert.match(texts(env).weekly, /^Weekly: 10% · resets in/);
});

test('U03b ticking never brings a countdown back to an expired window', () => {
	const env = createUiEnv();
	env.ui.setUsage({ five_hour: { expired: true }, seven_day: { expired: true } });
	env.ui.tick();
	assert.deepEqual(texts(env), { session: 'Session: 0%', weekly: 'Weekly: 0%' });
});

test('U04 a window that was never reported is "no data yet", also when the other one is known', () => {
	const env = createUiEnv();
	env.ui.setUsage({ five_hour: null, seven_day: { utilization: 3, resets_at: iso(START + 3 * HOUR) } });
	assert.equal(texts(env).session, 'Session: no data yet');
	assert.equal(env.ui.sessionBarFill.style.width, '0%');
	env.ui.setUsage({});
	assert.deepEqual(texts(env), { session: 'Session: no data yet', weekly: 'Weekly: no data yet' });
	env.ui.setUsage(undefined);
	assert.equal(texts(env).session, 'Session: no data yet');
});

test('U05 states can change back and forth', () => {
	const env = createUiEnv();
	env.ui.setUsage({ five_hour: { utilization: 99.9, resets_at: iso(START + HOUR) }, seven_day: null });
	assert.equal(env.ui.sessionBarFill.classList.contains('cc-full'), true);
	env.ui.setUsage({ five_hour: { expired: true }, seven_day: null });
	assert.equal(env.ui.sessionBarFill.classList.contains('cc-full'), false);
	assert.equal(env.ui.sessionBarFill.classList.contains('cc-warn'), false);
	env.ui.setUsage({ five_hour: { utilization: 5, resets_at: iso(START + 5 * HOUR) }, seven_day: null });
	assert.match(texts(env).session, /^Session: 5% · resets in 5h/);
});

test('U06 the countdown text counts down with the clock', async () => {
	const env = createUiEnv();
	env.ui.setUsage({ five_hour: { utilization: 10, resets_at: iso(START + 90 * 1000) }, seven_day: null });
	assert.equal(texts(env).session, 'Session: 10% · resets in 2m');
	await env.clock.advance(40 * 1000);
	env.ui.tick();
	assert.equal(texts(env).session, 'Session: 10% · resets in 50s');
});

// ---- header (token count and cache timer) ----

test('U07 with the usual header anchor the header goes next to it', () => {
	const env = createUiEnv();
	const { title } = env.dom.buildHeader();
	env.dom.buildComposer();
	env.ui.attach();
	env.ui.setConversationMetrics({ totalTokens: 24, cachedUntil: START + 272 * 1000 });
	assert.equal(title.nextElementSibling, env.ui.headerContainer);
	assert.equal(env.ui.headerInFallback, false);
	assert.equal(env.ui.headerContainer.textContent.replace(/[ \s]+/g, ' '), '~24 tokens cached for 4:32');
});

test('U08 no header anchor in the page (new layout): the header sits above the usage bars', () => {
	const env = createUiEnv();
	env.dom.buildComposer();
	env.ui.attach();
	env.ui.setConversationMetrics({ totalTokens: 912533, cachedUntil: null });

	assert.equal(env.ui.headerInFallback, true);
	assert.equal(env.ui.usageLine.previousElementSibling, env.ui.headerContainer);
	assert.ok(env.document.contains(env.ui.headerContainer));
	assert.match(env.ui.headerContainer.textContent, /~912,533 tokens/);
});

test('U08b when the anchor shows up later the header moves to it', () => {
	const env = createUiEnv();
	env.dom.buildComposer();
	env.ui.attach();
	assert.equal(env.ui.headerInFallback, true);

	const { title } = env.dom.buildHeader();
	env.ui.attachHeader();
	assert.equal(title.nextElementSibling, env.ui.headerContainer);
	assert.equal(env.ui.headerInFallback, false);
});

test('U09 an anchor that leads to an invisible header: after a few seconds it moves to the fallback', () => {
	const env = createUiEnv();
	const { header } = env.dom.buildHeader();
	env.dom.buildComposer();
	header.hidden = true; // the header exists but is not rendered
	env.ui.attach();
	env.ui.setConversationMetrics({ totalTokens: 100, cachedUntil: null });
	assert.equal(env.ui.headerInFallback, false);

	env.ui.tick();
	env.ui.tick();
	assert.equal(env.ui.headerInFallback, false, 'not yet');
	env.ui.tick();
	assert.equal(env.ui.headerInFallback, true);
	assert.equal(env.ui.usageLine.previousElementSibling, env.ui.headerContainer);
	assert.ok(env.ui.headerContainer.getClientRects().length > 0, 'visible now');
});

test('U09b a visible header is left alone by the check', () => {
	const env = createUiEnv();
	const { title } = env.dom.buildHeader();
	env.dom.buildComposer();
	env.ui.attach();
	env.ui.setConversationMetrics({ totalTokens: 100, cachedUntil: null });
	for (let i = 0; i < 10; i++) env.ui.tick();
	assert.equal(title.nextElementSibling, env.ui.headerContainer);
	assert.equal(env.ui.headerInFallback, false);
});

test('U09c nothing to show: nothing is moved', () => {
	const env = createUiEnv();
	env.dom.buildComposer();
	env.ui.attach();
	env.ui.headerContainer.remove();
	for (let i = 0; i < 5; i++) env.ui.tick();
	assert.equal(env.ui.headerContainer.parentElement, null);
});

test('U10 the page re-renders and drops the header: the next DOM change puts it back', () => {
	const env = createUiEnv();
	env.dom.buildComposer();
	env.ui.attach();
	env.ui.setConversationMetrics({ totalTokens: 50, cachedUntil: null });
	env.ui.headerContainer.remove();
	assert.ok(!env.document.contains(env.ui.headerContainer));

	for (const observer of env.dom.observers) observer.cb([]);
	assert.ok(env.document.contains(env.ui.headerContainer));
	assert.equal(env.ui.usageLine.previousElementSibling, env.ui.headerContainer);
});

test('U11 the cache timer ticks down and disappears at zero', async () => {
	const env = createUiEnv();
	env.dom.buildComposer();
	env.ui.attach();
	env.ui.setConversationMetrics({ totalTokens: 100, cachedUntil: START + 3000 });
	assert.match(env.ui.headerContainer.textContent, /cached for\s0:03/);
	await env.clock.advance(2000);
	env.ui.tick();
	assert.match(env.ui.headerContainer.textContent, /cached for\s0:01/);
	await env.clock.advance(2000);
	env.ui.tick();
	assert.doesNotMatch(env.ui.headerContainer.textContent, /cached/);
	assert.match(env.ui.headerContainer.textContent, /~100 tokens/);
});

test('U12 an expired cache is not shown at all, the token count still is', () => {
	const env = createUiEnv();
	env.dom.buildComposer();
	env.ui.attach();
	env.ui.setConversationMetrics({ totalTokens: 7, cachedUntil: START - 1000 });
	assert.match(env.ui.headerContainer.textContent, /~7 tokens/);
	assert.doesNotMatch(env.ui.headerContainer.textContent, /cached/);
});

test('U13 leaving a chat clears the header', () => {
	const env = createUiEnv();
	env.dom.buildComposer();
	env.ui.attach();
	env.ui.setConversationMetrics({ totalTokens: 7, cachedUntil: START + 60000 });
	env.ui.setConversationMetrics();
	assert.equal(env.ui.headerContainer.textContent, '');
});

test('U14 tooltips explain the three states', () => {
	const env = createUiEnv();
	assert.match(env.ui.sessionTooltip.textContent, /no data yet/);
	assert.match(env.ui.sessionTooltip.textContent, /0% without a countdown/);
});

test('U15 clicking the usage line asks for a refresh', async () => {
	const env = createUiEnv();
	for (const fn of env.ui.usageLine.listeners.click) await fn();
	assert.equal(env.refreshes.length, 1);
});

test('U08c calling attach again does not shuffle the header and the usage bars', () => {
	const env = createUiEnv();
	const { flow } = env.dom.buildComposer();
	env.ui.attach();
	env.ui.setConversationMetrics({ totalTokens: 100, cachedUntil: null });
	const order = () => Array.from(flow.parentElement.children).map((c) => (c === flow ? 'flow' : c === env.ui.headerContainer ? 'header' : c === env.ui.usageLine ? 'usage' : '?')).join(',');
	assert.equal(order(), 'flow,header,usage');
	for (let i = 0; i < 5; i++) {
		env.ui.attach();
		env.ui.attachUsageLine();
		env.ui.tick();
		for (const observer of env.dom.observers) observer.cb([]);
		assert.equal(order(), 'flow,header,usage', `round ${i}`);
	}
});

// ---- header under the chat title, found by the title text (geometry as recorded on claude.ai) ----

/** Lays the fake page out like the recorded one. state: leaf, headerWidth, bar; bar: { text, wrap, header }. */
function layOut(env, bar, state) {
	const rect = (r) => ({ ...r, right: r.left + r.width, bottom: r.top + r.height });
	const leafRect = () => rect(state.leaf);
	bar.text.getBoundingClientRect = leafRect;
	bar.wrap.getBoundingClientRect = leafRect;
	bar.header.getBoundingClientRect = () => rect(state.bar);
	const h = env.ui.headerContainer;
	// the bar is the positioned element: a header inside it is measured from it, one outside it from the body
	const inside = (el, root) => {
		for (let n = el.parentElement; n; n = n.parentElement) if (n === root) return true;
		return false;
	};
	Object.defineProperty(h, 'offsetParent', { get: () => (state.noParent ? null : inside(h, bar.header) ? bar.header : env.document.body), configurable: true });
	h.getBoundingClientRect = () => {
		const st = h.style;
		const left = state.bar.left + parseFloat(st.left || '0');
		const top = state.bar.top + parseFloat(st.top || '0');
		if (st.position === 'absolute') return rect({ left, top, width: state.headerWidth, height: 16 });
		return rect({ left: state.leaf.left + state.leaf.width + 8, top: state.leaf.top + 2, width: state.headerWidth, height: 16 });
	};
}

// geometry as recorded on claude.ai: bar 48 px high, title text at x=312, y=14, 20 px high
const WIDE = () => ({ leaf: { left: 312, top: 14, width: 210, height: 20 }, bar: { left: 296, top: 0, width: 1624, height: 48 }, headerWidth: 250 });

function buildTitleBar(env, title = 'Můj rodinný rozpočet') {
	const doc = env.document;
	const header = doc.createElement('header');
	const left = doc.createElement('div');
	const wrap = doc.createElement('div');
	const text = doc.createElement('span');
	text.textContent = title;
	wrap.appendChild(text);
	left.appendChild(wrap);
	const share = doc.createElement('button');
	share.textContent = 'Share';
	left.appendChild(share);
	header.appendChild(left);
	doc.body.appendChild(header);
	return { header, left, wrap, text, share };
}

function setup(titleBarTitle) {
	const env = createUiEnv();
	env.dom.buildComposer();
	env.ui.attach();
	env.ui.setConversationMetrics({ totalTokens: 1234, cachedUntil: null });
	const bar = titleBarTitle === null ? null : buildTitleBar(env, titleBarTitle);
	if (bar) layOut(env, bar, WIDE());
	return { env, bar };
}

test('U16 the header goes under the title element, which is found by the title text', () => {
	const { env, bar } = setup();
	env.ui.setConversationTitle('Můj rodinný rozpočet');
	assert.equal(env.ui.headerPlacement, 'title');
	assert.equal(env.ui.headerInFallback, true);
	assert.equal(bar.wrap.nextElementSibling, env.ui.headerContainer, 'right after the wrapper that holds only the title');
	assert.equal(bar.share.previousElementSibling, env.ui.headerContainer);
	assert.equal(env.ui.headerContainer.style.display, 'inline-flex');
	assert.equal(env.ui.headerContainer.style.position, 'absolute', 'out of the row of the bar: no room taken from the title or the buttons');
	assert.equal(env.ui.headerContainer.style.paddingLeft, '');
	assert.match(env.ui.headerContainer.textContent, /~1,234 tokens/);
	// the usage bars have nothing in front of them any more
	assert.notEqual(env.ui.usageLine.previousElementSibling, env.ui.headerContainer);
});

test('U16b the title of the browser tab is used when the conversation title is not known', () => {
	const { env, bar } = setup();
	env.document.title = 'Můj rodinný rozpočet - Claude';
	env.ui.setConversationTitle('');
	env.ui.tick();
	env.ui.tick();
	env.ui.tick();
	assert.equal(env.ui.headerPlacement, 'title');
	assert.equal(bar.wrap.nextElementSibling, env.ui.headerContainer);
});

test('U17 a title that appears only in the sidebar is not taken for the chat title', () => {
	const env = createUiEnv();
	env.dom.buildComposer();
	env.ui.attach();
	env.ui.setConversationMetrics({ totalTokens: 10, cachedUntil: null });
	const nav = env.document.createElement('nav');
	const item = env.document.createElement('a');
	item.textContent = 'Můj rodinný rozpočet';
	nav.appendChild(item);
	env.document.body.appendChild(nav);
	env.ui.setConversationTitle('Můj rodinný rozpočet');
	assert.equal(env.ui.headerPlacement, 'bars');
	assert.equal(env.ui.usageLine.previousElementSibling, env.ui.headerContainer);
});

test('U17b generic titles say nothing and are not searched for', () => {
	const { env } = setup('New chat');
	env.ui.setConversationTitle('New chat');
	assert.equal(env.ui.headerPlacement, 'bars');
});

test('U18 a header that would not land under the title goes above the bars and is not tried again', async () => {
	const { env, bar } = setup();
	env.ui.headerContainer.getBoundingClientRect = () => ({ left: 0, top: 60, bottom: 80, width: 100, height: 20 });
	env.ui.setConversationTitle('Můj rodinný rozpočet');
	assert.equal(env.ui.headerPlacement, 'bars');
	assert.equal(env.ui.headerContainer.style.display, '');
	assert.notEqual(bar.wrap.nextElementSibling, env.ui.headerContainer);
	assert.equal(env.ui.usageLine.previousElementSibling, env.ui.headerContainer);
	for (let i = 0; i < 4; i++) {
		await env.clock.advance(2000);
		env.ui.tick();
		env.ui.tick();
		env.ui.tick();
	}
	assert.equal(env.ui.headerPlacement, 'bars', 'rejected for this title, no flip-flopping');
});

test('U19 the title bar shows up later: from the bars the header moves under the title', async () => {
	const { env } = setup(null);
	env.ui.setConversationTitle('Můj rodinný rozpočet');
	assert.equal(env.ui.headerPlacement, 'bars');
	const bar = buildTitleBar(env);
	layOut(env, bar, WIDE());
	await env.clock.advance(2000);
	env.ui.tick();
	env.ui.tick();
	env.ui.tick();
	assert.equal(env.ui.headerPlacement, 'title');
	assert.equal(bar.wrap.nextElementSibling, env.ui.headerContainer);
});

test('U20 the usual anchor wins when it exists, and clears the style of the title placement', () => {
	const { env } = setup();
	env.ui.setConversationTitle('Můj rodinný rozpočet');
	assert.equal(env.ui.headerPlacement, 'title');
	const { title } = env.dom.buildHeader();
	env.ui.attachHeader();
	assert.equal(env.ui.headerPlacement, 'anchor');
	assert.equal(env.ui.headerInFallback, false);
	assert.equal(title.nextElementSibling, env.ui.headerContainer);
	assert.equal(env.ui.headerContainer.style.display, '');
	assert.equal(env.ui.headerContainer.style.marginLeft, '');
});

test('U21 the title element is replaced by the page: after a few ticks the header goes above the bars', () => {
	const { env, bar } = setup();
	env.ui.setConversationTitle('Můj rodinný rozpočet');
	assert.equal(env.ui.headerPlacement, 'title');
	bar.left.remove(); // the page throws the old title bar away (our header goes with it or is left alone)
	env.ui.headerContainer.remove();
	env.ui.tick();
	env.ui.tick();
	env.ui.tick();
	assert.equal(env.ui.headerPlacement, 'bars');
	assert.equal(env.ui.usageLine.previousElementSibling, env.ui.headerContainer);
});

test('U22 the title scan is throttled: many DOM changes cause one scan', () => {
	const { env } = setup(null);
	let scans = 0;
	const original = env.document.querySelectorAll;
	env.document.querySelectorAll = (sel) => {
		if (sel === '*') scans += 1;
		return original(sel);
	};
	env.ui.setConversationTitle('Můj rodinný rozpočet');
	for (let i = 0; i < 50; i++) env.ui._mountHeaderByTitle();
	assert.equal(scans, 1);
});

test('U23 leaving the chat forgets the title', () => {
	const { env } = setup(null);
	env.ui.setConversationTitle('Můj rodinný rozpočet');
	assert.equal(env.ui.conversationTitle, 'Můj rodinný rozpočet');
	env.ui.setConversationMetrics();
	assert.equal(env.ui.conversationTitle, '');
});

test('U24 the title text is matched ignoring extra white space; a part of a longer text is not a match', () => {
	const { env, bar } = setup('  Můj   rodinný\n rozpočet ');
	env.ui.setConversationTitle('Můj rodinný rozpočet');
	assert.equal(env.ui.headerPlacement, 'title');
	assert.equal(bar.wrap.nextElementSibling, env.ui.headerContainer);

	const other = createUiEnv();
	other.dom.buildComposer();
	other.ui.attach();
	other.ui.setConversationMetrics({ totalTokens: 10, cachedUntil: null });
	const p = other.document.createElement('p');
	p.textContent = 'Můj rodinný rozpočet na příští rok je tabulka';
	other.document.body.appendChild(p);
	other.ui.setConversationTitle('Můj rodinný rozpočet');
	assert.equal(other.ui.headerPlacement, 'bars');
});

test('U25 a floating title bar: the header goes inside the bar, under the title, not behind the bar', () => {
	const { env } = setup(null);
	const doc = env.document;
	const bar = doc.createElement('div'); // position: fixed, a direct child of the page body
	bar.floating = true;
	const text = doc.createElement('span');
	text.textContent = 'Můj rodinný rozpočet';
	bar.appendChild(text);
	doc.body.appendChild(bar);
	layOut(env, { text, wrap: text, header: bar }, WIDE());
	env.ui.setConversationTitle('Můj rodinný rozpočet');
	assert.equal(env.ui.headerPlacement, 'title');
	assert.equal(env.ui.headerContainer.parentElement, bar, 'inside the bar');
	assert.equal(text.nextElementSibling, env.ui.headerContainer);
	assert.equal(env.ui.headerContainer.style.display, 'inline-flex');
	assert.equal(env.ui.headerContainer.style.position, 'absolute');
});

test('U27 a header that is still empty is not placed by the title; it moves under the title when the token count arrives', () => {
	const env = createUiEnv();
	env.dom.buildComposer();
	env.ui.attach(); // no token count yet: the header has no content and no size
	const doc = env.document;
	const bar = doc.createElement('div');
	bar.floating = true;
	const text = doc.createElement('span');
	text.textContent = 'Můj rodinný rozpočet';
	bar.appendChild(text);
	doc.body.appendChild(bar);
	layOut(env, { text, wrap: text, header: bar }, WIDE());
	env.ui.setConversationTitle('Můj rodinný rozpočet');
	assert.notEqual(env.ui.headerPlacement, 'title', 'nothing to measure yet');
	assert.notEqual(env.ui.headerContainer.parentElement, bar);

	env.ui.setConversationMetrics({ totalTokens: 1234, cachedUntil: null });
	assert.equal(env.ui.headerPlacement, 'title');
	assert.equal(env.ui.headerContainer.parentElement, bar, 'inside the floating bar, not behind it');
	assert.equal(text.nextElementSibling, env.ui.headerContainer);
});

// ---- header under the title: always, whatever the width of the page or of the header ----

test('U32 the header goes under the title, out of the row, at the start of the title text', () => {
	const { env, bar } = setup();
	layOut(env, bar, WIDE());
	env.ui.setConversationTitle('Můj rodinný rozpočet');
	const st = env.ui.headerContainer.style;
	assert.equal(env.ui.headerPlacement, 'title');
	assert.equal(st.position, 'absolute');
	assert.equal(st.left, '12px', 'its text starts where the title text starts (312 - 296 - 4 padding)');
	assert.equal(st.top, '32px', 'right under the title text, inside the 48 px bar');
});

test('U33 a long title does not matter: the header goes under its start', () => {
	const { env, bar } = setup();
	const state = WIDE();
	state.leaf.width = 419; // 62 characters
	layOut(env, bar, state);
	env.ui.setConversationTitle('Můj rodinný rozpočet');
	assert.equal(env.ui.headerPlacement, 'title');
	assert.equal(env.ui.headerContainer.style.position, 'absolute');
});

test('U34 narrow page: the header stays under the title too, the row of the bar is not used', () => {
	const { env, bar } = setup();
	const state = { leaf: { left: 312, top: 14, width: 210, height: 20 }, bar: { left: 296, top: 0, width: 538, height: 48 }, headerWidth: 157 };
	layOut(env, bar, state);
	env.ui.setConversationTitle('Můj rodinný rozpočet');
	assert.equal(env.ui.headerPlacement, 'title');
	assert.equal(env.ui.headerContainer.style.position, 'absolute');
	assert.equal(env.ui.headerContainer.style.top, '32px');
});

test('U35 the cache timer widens the header: it stays where it is, no switching', () => {
	const { env, bar } = setup();
	const state = WIDE();
	layOut(env, bar, state);
	env.ui.setConversationTitle('Můj rodinný rozpočet');
	state.headerWidth = 420;
	for (let i = 0; i < 5; i++) env.ui.tick();
	assert.equal(env.ui.headerPlacement, 'title');
	assert.equal(env.ui.headerContainer.style.position, 'absolute');
	assert.equal(env.ui.headerContainer.style.left, '12px');
	state.headerWidth = 250;
	for (let i = 0; i < 5; i++) env.ui.tick();
	assert.equal(env.ui.headerPlacement, 'title');
	assert.equal(env.ui.headerContainer.style.position, 'absolute');
});

test('U37 the header under the title follows the title when the page moves it (sidebar closed)', () => {
	const { env, bar } = setup();
	const state = WIDE();
	layOut(env, bar, state);
	env.ui.setConversationTitle('Můj rodinný rozpočet');
	assert.equal(env.ui.headerContainer.style.left, '12px');
	state.leaf.left = 60;
	state.bar.left = 48;
	env.ui.tick();
	assert.equal(env.ui.headerContainer.style.left, '8px');
	assert.equal(env.ui.headerPlacement, 'title');
});

test('U39 when the page gives no element to measure the position against, the header goes above the bars', () => {
	const { env, bar } = setup();
	const state = WIDE();
	state.noParent = true;
	layOut(env, bar, state);
	env.ui.setConversationTitle('Můj rodinný rozpočet');
	assert.equal(env.ui.headerPlacement, 'bars');
	assert.equal(env.ui.headerContainer.style.position, '');
	assert.equal(env.ui.usageLine.previousElementSibling, env.ui.headerContainer);
});

test('U40 leaving the title placement clears the under-the-title style', () => {
	const { env, bar } = setup();
	const state = WIDE();
	layOut(env, bar, state);
	env.ui.setConversationTitle('Můj rodinný rozpočet');
	assert.equal(env.ui.headerContainer.style.position, 'absolute');
	const { title } = env.dom.buildHeader();
	env.ui.attachHeader();
	assert.equal(env.ui.headerPlacement, 'anchor');
	const st = env.ui.headerContainer.style;
	assert.equal(st.position, '');
	assert.equal(st.left, '');
	assert.equal(st.top, '');
	assert.equal(st.zIndex, '');
	assert.equal(st.pointerEvents, '');
	assert.equal(title.nextElementSibling, env.ui.headerContainer);
});

test('U41 a header that does not stay under the title goes back to the bars after a few ticks', () => {
	const { env, bar } = setup();
	const state = WIDE();
	layOut(env, bar, state);
	env.ui.setConversationTitle('Můj rodinný rozpočet');
	assert.equal(env.ui.headerPlacement, 'title');
	const h = env.ui.headerContainer;
	h.getBoundingClientRect = () => ({ left: 0, top: 300, width: 250, height: 16, right: 250, bottom: 316 }); // the page moved it away
	env.ui.tick();
	env.ui.tick();
	env.ui.tick();
	assert.equal(env.ui.headerPlacement, 'bars');
	assert.equal(h.style.position, '');
});

test('U43 under the title means under its start: a header the page moved sideways is not kept', () => {
	const { env, bar } = setup();
	const state = WIDE();
	layOut(env, bar, state);
	env.ui.setConversationTitle('Můj rodinný rozpočet');
	assert.equal(env.ui.headerPlacement, 'title');
	env.ui.headerContainer.getBoundingClientRect = () => ({ left: 400, top: 31, width: 250, height: 16, right: 650, bottom: 47 });
	env.ui.tick();
	env.ui.tick();
	env.ui.tick();
	assert.equal(env.ui.headerPlacement, 'bars');
});

test('U44 under the title means close below it: a header the page moved far down is not kept', () => {
	const { env, bar } = setup();
	const state = WIDE();
	layOut(env, bar, state);
	env.ui.setConversationTitle('Můj rodinný rozpočet');
	env.ui.headerContainer.getBoundingClientRect = () => ({ left: 308, top: 120, width: 250, height: 16, right: 558, bottom: 136 });
	env.ui.tick();
	env.ui.tick();
	env.ui.tick();
	assert.equal(env.ui.headerPlacement, 'bars');
});

test('U45 a page without a positioned element around the bar (the body would be the reference) sends the header above the bars', () => {
	const { env, bar } = setup();
	const state = WIDE();
	layOut(env, bar, state);
	const h = env.ui.headerContainer;
	Object.defineProperty(h, 'offsetParent', { get: () => env.document.body, configurable: true });
	// the page would put an absolutely placed header where the numbers say, measured from the body
	h.getBoundingClientRect = () => {
		const left = h.style.position === 'absolute' ? parseFloat(h.style.left) : state.leaf.left + state.leaf.width + 8;
		const top = h.style.position === 'absolute' ? parseFloat(h.style.top) : state.leaf.top + 2;
		return { left, top, width: state.headerWidth, height: 16, right: left + state.headerWidth, bottom: top + 16 };
	};
	env.ui.setConversationTitle('Můj rodinný rozpočet');
	assert.equal(env.ui.headerPlacement, 'bars');
	assert.equal(env.ui.headerContainer.style.position, '');
});
