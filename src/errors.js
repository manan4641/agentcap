'use strict';

/**
 * A failure in the tracking path.
 *
 * The whole pitch of AgentCap is trust: if we cannot account for spend, we must never
 * pretend to be protecting the user. Every throw of this type ends with a visible error
 * and a terminated agent -- never a silent downgrade to "unprotected but still running".
 */
class TrackingError extends Error {
  constructor(message, { hint } = {}) {
    super(message);
    this.name = 'TrackingError';
    this.hint = hint;
  }
}

/** A user-facing usage/CLI mistake. Not a tracking failure -- no agent to kill. */
class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

module.exports = { TrackingError, UsageError };
