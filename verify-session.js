/* verify-session.js — drop into your stats / relay / matchmaker services.
 * Turns a Word Lava session token (from wordlava-auth) back into a trusted user id.
 * Uses the SAME SESSION_JWT_SECRET as the auth service. */
const { jwtVerify } = require('jose');
const SECRET = new TextEncoder().encode(process.env.SESSION_JWT_SECRET);

async function userFromSession(sessionToken) {
  const { payload } = await jwtVerify(sessionToken, SECRET, {
    issuer: 'wordlava-auth',
    audience: 'wordlava',
  });
  return { uid: payload.sub, name: payload.name, email: payload.email, provider: payload.provider };
}
module.exports = { userFromSession };
