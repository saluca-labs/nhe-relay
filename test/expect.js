// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// A small expect() over node:assert, so the tests read the same as before and run on Node's
// built-in runner (`node --test`) with nothing to install. Only the matchers the tests use.

import assert from "node:assert/strict";
import { describe, it as nodeIt } from "node:test";

export { describe };

/**
 * it(name, fn) or it(name, fn, timeoutMs).
 * @param {string} name
 * @param {() => unknown} fn
 * @param {number} [timeout]
 */
export function it(name, fn, timeout) {
    return nodeIt(name, timeout ? { timeout } : {}, fn);
}

/** True when `actual` has every key of `expected` with a matching value, recursively. */
function matches(actual, expected) {
    if (expected === null || typeof expected !== "object") return Object.is(actual, expected);
    if (actual === null || typeof actual !== "object") return false;
    if (Array.isArray(expected)) {
        return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => matches(actual[i], e));
    }
    return Object.keys(expected).every((k) => matches(actual[k], expected[k]));
}

function makeMatchers(actual, message, negate) {
    const check = (pass, what) => {
        if (pass === negate) {
            assert.fail(`${message ? message + ": " : ""}expected ${inspect(actual)} ${negate ? "not " : ""}${what}`);
        }
    };
    return {
        toBe: (e) => check(Object.is(actual, e), `to be ${inspect(e)}`),
        toEqual: (e) => {
            let ok = true;
            try {
                assert.deepStrictEqual(normalise(actual), normalise(e));
            } catch {
                ok = false;
            }
            check(ok, `to equal ${inspect(e)}`);
        },
        toMatchObject: (e) => check(matches(actual, e), `to match ${inspect(e)}`),
        toContain: (e) => check(actual != null && actual.includes(e), `to contain ${inspect(e)}`),
        toMatch: (re) => check(typeof actual === "string" && (re instanceof RegExp ? re.test(actual) : actual.includes(re)), `to match ${re}`),
        toBeUndefined: () => check(actual === undefined, "to be undefined"),
        toBeNull: () => check(actual === null, "to be null"),
        toBeLessThan: (n) => check(actual < n, `to be less than ${n}`),
        toBeCloseTo: (n, digits = 2) => check(Math.abs(actual - n) < 10 ** -digits / 2, `to be close to ${n}`),
        toThrow: () => {
            let threw = false;
            try {
                actual();
            } catch {
                threw = true;
            }
            check(threw, "to throw");
        },
    };
}

/** Drop undefined-valued keys, as toEqual does in the usual test libraries. */
function normalise(v) {
    if (Array.isArray(v)) return v.map(normalise);
    if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
        const out = {};
        for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = normalise(x);
        return out;
    }
    return v;
}

function inspect(v) {
    try {
        const s = typeof v === "function" ? "[function]" : JSON.stringify(v);
        return s === undefined ? String(v) : s.length > 200 ? s.slice(0, 200) + "..." : s;
    } catch {
        return String(v);
    }
}

/**
 * @param {unknown} actual
 * @param {string} [message]
 */
export function expect(actual, message) {
    const m = makeMatchers(actual, message, false);
    return {
        ...m,
        not: makeMatchers(actual, message, true),
        rejects: {
            toThrow: async () => {
                await assert.rejects(Promise.resolve(actual));
            },
        },
    };
}
