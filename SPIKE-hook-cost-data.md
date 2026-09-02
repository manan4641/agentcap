# Spike: How Claude Code's hooks expose token/cost data

**Date:** 2026-08-23 · **Claude Code version tested:** 2.1.83 · **Status:** Resolved — proceed with Approach B

Answers the spec's Week-1 open question:
> Does Claude Code's hook system expose per-call token/cost data directly, or only tool-call
> metadata that needs to be cross-referenced against Anthropic's pricing table?

## Answer

**Only metadata. Hook payloads contain no token counts and no cost fields.** The second half of the
question is the correct one: we must cross-reference against a local pricing table.

But the picture is better than "tool-call metadata only", because **every hook payload includes
`transcript_path`**, and the transcript is a JSONL file whose assistant records carry the full
Anthropic `usage` object plus the `model` that served the request. That is authoritative,
per-request billing data written locally by Claude Code itself.

### What hooks give us

Confirmed against the hooks reference. Every hook receives, via stdin:

```json
{
  "session_id": "…",
  "transcript_path": "/Users/…/.claude/projects/<slug>/<session-uuid>.jsonl",
  "cwd": "…",
  "hook_event_name": "PostToolUse",
  "permission_mode": "…",
  "tool_name": "Bash",
  "tool_input": { … },
  "tool_use_id": "toolu_…"
}
```

No `cost_usd`, no `total_cost_usd`, no `usage`, no `input_tokens`/`output_tokens`. Verified across
the documented payloads for all 31 hook events.

### What the transcript gives us

Each `type: "assistant"` line carries `message.usage` and `message.model`:

```json
{
  "input_tokens": 3,
  "cache_creation_input_tokens": 13310,
  "cache_read_input_tokens": 12936,
  "output_tokens": 115,
  "cache_creation": { "ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 13310 },
  "server_tool_use": { "web_search_requests": 0, "web_fetch_requests": 0 },
  "service_tier": "standard",
  "speed": "standard",
  "inference_geo": ""
}
```

This has every field needed to price a request exactly — including the 5m/1h cache-write split,
which matters a lot (1.25x vs 2.0x base input).

## Chosen architecture

**Hooks for discovery + enforcement; transcript for accounting.**

1. `agentcap run` generates a session UUID and passes `--session-id`, so we know our transcript path
   up front instead of guessing which file is ours.
2. Hooks are injected with `claude --settings '<json>'` — **no edits to the user's `~/.claude/settings.json`
   or the project's `.claude/settings.json`.** Nothing to clean up, nothing to corrupt.
3. `PostToolUse` / `Stop` / `SessionEnd` hooks act as a *poke*: each fires a cheap re-read of the
   transcript, we recompute cumulative spend, and compare to the cap.
4. Enforcement at 100% is two-layer: a `PreToolUse` hook returns `permissionDecision: "deny"` so the
   agent cannot take further action even in the seconds before the process dies, and the wrapper
   sends SIGTERM (then SIGKILL) to the child.
5. A filesystem watcher on the transcript is the backstop, because a wedged agent that stops calling
   tools would otherwise stop poking us.

## Findings that change the implementation

### 1. Naive summing over-counts by ~2.3x  ← the big one

Claude Code writes **one JSONL line per content block**, and every line repeats the *same* `usage`
object for that request. Measured on a real 10 MB transcript:

| Method | Output tokens | Cache read |
|---|---|---|
| Sum every assistant line (naive) | 434,161 | 67,978,777 |
| **Dedupe by `message.id`** | **186,604** | **39,475,273** |

A 2.3x over-count would make the tool fire its hard stop less than halfway to the real cap. All 226
duplicate-`requestId` groups had byte-identical usage, confirming these are repeats, not increments.
**Dedupe by `message.id` before summing.** (`requestId` gives the same answer; `message.id` is the
more precise key.)

### 2. Cache writes must be split by TTL
Claude Code uses 1-hour caching heavily. Pricing them at the 5m rate (1.25x) instead of 1h (2x)
under-counts the largest single line item in a long session. Read
`cache_creation.ephemeral_1h_input_tokens` and `ephemeral_5m_input_tokens` separately.

### 3. The transcript lags
Docs state it is written asynchronously and may not include the current turn when a hook fires. So
the cap is enforced with a small, bounded lag — worth stating honestly in the README rather than
implying to-the-cent instant cutoff.

### 4. Models seen in real local transcripts
`claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-fable-5`, and a
`<synthetic>` pseudo-model (error placeholders — zero cost, must not crash the pricer). An unknown
model ID must **fail loud**, per the spec's trust requirement — never silently price at $0.

### 5. Extras that belong in the total
- Web search: **$10 per 1,000 searches** (`server_tool_use.web_search_requests`). Web fetch is free.
- `speed: "fast"` on Opus 5 / 4.8 is billed at $10/$50 per MTok, not $5/$25.
- `inference_geo: "us"` applies a 1.1x multiplier to every category.
- Subagent (`isSidechain: true`) records appear in the same transcript and must be counted.

## Pricing table (per MTok, USD, verified 2026-08-23)

| Model | Input | 5m write | 1h write | Cache read | Output |
|---|---|---|---|---|---|
| claude-fable-5 | 10 | 12.50 | 20 | 1.00 | 50 |
| claude-opus-5 | 5 | 6.25 | 10 | 0.50 | 25 |
| claude-opus-4-8 | 5 | 6.25 | 10 | 0.50 | 25 |
| claude-opus-4-7 | 5 | 6.25 | 10 | 0.50 | 25 |
| claude-opus-4-6 | 5 | 6.25 | 10 | 0.50 | 25 |
| claude-sonnet-5 | 2 | 2.50 | 4 | 0.20 | 10 |
| claude-sonnet-4-6 | 3 | 3.75 | 6 | 0.30 | 15 |
| claude-haiku-4-5 | 1 | 1.25 | 2 | 0.10 | 5 |

Fast mode (Opus 5 / 4.8 with `speed: "fast"`): 10 input / 50 output.

## Two things the spec should know

**1. Claude Code already ships `--max-budget-usd`.** It is documented as `--print`-only, so it does
not cover interactive sessions — which is where the runaway-agent pain actually happens, and where
every loss report in the problem statement came from. AgentCap's remaining wedge: interactive
sessions, persistent history across sessions, notifications, and eventual multi-provider support.
Worth knowing before the Show HN, because someone in the comments will raise it.

**2. Dollar caps are meaningless on a Pro/Max subscription.** Subscription users are not billed
per-token, so a dollar figure computed from API list prices is notional, not money. This needs an
explicit product decision — see the open question raised back to the owner.
