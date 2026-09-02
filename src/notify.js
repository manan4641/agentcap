'use strict';

const { execFile } = require('child_process');

/**
 * OS-native desktop notification, with no third-party dependency and no external service.
 *
 * Notifications are best-effort by nature (a user can have them muted at the OS level),
 * so the terminal message printed alongside them is the real guarantee -- never the only
 * channel we rely on for the cap warning.
 */
function desktopNotify(title, message) {
  const done = () => {};
  try {
    if (process.platform === 'darwin') {
      // Prefer terminal-notifier when installed; it survives Focus modes better.
      execFile('which', ['terminal-notifier'], (err) => {
        if (!err) {
          execFile('terminal-notifier', ['-title', title, '-message', message], done);
        } else {
          const script = `display notification ${osaQuote(message)} with title ${osaQuote(title)} sound name "Basso"`;
          execFile('osascript', ['-e', script], done);
        }
      });
    } else if (process.platform === 'linux') {
      execFile('notify-send', ['-u', 'critical', title, message], done);
    } else if (process.platform === 'win32') {
      const ps = [
        '-NoProfile',
        '-Command',
        `[reflection.assembly]::loadwithpartialname('System.Windows.Forms') | Out-Null;` +
          `$n = New-Object System.Windows.Forms.NotifyIcon;` +
          `$n.Icon = [System.Drawing.SystemIcons]::Warning;` +
          `$n.Visible = $true;` +
          `$n.ShowBalloonTip(10000, ${psQuote(title)}, ${psQuote(message)}, 'Warning');`,
      ];
      execFile('powershell', ps, done);
    }
  } catch {
    // A failed notification must never take down the session or mask the cap logic.
  }
}

function osaQuote(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}
function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

module.exports = { desktopNotify };
