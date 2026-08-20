// Tests for usage-payload normalization, both wire formats.
//
// These target CC.parsers.parseUsageFromUsageEndpoint and
// CC.parsers.parseUsageFromMessageLimit — the two parsers extracted from
// main.js into src/content/parsers.js so they are reachable outside the
// orchestration IIFE (which starts observers/intervals on load and cannot
// be imported in tests).

import { describe, it, expect } from 'vitest';

await import('../src/content/parsers.js');
const parsers = globalThis.ClaudeCounter.parsers;

describe('parseUsageFromUsageEndpoint (/usage REST shape)', () => {
	const parse = (raw) => parsers.parseUsageFromUsageEndpoint(raw);

	it('normalizes both windows and passes string resets_at through', () => {
		const out = parse({
			five_hour: { utilization: 42.5, resets_at: '2026-08-15T17:00:00Z' },
			seven_day: { utilization: 12, resets_at: '2026-08-20T00:00:00Z' }
		});
		expect(out).toEqual({
			five_hour: { utilization: 42.5, resets_at: '2026-08-15T17:00:00Z', window_hours: 5 },
			seven_day: { utilization: 12, resets_at: '2026-08-20T00:00:00Z', window_hours: 168 }
		});
	});

	it('clamps utilization to [0, 100]', () => {
		expect(parse({ five_hour: { utilization: -5 } }).five_hour.utilization).toBe(0);
		expect(parse({ five_hour: { utilization: 0 } }).five_hour.utilization).toBe(0); // 0 is valid, not "missing"
		expect(parse({ five_hour: { utilization: 42.5 } }).five_hour.utilization).toBe(42.5);
		expect(parse({ five_hour: { utilization: 100 } }).five_hour.utilization).toBe(100);
		expect(parse({ five_hour: { utilization: 250 } }).five_hour.utilization).toBe(100);
	});

	it('drops a window whose utilization is non-numeric or missing', () => {
		const out = parse({
			five_hour: { utilization: 'lots', resets_at: '2026-08-15T17:00:00Z' },
			seven_day: { utilization: 12 }
		});
		expect(out.five_hour).toBeNull();
		expect(out.seven_day).not.toBeNull();
		expect(parse({ five_hour: { utilization: NaN }, seven_day: { utilization: 1 } }).five_hour).toBeNull();
		expect(parse({ five_hour: { resets_at: '2026-08-15T17:00:00Z' }, seven_day: { utilization: 1 } }).five_hour).toBeNull();
	});

	it('returns null when both windows are missing or invalid', () => {
		expect(parse({})).toBeNull();
		expect(parse({ five_hour: { utilization: 'x' }, seven_day: null })).toBeNull();
		expect(parse(null)).toBeNull();
		expect(parse('not an object')).toBeNull();
	});

	it('nulls resets_at when it is not a string', () => {
		expect(parse({ five_hour: { utilization: 10, resets_at: 1755277200 } }).five_hour.resets_at).toBeNull();
		expect(parse({ five_hour: { utilization: 10 } }).five_hour.resets_at).toBeNull();
	});
});

describe('parseUsageFromMessageLimit (SSE message_limit shape)', () => {
	const parse = (raw) => parsers.parseUsageFromMessageLimit(raw);

	it('scales fractional utilization by 100 and maps 5h/7d keys', () => {
		const out = parse({
			windows: {
				'5h': { utilization: 0.334, resets_at: 1700000000 },
				'7d': { utilization: 0.5, resets_at: 1700000000 }
			}
		});
		expect(out.five_hour.utilization).toBeCloseTo(33.4, 10);
		expect(out.five_hour.window_hours).toBe(5);
		expect(out.seven_day.utilization).toBe(50);
		expect(out.seven_day.window_hours).toBe(168);
	});

	it('converts epoch-seconds resets_at to an ISO string', () => {
		const out = parse({ windows: { '5h': { utilization: 0.1, resets_at: 1700000000 } } });
		expect(out.five_hour.resets_at).toBe('2023-11-14T22:13:20.000Z');
	});

	it('converts epoch 0 and negative epochs blindly (characterized, not endorsed)', () => {
		expect(parse({ windows: { '5h': { utilization: 0.1, resets_at: 0 } } }).five_hour.resets_at).toBe(
			'1970-01-01T00:00:00.000Z'
		);
		expect(parse({ windows: { '5h': { utilization: 0.1, resets_at: -86400 } } }).five_hour.resets_at).toBe(
			'1969-12-31T00:00:00.000Z'
		);
	});

	it('nulls resets_at when it is not a finite number', () => {
		expect(parse({ windows: { '5h': { utilization: 0.1, resets_at: '2026-08-15T17:00:00Z' } } }).five_hour.resets_at).toBeNull();
		expect(parse({ windows: { '5h': { utilization: 0.1, resets_at: Infinity } } }).five_hour.resets_at).toBeNull();
		expect(parse({ windows: { '5h': { utilization: 0.1 } } }).five_hour.resets_at).toBeNull();
	});

	it('clamps scaled utilization to [0, 100] and keeps exact 0', () => {
		expect(parse({ windows: { '5h': { utilization: 1.5 } } }).five_hour.utilization).toBe(100);
		expect(parse({ windows: { '5h': { utilization: -0.2 } } }).five_hour.utilization).toBe(0);
		expect(parse({ windows: { '5h': { utilization: 0 } } }).five_hour.utilization).toBe(0);
	});

	it('drops a window with non-numeric utilization and keeps the other', () => {
		const out = parse({ windows: { '5h': { utilization: 'x' }, '7d': { utilization: 0.25 } } });
		expect(out.five_hour).toBeNull();
		expect(out.seven_day.utilization).toBe(25);
	});

	it('returns null when windows is missing, non-object, or has no valid window', () => {
		expect(parse({})).toBeNull();
		expect(parse(null)).toBeNull();
		expect(parse({ windows: 'nope' })).toBeNull();
		expect(parse({ windows: {} })).toBeNull();
		expect(parse({ windows: { '5h': { utilization: 'x' } } })).toBeNull();
	});
});
