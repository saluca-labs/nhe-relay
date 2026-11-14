# Costs

The relay can spend money on your behalf, so it has four independent brakes, all enforced before
a provider is called:

1. **Kill switch.** `RELAY_ENABLED` ships `"no"`. Anything but exactly `"yes"` refuses every call.
2. **Request limits.** Per session (6 a minute, 200 a day), per IP (20 a minute, 600 a day) and a
   global daily ceiling across every route (5,000 in code; the shipped `deploy.config.js` narrows it
   to 500). Every well-formed attempt counts, including ones the injection screen refuses.
3. **Spend ceiling.** A daily ceiling in US dollars (`spend.daily_usd_ceiling` in
   `relay.config.js`, at most $25 in code, $2 as shipped; `SPEND_DAILY_USD` may narrow it
   further). Before each paid provider call the relay reserves that call's worst-case cost. When
   the reservation would cross the ceiling, the provider is skipped; a later provider with a
   `flat` price can still answer. When every provider is skipped, the call returns
   `reason: "spend_ceiling"` with HTTP 429 until the next UTC day.
4. **Time.** Each provider has a timeout and each call a budget, so a slow provider costs a
   fallback line, not a hung request.

Limits and ceilings are code constants in `src/limits.js`. Configuration may only narrow them;
raising one is a code change.

## Prices are yours to declare

Every provider entry must carry a `price`, or the config does not load:

| List | Price fields |
|---|---|
| llm | `{"input_usd_per_mtok": n, "output_usd_per_mtok": n}` (dollars per million tokens) |
| stt | `{"usd_per_minute": n}` |
| tts | `{"usd_per_mchar": n}` (dollars per million characters) |
| any | `{"flat": true}`: no marginal cost (a free tier or a flat-fee subscription) |

The relay cannot read your bill, so the ceiling is only as good as these numbers. Check them
against your provider's current price list. The prices in the shipped `relay.config.js` were
read from Cloudflare's Workers AI pricing page on 2026-11-13; the ones in
`examples/configs/all-providers.js` are placeholders.

## How the worst case is estimated

The estimate is deliberately high, and the reservation is never refunded.

| List | Estimate |
|---|---|
| llm | input characters / 3 as tokens, plus `max_output_tokens` (300 as shipped) as output tokens. For `anthropic`, the larger of that and the entry's `max_tokens` (2048 by default), because thinking spends it. |
| stt | the longest clip the relay accepts (30 s), whatever the clip's real length |
| tts | the characters of the reply |

So the counter usually runs ahead of the bill. That is the safe direction: the ceiling trips
early, never late.

## Rough cost of a turn, as shipped

With the shipped Workers AI config (Llama 3.3 70B at $0.293 / $2.253 per million tokens, Whisper
large v3 turbo at $0.0005 a minute, Aura 2 at $0.030 per 1,000 characters):

| Step | Reserved | Typical |
|---|---|---|
| One turn (about 600 tokens in, 300 out reserved) | about $0.0009 | less, replies are short |
| One clip to text | $0.00025 (30 s) | less for a short clip |
| One reply spoken (about 120 characters) | about $0.0036 | the same |

Speech output dominates. At the shipped $2 ceiling, a fully spoken conversation runs to roughly
400 to 450 turns a day before the ceiling stops paid calls. Workers AI also has a free daily
allocation, which the relay does not know about and does not count.

These figures are arithmetic on the prices above, not a measured bill.

## Cloudflare itself

Workers requests and Durable Object calls are billed by Cloudflare under your plan. The relay
makes one Durable Object call for the limits on each well-formed request, plus one per paid
provider attempt for the spend reservation.
