const functions = require("firebase-functions");
const admin = require("firebase-admin");
const crypto = require("crypto");
const dotenv = require("dotenv");
const { throwAndLogHttpsError } = require("../utils/error.util");
const {
  assertConfirmedBooking,
  assertQrScannerAuthorized,
  getExpectedTokenForAction,
} = require("../utils/booking.util");

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
  assertConfirmedBooking(booking);
  assertQrScannerAuthorized({ authUid: auth.uid, action, booking });

  const tokens = booking?.tokens;
  if (!tokens) {
    throwAndLogHttpsError("not-found", "No tokens found in booking");
  }

  // --- Compare Token ---
  const expectedToken = getExpectedTokenForAction(tokens, action);

  if (!expectedToken) {
    throwAndLogHttpsError("invalid-argument", "Invalid token action");
  }

  // Confirm the *entire* token matches the one in the database.
  // The 'token' variable is the full token string from request.data.
  if (expectedToken !== token) {
    throwAndLogHttpsError("permission-denied", "Token mismatch or outdated QR");
  }

  const completionField = action === "handover" ? "handedOver" : "returned";
  if (booking?.[completionField]?.status === true) {
    throwAndLogHttpsError("already-exists", `${action} already completed for this booking`);
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
