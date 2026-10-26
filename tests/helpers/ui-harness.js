'use strict';

// Runs the real src/content/ui.js against the fake DOM and the manual clock.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createFakeDom } = require('./fake-dom');
const { createClock } = require('./fake-clock');
const { createFakeChrome } = require('./fake-chrome');

const SRC = path.join(__dirname, '../../src');
const START = Date.UTC(2026, 9, 14, 12, 0, 0);

function createUiEnv({ startMs = START } = {}) {
	const dom = createFakeDom();
	const clock = createClock(startMs);
	const fake = createFakeChrome();
	const refreshes = [];

	const window = {
		innerWidth: 1280,
		innerHeight: 800,
		addEventListener() {},
		getComputedStyle: () => ({ display: 'block', flexDirection: 'row' })
	};

	const context = vm.createContext({
		window,
		document: dom.document,
		MutationObserver: dom.MutationObserver,
		Date: clock.Date,
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
		setInterval: clock.setInterval,
		clearInterval: clock.clearInterval,
		chrome: fake.chrome,
		console,
		Math,
		JSON,
		Object,
		Array,
		Number,
		String,
		Promise,
		Set,
		Map,
		Error
	});
	context.globalThis = context;

	for (const file of ['content/constants.js', 'content/ui.js']) {
		vm.runInContext(fs.readFileSync(path.join(SRC, file), 'utf8'), context, { filename: file });
	}
	const CC = context.ClaudeCounter;
	// main.js provides this in the extension; here it never finds anything.
	CC.waitForElement = () => new Promise(() => {});

	const ui = new CC.ui.CounterUI({
		onUsageRefresh: async () => {
			refreshes.push(clock.now);
		}
	});
	ui.initialize();

	return { ui, CC, dom, clock, document: dom.document, refreshes, storageData: fake.data };
}

function iso(ms) {
	return new Date(ms).toISOString();
}

module.exports = { createUiEnv, iso, START };
