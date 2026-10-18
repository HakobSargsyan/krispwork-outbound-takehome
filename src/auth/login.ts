/**
 * The /login page itself: HTML + the GET/POST routes. Every dynamic value
 * in the markup is HTML-escaped (client_id and scope come from the OAuth
 * request; the error echoes a failed attempt) -- printing them raw would
 * be reflected XSS.
 */

import express, { type Request, type Response, type Router } from "express";

import { config } from "../config.js";
import { authenticate } from "./passwords.js";
import { completeLogin, peekPendingLogin } from "./provider.js";
import { CSRF_COOKIE, csrfMatches, issueCsrfToken, rateLimitOk, recordAttempt } from "./security.js";

const ESCAPE: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPE[ch]!);
}

function loginPageHtml(
  loginId: string,
  csrfToken: string,
  clientId: string,
  scope: string,
  redirectHost: string,
  error?: string,
): string {
  const errorHtml = error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in</title><meta name="robots" content="noindex, nofollow">
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;min-height:100vh;margin:0;display:flex;align-items:center;justify-content:center;padding:1.5rem;background:linear-gradient(160deg,#eef1f7 0%,#f4f5f7 55%);color:#1c1e21}
.card{width:100%;max-width:360px;background:#fff;border-radius:16px;padding:2rem 1.75rem;box-shadow:0 1px 3px rgba(0,0,0,.07),0 12px 32px rgba(26,30,40,.08);animation:rise .35s ease-out}
@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
.icon-badge{width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;color:#fff;margin-bottom:1rem;background:linear-gradient(135deg,#4a7dfc,#7c5cfa);box-shadow:0 6px 16px rgba(74,125,252,.35)}
h1{font-size:1.3rem;margin:0 0 .35rem;letter-spacing:-.01em}
.lede{font-size:.88rem;color:#52555c;margin:0 0 1.25rem;line-height:1.5}
.lede strong{color:#1c1e21}
.scope-box{background:#f4f5f7;border:1px solid #e7e9ec;border-radius:10px;padding:.65rem .8rem;margin:0 0 1.25rem;font-size:.82rem;color:#52555c;line-height:1.6}
.scope-box code{background:#e7e9ec;border-radius:5px;padding:.15rem .4rem;font-size:.78rem}
.error{background:#fdecea;color:#92120b;border-left:3px solid #e03131;border-radius:8px;padding:.6rem .75rem;margin:0 0 1.1rem;font-size:.85rem}
label{display:block;margin-top:1rem;font-size:.82rem;font-weight:600;color:#3a3d42}
input{width:100%;padding:.65rem .75rem;margin-top:.35rem;border:1px solid #d6d8db;border-radius:9px;font-size:.95rem;background:#fff;color:inherit;transition:border-color .15s,box-shadow .15s}
input:focus{outline:none;border-color:#4a7dfc;box-shadow:0 0 0 3px rgba(74,125,252,.18)}
button{margin-top:1.5rem;width:100%;padding:.7rem;border:none;border-radius:9px;background:#1c1e21;color:#fff;font-size:.95rem;font-weight:600;cursor:pointer;box-shadow:0 1px 2px rgba(0,0,0,.08);transition:background .15s,box-shadow .15s,transform .05s;display:flex;align-items:center;justify-content:center;gap:.5rem}
button:hover{background:#34373c;box-shadow:0 6px 16px rgba(0,0,0,.15)}
button:active{transform:translateY(1px)}
button:focus-visible{outline:2px solid #4a7dfc;outline-offset:2px}
button:disabled{cursor:default;opacity:.85;box-shadow:none}
.spinner{display:none;width:15px;height:15px;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:spin .65s linear infinite;flex:none}
button.loading .spinner{display:inline-block}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-color-scheme:dark){
body{background:linear-gradient(160deg,#0a0c10 0%,#14161b 55%);color:#e7e9ec}
.card{background:#1a1c20;box-shadow:0 1px 3px rgba(0,0,0,.4),0 12px 32px rgba(0,0,0,.4)}
.lede{color:#9a9ea5}.lede strong{color:#e7e9ec}
.scope-box{background:#111317;border-color:#272a30;color:#9a9ea5}.scope-box code{background:#272a30;color:#e7e9ec}
.error{background:#3a1512;color:#ff8a80}
label{color:#c3c6cb}
input{background:#111317;border-color:#30333a;color:#e7e9ec}
button{background:#e7e9ec;color:#0f1115}
button:hover{background:#cfd2d6}
.spinner{border-color:rgba(15,17,21,.35);border-top-color:#0f1115}
}
</style>
</head>
<body>
<div class="card">
<div class="icon-badge" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path></svg></div>
<h1>Sign in</h1>
<p class="lede">&ldquo;<strong>${escapeHtml(clientId)}</strong>&rdquo; wants to access your leads. You'll be redirected to <strong>${escapeHtml(redirectHost)}</strong> after signing in.</p>
<p class="scope-box">Requested permissions: <code>${escapeHtml(scope)}</code></p>
${errorHtml}
<form method="post" action="/login" autocomplete="off" onsubmit="var b=this.querySelector('button');b.disabled=true;b.classList.add('loading');b.querySelector('.btn-text').textContent='Signing in…'">
<input type="hidden" name="login_id" value="${escapeHtml(loginId)}">
<input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
<label>Username<input type="text" name="username" autocomplete="username" required autofocus></label>
<label>Password<input type="password" name="password" autocomplete="current-password" required></label>
<button type="submit"><span class="spinner" aria-hidden="true"></span><span class="btn-text">Sign in</span></button>
</form>
</div>
</body>
</html>`;
}

const EXPIRED_PAGE = "<!doctype html><title>Sign in</title><p>This sign-in link has expired or is invalid.</p>";
const RATE_LIMITED_PAGE = "<!doctype html><title>Sign in</title><p>Too many attempts. Please wait a few minutes.</p>";

// no-store: nothing here should be cached. X-Frame-Options/CSP: the form
// can't be framed (clickjacking) and loads no scripts or cross-origin
// resources at all, except script-src-attr 'unsafe-inline' -- that only
// permits the page's own inline onsubmit="..." attribute (disables the
// submit button and shows a loading spinner), not <script> tags or
// javascript: URIs, so it doesn't reopen a path for injected script
// content even though every dynamic value is already escaped.
//
// No `form-action` directive: in testing, `form-action 'self'` --
// confirmed down to that exact single-directive header, no interaction
// with default-src/style-src -- reproducibly blocked this page's own
// same-origin POST to /login with `net::ERR_ABORTED` / a CSP violation,
// in two independent browsers (an automated Chromium test tool and a
// real user's own Chrome), across two different tunnel providers and
// plain 127.0.0.1 with no tunnel at all. That rules out the tunnel
// domain, iframing, an injected <meta> CSP tag, and (per direct testing)
// the user's ad blocker. It reproduces with an explicit origin in place
// of 'self' too, so it isn't a same-origin-resolution bug specifically --
// something about this browser's `form-action` enforcement itself is
// broken for this page. Omitting it isn't a free pass though: the
// directive's job was defense-in-depth against the form's own `action`
// being hijacked by injected markup, and here that attribute is a
// hardcoded literal ("/login") never influenced by request data -- the
// actual XSS defense is escapeHtml() on every interpolated value, which
// this doesn't touch. If `form-action` ever starts working again, restore
// it (`form-action 'self'`) and re-test with a real browser before
// trusting it, not just curl.
const HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src-attr 'unsafe-inline'",
};

function renderLoginForm(res: Response, loginId: string, error?: string): void {
  const pending = loginId ? peekPendingLogin(loginId) : undefined;
  if (!pending) {
    res.set(HEADERS).status(400).type("html").send(EXPIRED_PAGE);
    return;
  }
  const csrfToken = issueCsrfToken();
  const redirectHost = new URL(pending.params.redirectUri).host;
  const body = loginPageHtml(loginId, csrfToken, pending.client.client_id, (pending.params.scopes ?? []).join(" "), redirectHost, error);
  res
    .set(HEADERS)
    .cookie(CSRF_COOKIE, csrfToken, {
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: "lax",
      maxAge: config.loginSessionTtlSeconds * 1000,
      path: "/login",
    })
    .status(200)
    .type("html")
    .send(body);
}

export function loginRouter(): Router {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false }));

  router.get("/login", (req: Request, res: Response) => {
    renderLoginForm(res, String(req.query.login_id ?? ""));
  });

  router.post("/login", (req: Request, res: Response) => {
    const loginId = String(req.body.login_id ?? "");

    if (!csrfMatches(req.cookies?.[CSRF_COOKIE], req.body.csrf_token)) {
      res.set(HEADERS).status(400).type("html").send(EXPIRED_PAGE);
      return;
    }

    const ip = req.ip ?? "unknown";
    if (!rateLimitOk(ip)) {
      res.set(HEADERS).status(429).type("html").send(RATE_LIMITED_PAGE);
      return;
    }
    recordAttempt(ip);

    const username = String(req.body.username ?? "");
    const password = String(req.body.password ?? "");
    if (!authenticate(username, password)) {
      // Same message either way -- distinguishing "no such user" from
      // "wrong password" would let an attacker enumerate usernames.
      renderLoginForm(res, loginId, "Invalid username or password.");
      return;
    }

    const redirectUrl = completeLogin(loginId, username);
    if (!redirectUrl) {
      res.set(HEADERS).status(400).type("html").send(EXPIRED_PAGE);
      return;
    }
    res.set(HEADERS).clearCookie(CSRF_COOKIE, { path: "/login" }).redirect(302, redirectUrl);
  });

  return router;
}
