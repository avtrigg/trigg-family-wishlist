import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const derive = promisify(scrypt);
const token = () => randomBytes(32).toString("base64url");
const digest = (value) => createHash("sha256").update(value).digest("base64url");
const maxSessionAge = 30 * 24 * 60 * 60;
const passwordOptions = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };

async function passwordHash(password, salt) {
  return (await derive(password, salt, 32, passwordOptions)).toString("hex");
}

function signupProfile(input) {
  const firstName = typeof input?.firstName === "string" ? input.firstName.trim() : "";
  const lastName = typeof input?.lastName === "string" ? input.lastName.trim() : "";
  const shippingAddress = typeof input?.shippingAddress === "string" ? input.shippingAddress.trim() : "";
  if (!firstName || !lastName || firstName.length > 80 || lastName.length > 80 || shippingAddress.length > 1000) return;
  return { firstName, lastName, shippingAddress: shippingAddress || null };
}

const profileError = "Enter a first and last name and keep the optional shipping address under 1,001 characters.";

export function cookieValue(request, name) {
  return (request.headers.get("cookie") ?? "").split(";").map((part) => part.trim())
    .find((part) => part.startsWith(name + "="))?.slice(name.length + 1);
}

export function createAuth({ db, origin, base = "", googleId, googleSecret, familyCode, requestGoogle = fetch, json, fail }) {
  const secure = origin.startsWith("https:");
  const home = origin + base;
  const googleEnabled = Boolean(googleId && googleSecret);
  const cookie = (name, value, age) => name + "=" + value + "; Path=" + (base || "/") + "; HttpOnly; SameSite=Lax; Max-Age=" + age + (secure ? "; Secure" : "");
  const authError = (code) => Response.redirect(home + "/?auth=" + code, 303);

  function viewer(request) {
    const value = cookieValue(request, "family_session");
    if (!value) return;
    return db.prepare(`
      SELECT a.id, a.name FROM accounts a JOIN sessions s ON s.account_id = a.id
      WHERE s.digest = ? AND s.expires > ?
    `).get(digest(value), Date.now());
  }

  function startSession(account, request) {
    const previous = cookieValue(request, "family_session");
    if (previous) db.prepare("DELETE FROM sessions WHERE digest = ?").run(digest(previous));
    const accessToken = token();
    db.prepare("DELETE FROM sessions WHERE expires <= ?").run(Date.now());
    db.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run(digest(accessToken), account.id, Date.now() + maxSessionAge * 1000);
    return cookie("family_session", accessToken, maxSessionAge);
  }

  function checkCode(value) {
    if (!familyCode) return true;
    return typeof value === "string" && value.length < 512 &&
      timingSafeEqual(Buffer.from(digest(value)), Buffer.from(digest(familyCode)));
  }

  async function credentials(request, mode) {
    const input = await request.json().catch(() => null);
    const username = typeof input?.username === "string" ? input.username.trim() : "";
    const password = input?.password;
    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username) || typeof password !== "string" || password.length === 0 || password.length > 256) {
      return fail("Enter a username of 3–32 letters, numbers, dots, dashes, or underscores and a password.", 400);
    }
    if (mode === "signup") {
      if (!checkCode(input.familyCode)) return fail("The family access code is incorrect.", 403);
      const profile = signupProfile(input);
      if (!profile) return fail(profileError, 400);
      const { firstName, lastName, shippingAddress } = profile;
      const salt = token();
      const stored = salt + "." + await passwordHash(password, salt);
      const result = db.prepare(`
        INSERT INTO accounts (id, username, password, name, first_name, last_name, shipping_address)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(username) DO NOTHING RETURNING id, name
      `).get(randomUUID(), username, stored, firstName + " " + lastName, firstName, lastName, shippingAddress);
      if (!result) return fail("That username is already taken.", 409);
      return json({ user: result }, 201, { "Set-Cookie": startSession(result, request) });
    }
    const account = db.prepare("SELECT id, name, password FROM accounts WHERE username = ?").get(username);
    const [salt, hash] = account?.password?.split(".") ?? ["missing-account", "0".repeat(64)];
    const expected = Buffer.from(hash, "hex");
    const actual = Buffer.from(await passwordHash(password, salt), "hex");
    if (!timingSafeEqual(actual, expected) || !account) return fail("Username or password is incorrect.", 401);
    const user = { id: account.id, name: account.name };
    return json({ user }, 200, { "Set-Cookie": startSession(user, request) });
  }

  async function beginGoogle(request) {
    if (!googleEnabled) return fail("Google sign-in is unavailable.", 503);
    const input = await request.json().catch(() => null);
    const mode = input?.mode === "signup" ? "signup" : "login";
    if (mode === "signup" && !checkCode(input.familyCode)) return fail("The family access code is incorrect.", 403);
    const profile = mode === "signup" ? signupProfile(input) : null;
    if (mode === "signup" && !profile) return fail(profileError, 400);
    const state = token();
    const verifier = token();
    db.prepare("DELETE FROM oauth_states WHERE expires <= ?").run(Date.now());
    db.prepare("INSERT INTO oauth_states (state, verifier, mode, expires, signup_profile) VALUES (?, ?, ?, ?, ?)")
      .run(state, verifier, mode, Date.now() + 600_000, profile ? JSON.stringify(profile) : null);
    const params = new URLSearchParams({
      client_id: googleId, redirect_uri: home + "/auth/google/callback", response_type: "code",
      scope: "openid email profile", state, code_challenge: digest(verifier), code_challenge_method: "S256",
    });
    return json({ url: "https://accounts.google.com/o/oauth2/v2/auth?" + params }, 200, {
      "Set-Cookie": cookie("family_oauth", state, 600),
    });
  }

  async function finishGoogle(request, url) {
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    if (!googleEnabled || !state || state !== cookieValue(request, "family_oauth") || !code) return authError("google");
    const flow = db.prepare("DELETE FROM oauth_states WHERE state = ? AND expires > ? RETURNING *").get(state, Date.now());
    if (!flow) return authError("google");
    const options = { redirect: "error", signal: AbortSignal.timeout(8000) };
    const tokenResponse = await requestGoogle("https://oauth2.googleapis.com/token", {
      ...options, method: "POST", body: new URLSearchParams({
        code, client_id: googleId, client_secret: googleSecret, code_verifier: flow.verifier,
        redirect_uri: home + "/auth/google/callback", grant_type: "authorization_code",
      }),
    });
    if (!tokenResponse.ok) return authError("google");
    const { access_token: access } = await tokenResponse.json();
    if (!access) return authError("google");
    const profile = await requestGoogle("https://openidconnect.googleapis.com/v1/userinfo", {
      ...options, headers: { Authorization: "Bearer " + access },
    });
    if (!profile.ok) return authError("google");
    const { sub, email, email_verified: verified, hd } = await profile.json();
    if (typeof sub !== "string" || !sub) return authError("google");
    let account = db.prepare("SELECT id, name FROM accounts WHERE google_sub = ?").get(sub);
    if (!account) {
      if (flow.mode !== "signup" || !flow.signup_profile) return authError("signup");
      const { firstName, lastName, shippingAddress } = JSON.parse(flow.signup_profile);
      const address = typeof email === "string" ? email.toLowerCase() : "";
      const verifiedEmail = verified === true && (address.endsWith("@gmail.com") || hd) && address ? address : null;
      db.exec("BEGIN");
      try {
        account = db.prepare(`
          INSERT INTO accounts (id, google_sub, verified_email, name, first_name, last_name, shipping_address)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(google_sub) DO UPDATE SET google_sub = excluded.google_sub RETURNING id, name
        `).get(randomUUID(), sub, verifiedEmail, firstName + " " + lastName, firstName, lastName, shippingAddress);
        if (verifiedEmail) db.prepare("UPDATE lists SET owner_id = ? WHERE contact_email = ? AND owner_id IS NULL").run(account.id, verifiedEmail);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    const headers = new Headers({ Location: home + "/", "Cache-Control": "no-store" });
    headers.append("Set-Cookie", startSession(account, request));
    headers.append("Set-Cookie", cookie("family_oauth", "", 0));
    return new Response(null, { status: 303, headers });
  }

  function logout(request) {
    const value = cookieValue(request, "family_session");
    if (value) db.prepare("DELETE FROM sessions WHERE digest = ?").run(digest(value));
    return json({}, 200, { "Set-Cookie": cookie("family_session", "", 0) });
  }

  return { googleEnabled, viewer, credentials, beginGoogle, finishGoogle, logout, authError };
}
