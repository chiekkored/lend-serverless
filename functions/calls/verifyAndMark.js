const functions = require("firebase-functions");
const admin = require("firebase-admin");
const crypto = require("crypto");
const dotenv = require("dotenv");

dotenv.config();

const SECRET = process.env.QR_SECRET;
if (!SECRET) throw new Error("Missing QR_SECRET in .env");

exports.verifyAndMark = async (request) => {
  const { token } = request.data;
  const auth = request.auth;

  if (!auth) {
    throw new functions.https.HttpsError("permission-denied", "User must be authenticated");
  }
  if (!token) {
    throw new functions.https.HttpsError("invalid-argument", "Token is required");
  }

  // Validate token structure
  const [payloadB64, sig] = token.split(".");
  if (!payloadB64 || !sig) {
    throw new functions.https.HttpsError("invalid-argument", "Malformed token");
  }

  // Verify signature
  const expectedSig = crypto.createHmac("sha256", SECRET).update(payloadB64).digest("hex");
  if (expectedSig !== sig) {
    throw new functions.https.HttpsError("permission-denied", "Invalid token signature");
  }

  // Decode payload
  const payload = JSON.parse(Buffer.from(payloadB64, "base64").toString());
  const { bookingId, userId, assetId, action, uuid, expiresAt } = payload;
  const now = Date.now();

  if (!bookingId || !userId || !assetId || !action || !uuid) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid token payload");
  }

  if (expiresAt && now > expiresAt) {
    throw new functions.https.HttpsError("deadline-exceeded", "QR token expired");
  }

  const userBookingRef = admin.firestore().doc(`users/${userId}/bookings/${bookingId}`);
  const assetBookingRef = admin.firestore().doc(`assets/${assetId}/bookings/${bookingId}`);

  await admin.firestore().runTransaction(async (tx) => {
    const [userSnap, assetSnap] = await Promise.all([tx.get(userBookingRef), tx.get(assetBookingRef)]);

    if (!userSnap.exists || !assetSnap.exists) {
      throw new functions.https.HttpsError("not-found", "Booking not found");
    }

    const userBooking = userSnap.data();
    const assetBooking = assetSnap.data();

    const tokens = userBooking?.tokens || assetBooking?.tokens;
    if (!tokens) {
      throw new functions.https.HttpsError("not-found", "Tokens not found for booking");
    }

    // Verify UUID matches the expected token
    if (tokens[action] !== uuid) {
      throw new functions.https.HttpsError("permission-denied", "Invalid token UUID");
    }

    const fieldName = action === "handover" ? "handedOver" : "returned";
    const bookingStatus = userBooking?.[fieldName]?.status;

    if (bookingStatus === true) {
      throw new functions.https.HttpsError("failed-precondition", `Item already ${action}ed`);
    }

    const updateData = {
      [fieldName]: {
        status: true,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
    };

    // Apply updates to both booking documents
    tx.update(userBookingRef, updateData);
    tx.update(assetBookingRef, updateData);
  });

  return {
    success: true,
    message: `Booking ${bookingId} marked as ${action} successful`,
  };
};
