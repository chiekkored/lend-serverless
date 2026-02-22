const functions = require("firebase-functions");
const admin = require("firebase-admin");
const crypto = require("crypto");
const dotenv = require("dotenv");
const { throwAndLogHttpsError } = require("../utils/error.util");

dotenv.config();

const SECRET = process.env.QR_SECRET;
if (!SECRET) throw new Error("Missing QR_SECRET in .env");

/**
 * Verifies a QR token without altering any booking status.
 * - Checks token signature validity
 * - Ensures token is not expired
 * - Confirms booking exists and matches UUID
 */
exports.verifyToken = async (request) => {
  const auth = request.auth;
  const { token } = request.data;

  if (!auth) {
    throwAndLogHttpsError("permission-denied", "User must be authenticated");
  }

  if (!token) {
    throwAndLogHttpsError("invalid-argument", "Token is required");
  }

  // --- Split and verify token signature ---
  const [payloadB64, sig] = token.split(".");
  if (!payloadB64 || !sig) {
    throwAndLogHttpsError("invalid-argument", "Malformed token");
  }

  const expectedSig = crypto.createHmac("sha256", SECRET).update(payloadB64).digest("hex");
  if (expectedSig !== sig) {
    throwAndLogHttpsError("permission-denied", "Invalid token signature");
  }

  // --- Decode payload ---
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64").toString());
  } catch (e) {
    throwAndLogHttpsError("invalid-argument", "Invalid token payload", e);
  }

  const { bookingId, userId, assetId, action, uuid, expiresAt } = payload;

  if (!bookingId || !userId || !assetId || !action || !uuid) {
    throwAndLogHttpsError("invalid-argument", "Missing token fields");
  }

  // --- Check expiration ---
  const now = Date.now();
  if (expiresAt && now > expiresAt) {
    throwAndLogHttpsError("deadline-exceeded", "QR token expired");
  }

  // --- Check Firestore booking existence ---
  const assetBookingRef = admin.firestore().doc(`assets/${assetId}/bookings/${bookingId}`);
  const bookingSnap = await assetBookingRef.get();

  if (!bookingSnap.exists) {
    throwAndLogHttpsError("not-found", "Booking not found");
  }

  const booking = bookingSnap.data();

  // --- Guard conditions for already completed actions ---
  if (action === "handover" && booking.handoverAt) {
    throwAndLogHttpsError("already-exists", "Handover already completed for this booking");
  }
  if (action === "return" && booking.returnedAt) {
    throwAndLogHttpsError("already-exists", "Return already completed for this booking");
  }

  const tokens = booking?.tokens;
  if (!tokens) {
    throwAndLogHttpsError("not-found", "No tokens found in booking");
  }

  // --- Compare Token ---
  // Rename variable for clarity. This is the *full token* from Firestore.
  const expectedToken = action === "handover" ? tokens.handoverToken : action === "return" ? tokens.returnToken : null;

  if (!expectedToken) {
    throwAndLogHttpsError("invalid-argument", "Invalid token action");
  }

  // Confirm the *entire* token matches the one in the database.
  // The 'token' variable is the full token string from request.data.
  if (expectedToken !== token) {
    throwAndLogHttpsError("permission-denied", "Token mismatch or outdated QR");
  }

  // --- Return valid token info ---
  return {
    //...
    valid: true,
    message: "QR token is valid",
    data: {
      bookingId,
      userId,
      assetId,
      action,
      expiresAt,
      remainingMs: expiresAt ? expiresAt - now : null,
    },
  };
};
