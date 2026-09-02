# AgentCap (working name) — v0.1 Build Spec

**One-liner:** A low-cost, source-available CLI that puts a hard, real-time dollar/token spend cap on Claude Code / Codex / other AI coding-agent sessions, so a runaway agent can't burn an unexpected bill.

**Owner:** Abdul Manan, One Click Era — Product Development
**Status:** Ready to build. Hand this directly to a developer or paste it into Claude Code as the first prompt.

---

## Problem Statement

Developers running autonomous coding agents (Claude Code, Codex, custom agent loops) have no way to cap spend per-session or per-task in real time — only account-wide limits exist today. Multiple independent developers have posted real losses ($32 to $2,847) from runaway/looping agents in the last few months, and at least a dozen scrappy, low-traction open-source tools have been built to solve this same narrow problem — evidence of real, current, unmet pain with no dominant solution yet.

## Goals

1. A user can set a hard dollar (or token) cap on a single Claude Code session and have it halt automatically when the cap is hit.
2. Setup takes under 5 minutes with zero configuration beyond one command.
3. Works entirely locally — no data leaves the user's machine, no account/signup required for v0.1.
4. Ship a working version within 4 weeks with near-zero infrastructure cost.
5. Get to 50+ real installs and direct feedback within 2 weeks of public launch.

## Non-Goals (v0.1)

- **No hosted dashboard or team features** — this is a solo-developer, local-only tool for now; team budgets are a v0.2 consideration once demand is proven.
- **No multi-provider support at launch** — ship for Claude Code first (the most active pain point in research), add Codex/OpenAI in v0.2.
- **No task-success/observability verification yet** ("did the agent actually finish") — real and related, but a separate feature; don't let it block shipping the spend cap.
- **No mobile/SMS alerts** — desktop notification only for v0.1; Slack/SMS alerts are a paid-tier v0.2 feature.
- **No billing/payment system built in** — v0.1 ships no checkout flow. The licence is free for individuals on their own personal work; companies and organisations need a commercial licence, arranged manually for now. Automated billing comes after demand is validated.

## User Stories

1. As a solo developer, I want to set a hard dollar cap before starting a Claude Code session, so that a runaway agent can't surprise me with a bill.
2. As a solo developer, I want a clear desktop notification the moment my cap is about to be hit, so I can intervene before it's exceeded.
3. As a solo developer, I want the agent process to actually stop (not just warn) when the hard cap is reached, so the protection is real, not cosmetic.
4. As a solo developer, I want to see a simple running total of what the current session has cost so far, so I have visibility without checking a separate dashboard.
5. As a first-time user, I want to install and start using this with one command, so trying it costs me nothing.

## v0.1 Feature List

**Must-Have (P0) — cannot ship without these:**
- [ ] CLI command to set a spend cap for a session: `agentcap run --cap 5.00` (dollars) wraps the Claude Code invocation.
- [ ] Real-time tracking of tokens/dollars consumed per session, using Claude Code's hook system (`PreToolUse`/`PostToolUse` hooks) or direct API response parsing — no network proxy required.
- [ ] Hard stop: when the cap is hit, the tool terminates the active session/process, not just logs a warning.
- [ ] Desktop notification fired at 80% of cap (warning) and at 100% (hard stop).
- [ ] Local logging of every session's spend to a SQLite file (`~/.agentcap/usage.db`) — no cloud, no telemetry.
- [ ] `agentcap status` command to show today's/this-session's spend so far.
- [ ] Clear error handling: if the hook/tracking fails for any reason, fail *loud* (visible error), never fail silently — this is the one thing that must never quietly break, given the whole pitch is trust.

**Nice-to-Have (P1) — fast follow, not blocking launch:**
- [ ] Config file (`~/.agentcap/config.yaml`) for a default cap so the user doesn't retype it every time.
- [ ] `agentcap history` command showing a simple table of past sessions and their cost.
- [ ] Soft-cap mode (warn only, don't kill) as an option for users who want visibility without interruption.

**Future Considerations (P2) — explicitly out of scope for now, but don't architect against them:**
- OpenAI/Codex and Cursor support.
- Hosted team dashboard with shared budgets across a team.
- Task-completion verification ("did the agent actually finish, or did it abandon the task").
- Slack/SMS/email alerting.
- A paid tier.

## Acceptance Criteria (core P0 flow)

- Given a user runs `agentcap run --cap 5.00 -- claude`, when the session's cumulative cost reaches $4.00 (80%), then a desktop notification fires warning the user.
- Given the same session, when cumulative cost reaches $5.00 (100%), then the underlying agent process is terminated within a few seconds and a clear "cap reached, session stopped" message is shown.
- Given the tool cannot read usage data for any reason, when this happens, then the tool immediately prints a visible error and exits rather than silently continuing to "protect" the user without actually tracking anything.
- Given a session completes normally under the cap, when it ends, then the final cost is written to the local SQLite log and visible via `agentcap status`.

## Tech Stack

- **Language:** Node.js or Python — pick whichever the developer (or Claude Code) is fastest in; both have first-class support for Claude Code's hook system and SQLite.
- **Local storage:** SQLite (via a lightweight library — `better-sqlite3` for Node, or the built-in `sqlite3` module for Python). No server, no external database.
- **Integration point:** Claude Code's hooks configuration (`PreToolUse` / `PostToolUse` / session-end hooks) to capture token/cost data per tool call — this avoids building a full network proxy, which would be far more complex and fragile.
- **Notifications:** OS-native desktop notifications (`node-notifier` for Node, or `plyer`/`terminal-notifier` for Python/macOS); no external notification service.
- **Packaging/distribution:** npm package (`npx agentcap`) or a pip package (`pipx install agentcap`) — whichever matches the language choice, so install is a single command.
- **No cloud infrastructure, no hosting, no third-party API keys required** beyond the user's own Anthropic API key, which they already have.

## Week-by-Week Plan

**Week 1 — Core tracking engine.** Build the hook integration that captures per-call token/cost data from a Claude Code session and writes it to SQLite. Validate that the numbers match what Anthropic's own usage reporting shows. This is the highest-risk, most important piece — get it accurate before building anything on top of it.

**Week 2 — Cap enforcement + CLI.** Build the `agentcap run` wrapper command, the 80%/100% notification triggers, and the hard-stop process termination. Build `agentcap status`. Test failure modes deliberately (kill the process mid-session, corrupt the log file, etc.) to confirm the tool fails loud, not silent.

**Week 3 — Polish, packaging, and dogfooding.** Package for npm/pip, write the install/README docs, and use it yourself on real Claude Code sessions for several days to catch rough edges. Fix bugs found during real use before anyone else sees it.

**Week 4 — Public launch.** Publish to GitHub (source-available licence — see LICENSE), post a Show HN ("Show HN: Stop your Claude Code agent from burning your API budget") and an Indie Hackers build-in-public post explaining why you built it. Watch installs/stars and collect direct feedback for the next two weeks before deciding what to build next (team dashboard? multi-provider support? paid tier?).

## Open Questions

- **Engineering:** Does Claude Code's current hook system expose per-call token/cost data directly, or only tool-call metadata that needs to be cross-referenced against Anthropic's pricing table? Needs a short technical spike in Week 1 before committing to the exact implementation approach.
- **Engineering:** Node.js or Python — pick based on whoever is building this (you, a freelancer, or Claude Code itself); either works fine for this scope.
- **Product (revisit after launch, not now):** Should v0.2 add OpenAI/Codex support first, or team/dashboard features first? Decide based on what early users actually ask for, not in advance.

## How to Start Building With Claude Code

Paste this as your opening prompt in a fresh Claude Code session:

> "Build a CLI tool called AgentCap in [Node.js/Python] that wraps a Claude Code session and enforces a hard spend cap. It should use Claude Code's hook system to track token/dollar cost per tool call in real time, write usage to a local SQLite database at ~/.agentcap/usage.db, fire a desktop notification at 80% of a user-set cap, and terminate the session process when 100% of the cap is reached. Include a `status` command showing current session spend. If tracking ever fails, it must error loudly, never fail silently. Start by researching how Claude Code's hooks expose cost/token data, then scaffold the project."

Claude Code can write essentially all of this code — it's a well-scoped, mechanical build (API/hook integration, local storage, a CLI, OS notifications) with no complex UI or ambiguous business logic. Your job is to review what it builds, test the failure modes yourself, and make the product calls (exact cap defaults, wording of alerts, what ships in v0.2) — not to write the code line by line.
