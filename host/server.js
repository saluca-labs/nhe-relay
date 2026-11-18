// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

// Node entry point: runs the relay as a self-hosted HTTP server.
//
// The Worker entry (src/index.js) exports a fetch(request, env) handler. This module wraps it
// for Node: an http.Server that converts IncomingMessage to a Request, maps process.env to the
// env object, and provides a LocalLimiter in place of the Durable Object binding.
//
// Usage:
//   node host/server.js [--port 8787] [--host 127.0.0.1]
//
// Required environment:
//   RELAY_HMAC_KEY  - 32+ character HMAC key (secret, never printed)
//   RELAY_ENABLED   - "yes" to accept traffic (ships off)
//
// Provider secrets (e.g. LLM_KEY) are read from process.env at call time, same as Worker secrets.
// The config file (relay.config.js) names which secret each provider needs.

import http from "node:http";
import workerDefault from "../src/index.js";
import { LocalLimiter } from "../src/local-limiter.js";

/**
 * Build the env object from process.env. Worker bindings (LIMITER, AI) are replaced by
 * local equivalents. All other env vars pass through by name.
 */
export function buildEnv(processEnv) {
    const env = {};
    for (const [k, v] of Object.entries(processEnv)) {
        if (typeof v === "string") env[k] = v;
    }
    return env;
}

/**
 * Create a limiter stub that mimics the Durable Object binding interface.
 * The Worker entry calls env.LIMITER.get(env.LIMITER.idFromName("global")).fetch(...).
 * We provide a stub with get() that returns the limiter itself.
 */
export function makeLimiterBinding(limiter) {
    const stub = {
        fetch: (url, init) => limiter.fetch(new Request(url, init)),
    };
    return {
        get() { return stub; },
        idFromName() { return "global"; },
    };
}

/**
 * Convert a Node IncomingMessage to a Web Request.
 * Node 20+ has global Request, Response, fetch, crypto.subtle.
 */
export function toRequest(req, body) {
    const protocol = req.headers["x-forwarded-proto"] || "http";
    const host = req.headers.host || "localhost";
    const url = `${protocol}://${host}${req.url}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers.set(k, v);
        else if (Array.isArray(v)) headers.set(k, v.join(", "));
    }
    const method = req.method || "GET";
    const init = { method, headers };
    if (method !== "GET" && method !== "HEAD" && body.length > 0) {
        init.body = body;
    }
    return new Request(url, init);
}

/**
 * Convert a Web Response to a Node ServerResponse.
 */
export async function writeResponse(webResp, res) {
    const headers = {};
    webResp.headers.forEach((v, k) => { headers[k] = v; });
    res.writeHead(webResp.status, headers);
    if (webResp.headers.get("content-type")?.includes("text/event-stream") || webResp.body) {
        const buf = new Uint8Array(await webResp.arrayBuffer());
        res.end(buf);
    } else {
        res.end();
    }
}

/**
 * Read the full request body into a Uint8Array, respecting a max size.
 */
export function readBody(req, maxBytes) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        req.on("data", (chunk) => {
            total += chunk.length;
            if (total > maxBytes) {
                req.destroy();
                reject(new Error("body_too_large"));
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            const buf = new Uint8Array(total);
            let offset = 0;
            for (const c of chunks) {
                buf.set(c, offset);
                offset += c.length;
            }
            resolve(buf);
        });
        req.on("error", reject);
    });
}

/**
 * Create the HTTP server. Returns the server instance.
 * @param {object} opts - { port, host, env, limiter }
 */
export function createServer(opts = {}) {
    const port = opts.port ?? Number(process.env.PORT) ?? 8787;
    const host = opts.host ?? process.env.HOST ?? "127.0.0.1";
    const env = opts.env ?? buildEnv(process.env);
    const limiter = opts.limiter ?? new LocalLimiter();

    if (!env.LIMITER) env.LIMITER = makeLimiterBinding(limiter);

    // IP extraction: on Cloudflare, cf-connecting-ip is set. On a direct Node server behind a
    // proxy, x-forwarded-for is the first untrusted hop. Behind no proxy, the socket address.
    const server = http.createServer(async (req, res) => {
        try {
            const body = await readBody(req, 1_048_576);
            let request = toRequest(req, body);

            // If there is no cf-connecting-ip, fall back to x-forwarded-for or the socket.
            if (!request.headers.get("cf-connecting-ip")) {
                const xff = req.headers["x-forwarded-for"];
                const ip = typeof xff === "string" ? xff.split(",")[0].trim() : req.socket.remoteAddress ?? "";
                // Mutate the Request's headers by constructing a new one.
                const newHeaders = new Headers(request.headers);
                newHeaders.set("cf-connecting-ip", ip);
                request = new Request(request.url, {
                    method: request.method,
                    headers: newHeaders,
                    body: request.body,
                    duplex: "half",
                });
            }

            const webResp = await workerDefault.fetch(request, env);
            await writeResponse(webResp, res);
        } catch (e) {
            if (!res.headersSent) {
                res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ fallback: true, reason: "server_error" }));
            }
        }
    });

    return { server, port, host, env, limiter };
}

/**
 * Start the server. Called when this module is the entry point.
 */
export function startServer(opts = {}) {
    const { server, port, host } = createServer(opts);
    server.listen(port, host, () => {
        console.log(JSON.stringify({ svc: "nhe-relay", evt: "server_start", host, port }));
    });
    return server;
}

// When run directly (node host/server.js), start the server.
// import.meta.url check for dual ESM/test compatibility.
if (import.meta.url === `file://${process.argv[1]}`) {
    startServer();
}

