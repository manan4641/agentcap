'use strict';

const useColor = process.stderr.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));

const bold = wrap(1);
const dim = wrap(2);
const red = wrap(31);
const green = wrap(32);
const yellow = wrap(33);

/** Sub-cent spend is common early in a session, so show enough precision to be believable. */
function fmtUsd(n) {
  const v = Number(n) || 0;
  if (v > 0 && v < 0.01) return '$' + v.toFixed(4);
  return '$' + v.toFixed(2);
}

/** Pad/truncate for the status table. */
function pad(s, w) {
  const str = String(s);
  return str.length >= w ? str.slice(0, w) : str + ' '.repeat(w - str.length);
}

module.exports = { fmtUsd, bold, dim, red, green, yellow, pad };
