// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// CORS from the config: an exact list of https origins, plus http://127.0.0.1 and
// http://localhost (any port) when allow_localhost is true. No wildcards, no credentials, ever.
// A browser request from any other origin is refused with 403 before anything else runs.

const LOCAL = /^http:\/\/(?:127\.0\.0\.1|localhost)(?::[0-9]{1,5})?$/;
export function originAllowed(origin, policy) {
    if (!origin)
        return false;
    if (policy.origins.includes(origin))
        return true;
    return policy.allowLocalhost && LOCAL.test(origin);
}
export function corsHeaders(origin, policy) {
    const h = { vary: "Origin" };
    if (origin && policy && originAllowed(origin, policy)) {
        h["access-control-allow-origin"] = origin;
        h["access-control-allow-methods"] = "POST, GET, OPTIONS";
        h["access-control-allow-headers"] = "content-type";
        h["access-control-expose-headers"] = "x-nhe-provider, x-nhe-fallback";
        h["access-control-max-age"] = "600";
    }
    return h;
}
