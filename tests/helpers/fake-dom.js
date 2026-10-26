'use strict';

// A very small DOM, just enough for src/content/ui.js. Selectors: comma lists, compound selectors
// (tag, .class, [attr], [attr="value"]) and descendant combinators. Anything else matches nothing.

class FakeText {
	constructor(text) {
		this.nodeType = 3;
		this.textContent = text;
		this.parentElement = null;
	}
	_detach() {
		if (this.parentElement) {
			const i = this.parentElement.children.indexOf(this);
			if (i >= 0) this.parentElement.children.splice(i, 1);
			this.parentElement = null;
		}
	}
}

function parseCompound(sel) {
	const out = { tag: null, classes: [], attrs: [], ok: true };
	const re = /([a-zA-Z][\w-]*)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]|(\*)/y;
	let i = 0;
	while (i < sel.length) {
		re.lastIndex = i;
		const m = re.exec(sel);
		if (!m) return { ok: false };
		if (m[1]) out.tag = m[1].toLowerCase();
		else if (m[2]) out.classes.push(m[2]);
		else if (m[3]) out.attrs.push([m[3], m[4]]);
		// '*' (m[5]) matches any element
		i = re.lastIndex;
	}
	return out;
}

class FakeElement {
	constructor(tag, doc) {
		this.nodeType = 1;
		this.tagName = String(tag).toUpperCase();
		this.ownerDocument = doc;
		this.children = [];
		this.parentElement = null;
		this.attributes = {};
		this.style = {
			setProperty: (k, v) => {
				this.style[k] = v;
			}
		};
		this._classes = new Set();
		this.listeners = {};
		this.hidden = false; // test switch: renders as display:none
		this.dataset = {};
		this._text = '';
		const self = this;
		this.classList = {
			add: (...c) => c.forEach((x) => self._classes.add(x)),
			remove: (...c) => c.forEach((x) => self._classes.delete(x)),
			toggle: (c, force) => {
				const on = force === undefined ? !self._classes.has(c) : !!force;
				if (on) self._classes.add(c);
				else self._classes.delete(c);
				return on;
			},
			contains: (c) => self._classes.has(c)
		};
	}

	get className() {
		return Array.from(this._classes).join(' ');
	}
	set className(v) {
		this._classes = new Set(String(v).split(/\s+/).filter(Boolean));
	}

	get textContent() {
		return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text;
	}
	set textContent(v) {
		this.children.forEach((c) => (c.parentElement = null));
		this.children.length = 0;
		this._text = String(v);
	}

	get firstChild() {
		return this.children[0] || null;
	}
	get lastElementChild() {
		const els = this.children.filter((c) => c.nodeType === 1);
		return els[els.length - 1] || null;
	}
	get nextElementSibling() {
		return this._sibling(1);
	}
	get previousElementSibling() {
		return this._sibling(-1);
	}
	_sibling(d) {
		if (!this.parentElement) return null;
		const els = this.parentElement.children.filter((c) => c.nodeType === 1);
		const i = els.indexOf(this);
		return els[i + d] || null;
	}

	_detach() {
		if (this.parentElement) {
			const i = this.parentElement.children.indexOf(this);
			if (i >= 0) this.parentElement.children.splice(i, 1);
			this.parentElement = null;
		}
	}
	appendChild(node) {
		if (node._detach) node._detach();
		this._text = '';
		this.children.push(node);
		node.parentElement = this;
		return node;
	}
	replaceChildren(...nodes) {
		this.children.forEach((c) => (c.parentElement = null));
		this.children.length = 0;
		this._text = '';
		nodes.forEach((n) => this.appendChild(n));
	}
	before(node) {
		const parent = this.parentElement;
		if (node._detach) node._detach();
		const i = parent.children.indexOf(this);
		parent.children.splice(i, 0, node);
		node.parentElement = parent;
	}
	after(node) {
		const parent = this.parentElement;
		if (node._detach) node._detach();
		const i = parent.children.indexOf(this);
		parent.children.splice(i + 1, 0, node);
		node.parentElement = parent;
	}
	remove() {
		this._detach();
	}

	setAttribute(k, v) {
		this.attributes[k] = String(v);
	}
	getAttribute(k) {
		return k in this.attributes ? this.attributes[k] : null;
	}
	hasAttribute(k) {
		return k in this.attributes;
	}
	addEventListener(type, fn) {
		(this.listeners[type] = this.listeners[type] || []).push(fn);
	}
	// Elements are laid out in a row: each one starts where its previous sibling ends.
	getBoundingClientRect() {
		let left = 0;
		if (this.parentElement) {
			for (const c of this.parentElement.children) {
				if (c === this) break;
				if (c.nodeType === 1 && !c.floating) left += 100; // a floating element (fixed bar) takes no room in the row
			}
		}
		return { left, top: 0, width: 100, height: 20, right: left + 100, bottom: 20 };
	}
	getClientRects() {
		for (let e = this; e; e = e.parentElement) if (e.hidden) return [];
		return this.isConnected ? [this.getBoundingClientRect()] : [];
	}
	get isConnected() {
		return this.ownerDocument.contains(this);
	}

	contains(node) {
		for (let e = node; e; e = e.parentElement) if (e === this) return true;
		return false;
	}

	matches(selector) {
		return selector.split(',').some((part) => {
			const compound = parseCompound(part.trim());
			if (!compound.ok) return false;
			if (compound.tag && compound.tag !== this.tagName.toLowerCase()) return false;
			if (!compound.classes.every((c) => this._classes.has(c))) return false;
			return compound.attrs.every(([k, v]) => (v === undefined ? k in this.attributes : this.attributes[k] === v));
		});
	}
	closest(selector) {
		for (let e = this; e; e = e.parentElement) if (e.matches(selector)) return e;
		return null;
	}
	querySelectorAll(selector) {
		const results = [];
		for (const part of selector.split(',')) {
			const chain = part.trim().split(/\s+/);
			const walk = (node, depth) => {
				for (const child of node.children) {
					if (child.nodeType !== 1) continue;
					if (child.matches(chain[depth])) {
						if (depth === chain.length - 1) {
							if (!results.includes(child)) results.push(child);
						} else {
							walk(child, depth + 1);
						}
					}
					walk(child, depth);
				}
			};
			walk(this, 0);
		}
		return results;
	}
	querySelector(selector) {
		return this.querySelectorAll(selector)[0] || null;
	}
}

function createFakeDom() {
	const observers = [];
	const doc = {
		createElement: (tag) => new FakeElement(tag, doc),
		createTextNode: (text) => new FakeText(text),
		contains(node) {
			for (let e = node; e; e = e.parentElement) if (e === doc.documentElement) return true;
			return false;
		},
		addEventListener() {},
		cookie: '',
		title: '',
		hidden: false
	};
	doc.documentElement = new FakeElement('html', doc);
	doc.body = new FakeElement('body', doc);
	doc.documentElement.appendChild(doc.body);
	doc.querySelector = (sel) => doc.documentElement.querySelector(sel);
	doc.querySelectorAll = (sel) => doc.documentElement.querySelectorAll(sel);

	class MutationObserver {
		constructor(cb) {
			this.cb = cb;
			observers.push(this);
		}
		observe() {}
		disconnect() {}
	}

	/** Page layouts used by the tests. */
	function buildComposer() {
		const box = doc.createElement('div');
		box.className = 'bg-surface-3';
		const flow = doc.createElement('div');
		flow.className = 'relative w-full min-w-0';
		const input = doc.createElement('div');
		input.setAttribute('contenteditable', 'true');
		input.setAttribute('data-testid', 'chat-input');
		flow.appendChild(input);
		box.appendChild(flow);
		doc.body.appendChild(box);
		return { box, flow, input };
	}
	function buildHeader() {
		const header = doc.createElement('header');
		const title = doc.createElement('div');
		title.setAttribute('data-testid', 'chat-title-button');
		header.appendChild(title);
		doc.body.appendChild(header);
		return { header, title };
	}

	return { document: doc, MutationObserver, observers, buildComposer, buildHeader };
}

module.exports = { createFakeDom, FakeElement };
