/**
 * One-time Google Tasks authorization. Run:  npm run google-auth
 *
 * Prereqs in .env:  GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET from a Google Cloud
 * OAuth client (type "Desktop app"), with the Tasks API enabled on the project.
 *
 * This starts a tiny local server, prints an authorization URL, and — after you
 * approve in the browser — captures the code, exchanges it for a refresh token,
 * and prints the line to paste into .env.
 */
import 'dotenv/config';
import express from 'express';
import { config } from '../src/config.js';

const { clientId, clientSecret, authPort } = config.sources.googleTasks;
if (!clientId || !clientSecret) {
  console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first.');
  process.exit(1);
}

const redirectUri = `http://localhost:${authPort}`;
// Read-write so the dashboard can mark tasks done (two-way sync), not just read them.
const scope = 'https://www.googleapis.com/auth/tasks';
const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope,
    access_type: 'offline',
    prompt: 'consent', // force a refresh_token even on re-auth
  });

const app = express();
const server = app.listen(authPort, () => {
  console.log('\n1) Open this URL in your browser and approve read/write Tasks access:\n');
  console.log('   ' + authUrl + '\n');
  console.log(`2) Waiting for the redirect to ${redirectUri} …\n`);
});

// The OAuth code is single-use. Guard against the browser hitting the callback
// more than once (favicon requests, or a retry if the socket closes early) —
// otherwise the second hit re-exchanges the spent code and Google returns a
// confusing `invalid_grant` after we've already succeeded.
let handled = false;

/** Flush the HTTP response, then shut the server down and exit cleanly. */
function finish(exitCode: number): void {
  setTimeout(() => server.close(() => process.exit(exitCode)), 300);
}

app.get('/', async (req, res) => {
  const code = req.query.code as string | undefined;
  const err = req.query.error as string | undefined;

  if (err) {
    res.send(`Authorization failed: ${err}`);
    if (!handled) { handled = true; console.error('\nAuthorization failed:', err); finish(1); }
    return;
  }
  if (!code) { res.status(204).end(); return; }  // favicon / stray request — never touch the code
  if (handled) { res.send('Already authorized — you can close this tab.'); return; } // duplicate callback
  handled = true;

  try {
    const tok = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    const j: any = await tok.json();
    if (!j.refresh_token) {
      console.error('No refresh_token returned:', j);
      res.send('No refresh token returned. Remove this app at myaccount.google.com/permissions and try again.');
      finish(1);
      return;
    }
    console.log('\n✅  Add this line to your .env, then restart the app:\n');
    console.log('GOOGLE_REFRESH_TOKEN=' + j.refresh_token + '\n');
    res.send('<h2>Authorized ✓</h2><p>Refresh token printed in your terminal. Add it to .env and restart. You can close this tab.</p>');
    finish(0);
  } catch (e) {
    console.error(e);
    res.send('Token exchange error: ' + e);
    finish(1);
  }
});
