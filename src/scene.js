// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// Scene state: a game with a fixed story and improvised dialogue tells the relay where the
// character is in that story. Everything here is DATA sent by the client: validated, bounded,
// screened, and placed in the frame as the character's current objective, never as rules.
// Scene and beat definitions belong to each game; none live in this repo.

import { sanitize, screenInjection, containsUrl } from "./safety.js";
export const SCENE_LIMITS = {
    idChars: 64,
    intentionChars: 200,
    directorNoteChars: 200,
    maxMustSay: 4,
    maxMustNotReveal: 6,
    factChars: 120,
    maxTake: 999,
};
export const BEAT_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
function cleanText(v, max, required) {
    if (v === undefined && !required)
        return "";
    if (typeof v !== "string")
        return undefined;
    if (v.length > max * 2)
        return null;
    const s = sanitize(v);
    if (s.length > max || (required && s.length === 0))
        return null;
    return s;
}
function cleanList(v, maxItems) {
    if (v === undefined)
        return [];
    if (!Array.isArray(v))
        return undefined;
    if (v.length > maxItems)
        return null;
    const out = [];
    for (const x of v) {
        const s = cleanText(x, SCENE_LIMITS.factChars, true);
        if (s === undefined)
            return undefined;
        if (s === null)
            return null;
        out.push(s);
    }
    return out;
}
export function validateScene(raw) {
    if (raw === undefined || raw === null)
        return { ok: true, scene: null };
    if (typeof raw !== "object" || Array.isArray(raw))
        return { ok: false, reason: "scene_type" };
    const s = raw;
    const allowed = new Set(["scene_id", "beat_id", "beat_intention", "must_say", "must_not_reveal", "take", "director_note"]);
    for (const k of Object.keys(s))
        if (!allowed.has(k))
            return { ok: false, reason: "scene_unknown_field" };
    if (typeof s.scene_id !== "string" || !BEAT_ID_RE.test(s.scene_id))
        return { ok: false, reason: "scene_id" };
    if (typeof s.beat_id !== "string" || !BEAT_ID_RE.test(s.beat_id))
        return { ok: false, reason: "scene_beat_id" };
    const beat_intention = cleanText(s.beat_intention, SCENE_LIMITS.intentionChars, true);
    if (typeof beat_intention !== "string")
        return { ok: false, reason: beat_intention === null ? "scene_intention_size" : "scene_intention_type" };
    const director_note = cleanText(s.director_note, SCENE_LIMITS.directorNoteChars, false);
    if (typeof director_note !== "string")
        return { ok: false, reason: director_note === null ? "scene_note_size" : "scene_note_type" };
    const must_say = cleanList(s.must_say, SCENE_LIMITS.maxMustSay);
    if (!must_say)
        return { ok: false, reason: must_say === null ? "scene_must_say_size" : "scene_must_say_type" };
    const must_not_reveal = cleanList(s.must_not_reveal, SCENE_LIMITS.maxMustNotReveal);
    if (!must_not_reveal)
        return { ok: false, reason: must_not_reveal === null ? "scene_must_not_reveal_size" : "scene_must_not_reveal_type" };
    const take = s.take === undefined ? 1 : s.take;
    if (typeof take !== "number" || !Number.isSafeInteger(take) || take < 1 || take > SCENE_LIMITS.maxTake)
        return { ok: false, reason: "scene_take" };
    const all = [beat_intention, director_note, ...must_say, ...must_not_reveal].join("\n");
    if (screenInjection(all) || containsUrl(all))
        return { ok: false, reason: "scene_screened" };
    return { ok: true, scene: { scene_id: s.scene_id, beat_id: s.beat_id, beat_intention, must_say, must_not_reveal, take, director_note } };
}
/** The scene as quoted data for the user message. The frame says what the tags mean. */
export function sceneBlock(scene) {
    const list = (xs) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "(none)");
    return [
        "<scene>",
        `scene: ${scene.scene_id} / beat: ${scene.beat_id} / take: ${scene.take}`,
        `your objective in this beat: ${scene.beat_intention}`,
        `work these into the conversation, naturally, when it fits:\n${list(scene.must_say)}`,
        `never reveal, hint at or confirm:\n${list(scene.must_not_reveal)}`,
        `director's note: ${scene.director_note || "(none)"}`,
        "</scene>",
    ].join("\n");
}
function norm(s) {
    return s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036F]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}
const STOP = new Set(["the", "and", "that", "this", "with", "from", "they", "their", "there", "have", "has", "was", "were", "is", "are", "for", "not", "but", "you", "your"]);
const NUMBER_WORDS = {
    zero: "0", oh: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9",
};
/** Digits in order, with spelled-out single digits ("seven three") read as digits too. */
function digitsOf(s) {
    return norm(s)
        .split(" ")
        .map((w) => NUMBER_WORDS[w] ?? w.replace(/[^0-9]/g, ""))
        .join("");
}
/**
 * True when the reply gives away a must_not_reveal entry:
 * - the entry appears in the reply after normalising case, accents and punctuation; or
 * - for entries of two or more content words, every content word of the entry appears; or
 * - for entries that carry three or more digits (a code, a combination, a date), that digit
 *   sequence appears in the reply's digits, however it is spaced, punctuated or spelled
 *   ("7319", "7-3-1-9", "seven three one nine").
 * Deliberately strict: a false positive costs one fallback line, a false negative spoils the story.
 */
export function reveals(reply, secrets) {
    const r = ` ${norm(reply)} `;
    const words = new Set(r.trim().split(" "));
    const replyDigits = digitsOf(reply);
    for (const s of secrets) {
        const n = norm(s);
        if (!n)
            continue;
        if (r.includes(` ${n} `))
            return true;
        const content = n.split(" ").filter((w) => w.length >= 3 && !STOP.has(w));
        if (content.length >= 2 && content.every((w) => words.has(w)))
            return true;
        const d = digitsOf(s);
        if (d.length >= 3 && replyDigits.includes(d))
            return true;
    }
    return false;
}
