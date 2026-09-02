# AgentCap

**A hard, real-time dollar cap on Claude Code sessions — so a runaway agent can't burn an unexpected bill.**

Free for individuals on their own personal work, source-available, and entirely local. No
account, no signup, no telemetry, no network calls. Company and team use needs a
[commercial licence](#licence).

```bash
agentcap run --cap 5.00 -- claude
```

Warns you at 80% of the cap. Terminates the session at 100%. Logs every session to a local
SQLite file you own.

---

## Install

```bash
npm install -g agentcap
```

Or run it without installing:

```bash
npx agentcap run --cap 5.00 -- claude
```

Requires Node 18.17+.

### If you get `agentcap: command not found` after installing

This almost always means npm's global bin directory isn't on your shell's `PATH`. It's
common with nvm, whose setup usually lives in `.zshrc` — so if your login shell is
**bash** (or you have no bash dotfiles), the shell never loads nvm and never sees
`agentcap`, `npm`, or even `node`.

Check where npm installed it and whether your shell can see that directory:

```bash
npm prefix -g              # npm's global bin lives in <prefix>/bin
echo $PATH
```

The most reliable fix is a small launcher in a directory that's always on `PATH`, which
calls node by absolute path instead of relying on `#!/usr/bin/env node`:

```bash
printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$(command -v node)" "$(npm prefix -g)/lib/node_modules/agentcap/bin/agentcap.js" \
  > /usr/local/bin/agentcap && chmod +x /usr/local/bin/agentcap
```

AgentCap also resolves the *agent* binary the same way — it checks `~/.local/bin`,
`~/bin`, `~/.claude/local`, `/usr/local/bin`, and `/opt/homebrew/bin` before giving up,
so `-- claude` keeps working even when Claude Code isn't on your `PATH`.

## Usage

```bash
# Wrap a normal interactive Claude Code session with a $5 cap
agentcap run --cap 5.00 -- claude

# `claude` is the default, so this is the same thing
agentcap run --cap 5.00

# Any Claude Code flags pass straight through
agentcap run --cap 10 -- claude --model opus --resume

# What have I spent today?
agentcap status
```

### `agentcap run --cap <dollars>`

Wraps the agent and enforces the cap:

- At **80%** — a desktop notification and a terminal warning.
- At **100%** — a desktop notification, a clear terminal message, and the agent process is
  terminated. Further tool calls are denied the instant the cap trips, so the agent cannot
  fire off one more expensive call on its way out.

Exit codes: `0` normal, `2` stopped by the cap, `3` tracking failure, `64` bad usage.

A cap is **required**. There is no implicit default, because an unbounded session is the exact
thing this tool exists to prevent.

### `agentcap status`

Today's sessions, what each cost, and a live figure for anything running right now.

```
agentcap status  2026-08-23

  STARTED  SPEND      CAP       STATUS     PROJECT
  09:14    $1.82      $5.00     done       ~/code/api
  11:02    $5.01      $5.00     capped     ~/code/webapp

  today  $6.83  across 2 sessions
```

---

## How it works

Claude Code's hook payloads contain **no token or cost data** — that was the first thing we
checked, across all 31 hook events. What every hook payload *does* contain is
`transcript_path`, and Claude Code's own transcript records the full Anthropic `usage` object
and model for every request it makes.

So AgentCap splits the job:

| Piece | Role |
|---|---|
| **Hooks** (`--settings`) | Report the authoritative transcript path, and act as the deny gate once the cap trips |
| **Transcript** (`.jsonl`) | The source of truth for tokens; read incrementally, priced locally |
| **Wrapper process** | Owns accounting, notifications, and terminating the agent |

Hooks are injected via `claude --settings '<json>'`, which *merges* with your existing config.
**AgentCap never writes to `~/.claude/settings.json` or your project's `.claude/settings.json`**,
so there is nothing to clean up and nothing to corrupt if it dies unexpectedly.

Full research notes, including the measurements behind the decisions below, are in
[`SPIKE-hook-cost-data.md`](SPIKE-hook-cost-data.md).

### Getting the number right

Two things make this harder than summing a column, and both are handled:

- **Claude Code writes one JSONL line per content block**, each repeating the same `usage`
  object. Summing naively over-counted a real 10 MB transcript by **2.3×** — which would make
  the hard stop fire less than halfway to your actual cap. AgentCap deduplicates by
  `message.id`.
- **Cache writes have two price tiers.** 5-minute writes cost 1.25× base input; 1-hour writes
  cost 2×. Claude Code leans heavily on 1-hour caching, so collapsing the two under-counts the
  single largest line item in a long session. AgentCap reads the TTL split separately.

Also counted: subagent (sidechain) usage, web search at $10/1k, fast-mode premium pricing, and
the 1.1× US data-residency multiplier.

## Failing loud

The whole pitch is trust, so AgentCap refuses to *look* like it is protecting you when it
isn't. It prints a visible error and stops the session if:

- a model appears that it has no price for (a new Claude release) — it will **never** silently
  price an unknown model at $0;
- the transcript cannot be read;
- no hook fires within 30 seconds, meaning it cannot confirm it is tracking at all;
- the wrapped command cannot be started.

A session it cannot measure is a session it cannot cap, and it says so rather than sitting there
looking reassuring.

## Honest limitations

**Costs are estimates at API list prices.** They are computed from Claude Code's own usage
records, not from your invoice. Volume discounts, credits, and negotiated rates aren't visible
locally.

**On a Pro/Max subscription you are not billed per token at all.** The dollar figure is then a
usage signal, not money — still useful as a runaway-loop circuit breaker, but it is not your
bill. AgentCap says this on every run rather than quietly implying otherwise.

**AgentCap misses a few cents of background usage per session, and you should know why.**
Claude Code makes a handful of requests it never writes into the conversation transcript —
summarising the conversation so `--resume` works, and status checks from commands like `/usage`.
Anthropic documents these as "background token usage", typically under $0.04 per session.
AgentCap reads the transcript, so it cannot see them, and its total therefore runs slightly low.

The size of that blind spot depends entirely on how big your cap is. On a deliberately tiny test
session it looked alarming: Claude Code reported $0.1173, AgentCap reported $0.1032 — a $0.014
gap, about 12%. But the missing amount is roughly *fixed per session*, not proportional to
spend, so on the $5 cap this tool is actually built for, the same few cents is **under 1%**. The
error shrinks as the cap grows.

Two things make this a bounded blind spot rather than a broken promise. First, it is arithmetic
we can verify: priced against Claude Code's *own* token counts, AgentCap reproduces its $0.1163
figure to the hundredth of a cent, so this is missing records, never bad maths. Second, it only
ever errs one way — **under**-counting — so the cap stops slightly late, never prematurely. What
this means in practice: treat the cap as a reliable circuit breaker against a runaway agent, and
treat the dollar figure as accurate to within a few cents rather than to the penny. If you need
every request captured, Claude Code can export
[OpenTelemetry metrics](https://code.claude.com/docs/en/monitoring-usage) that include the
background ones — the likely route to closing this gap in v0.2.

**The cap can overshoot slightly.** Cost is only knowable after a request completes, and Claude
Code writes its transcript asynchronously. AgentCap polls every 250ms and stops as soon as it
sees the cap crossed — but a request already in flight has already been billed. Expect to land
slightly over the cap, not exactly on it. Set the cap as a ceiling you're willing to hit, not a
precise budget.

**Resumed sessions are measured from where you resumed.** `--cap 5` on
`claude --resume` means "spend at most $5 from now on", not "this conversation must never exceed
$5 in total". The baseline is reported at startup.

**Claude Code has a built-in `--max-budget-usd` flag** that covers `--print` (non-interactive)
mode. If that fits your use case, use it — it's upstream and needs no wrapper. AgentCap covers
interactive sessions, which that flag does not, and adds persistent history and notifications.

**Mid-session warnings print to stderr while Claude Code owns the terminal**, so a line can land
in the middle of the TUI. The desktop notification is the primary in-session channel for that
reason.

## Where your data lives

Everything is local:

```
~/.agentcap/usage.db        # SQLite log of every session
~/.agentcap/run/<id>/       # per-session control files, while running
```

Set `AGENTCAP_HOME` to move it. Inspect it with any SQLite client — it's your data:

```bash
sqlite3 ~/.agentcap/usage.db "select started_at, cost_usd, cap_usd, status from sessions;"
```

## Scope

This is v0.1. It does Claude Code, on one machine, for one session at a time.

**In:** dollar caps, 80%/100% notifications, hard stop, local SQLite logging, `status`, loud failures.

**Not yet:** OpenAI/Codex and Cursor support, a config file for default caps, `agentcap history`,
soft-cap (warn-only) mode, team dashboards, Slack/SMS alerts.

## Development

```bash
npm install
npm test          # 49 tests, no API credits spent
```

The suite runs against `test/fake-claude.js`, a stand-in for the real binary that fires real
hook subprocesses, honours deny decisions, and reproduces Claude Code's one-line-per-content-block
transcript quirk. That means the cap, the warning, the deny gate, the SIGTERM→SIGKILL escalation,
and every fail-loud path are all exercised without spending a cent.

## Licence

Copyright (c) 2026 One Click Era (Abdul Manan). All rights reserved.

AgentCap is **source-available, not open source**. The full terms are in
[LICENSE](LICENSE); in plain language:

**Free, no permission needed, no payment:**

- You, as an individual, using AgentCap on your own personal projects.
- Self-directed learning and personal research.
- Modifying it for your own personal use.
- Passing along unmodified copies, with the licence and copyright notice left intact.

**Requires a paid commercial licence:**

- **Any use by a company, team, or organisation — including purely internal use.** Running
  AgentCap on your employer's machines, for your employer's projects, without distributing it
  to anyone, still needs a licence.
- Use by an individual as part of work done for an employer or a client.
- Selling, reselling, sublicensing, or charging anyone a fee for it.
- Offering it as a hosted or managed service, or as anything competing with AgentCap.
- Bundling or embedding it in a product or service you sell.
- Stripping the copyright notice, or redistributing it under a different name.

The short version: **free for you personally, paid for your company.** If you're reaching for
this to control spend on work you're paid for, that's a commercial licence — get in touch and
we'll sort one out.

Two things the licence spells out that are worth reading before you rely on this tool: it
**terminates running processes** when a cap is reached, which can lose unsaved work, and its
cost figures are **local estimates**, not billing statements — see
[Honest limitations](#honest-limitations). Responsibility for your account spend stays with you.

> Not legal advice. This licence was drafted for the project's needs, not reviewed by a lawyer.
> If revenue is going to depend on it, have a solicitor read it before you launch.
