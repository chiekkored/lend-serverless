const admin = require("firebase-admin");
const { onRequest } = require("firebase-functions/v2/https");

if (process.env.FUNCTIONS_EMULATOR === "true") {
  require("dotenv").config({ path: ".secret.local" });
}

const jsonResponse = (res, status, body) => {
  res.status(status).json(body);
};

const setCorsHeaders = (res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
};

exports.bootstrapAdminUser = onRequest({ cors: true }, async (req, res) => {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

  if (req.method !== "POST") {
    jsonResponse(res, 405, { error: "Method not allowed." });
    return;
  }

  const expectedSecret = process.env.ADMIN_BOOTSTRAP_SECRET;
  if (!expectedSecret) {
    jsonResponse(res, 500, { error: "Bootstrap secret is not configured." });
    return;
  }

  const { email, password, displayName, setupSecret } = req.body ?? {};

  if (setupSecret !== expectedSecret) {
    jsonResponse(res, 403, { error: "Invalid setup secret." });
    return;
  }

  if (typeof email !== "string" || !email.trim()) {
    jsonResponse(res, 400, { error: "Email is required." });
    return;
  }

  if (typeof password !== "string" || password.length < 8) {
    jsonResponse(res, 400, { error: "Password must be at least 8 characters." });
    return;
  }

  const normalizedEmail = email.trim().toLowerCase();

  try {
    let user;
    try {
      user = await admin.auth().getUserByEmail(normalizedEmail);
    } catch (error) {
      if (error.code !== "auth/user-not-found") {
        throw error;
      }

      user = await admin.auth().createUser({
        email: normalizedEmail,
        password,
        displayName:
          typeof displayName === "string" && displayName.trim()
            ? displayName.trim()
            : undefined,
        emailVerified: true,
      });
    }

    const existingClaims = user.customClaims ?? {};
    await admin.auth().setCustomUserClaims(user.uid, {
      ...existingClaims,
      admin: true,
    });

    jsonResponse(res, 200, {
      ok: true,
      uid: user.uid,
      email: normalizedEmail,
      admin: true,
    });
  } catch (error) {
    console.error("Failed to bootstrap admin user", error);
    jsonResponse(res, 500, { error: "Unable to bootstrap admin user." });
  }
});
