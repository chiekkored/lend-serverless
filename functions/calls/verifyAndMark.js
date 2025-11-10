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

  // --- Decode and verify token ---
  const [payloadB64, sig] = token.split(".");
  if (!payloadB64 || !sig) {
    throw new functions.https.HttpsError("invalid-argument", "Malformed token");
  }

  const expectedSig = crypto.createHmac("sha256", SECRET).update(payloadB64).digest("hex");
  if (expectedSig !== sig) {
    throw new functions.https.HttpsError("permission-denied", "Invalid token signature");
  }

  // Parse payload
  const payload = JSON.parse(Buffer.from(payloadB64, "base64").toString());
  const { bookingId, userId, assetId, action, uuid, expiresAt } = payload;

  if (!bookingId || !userId || !assetId || !action || !uuid) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid token payload");
  }

  // --- Check token expiry ---
  const now = Date.now();
  if (expiresAt && now > expiresAt) {
    throw new functions.https.HttpsError("deadline-exceeded", "QR token expired");
  }

  // --- Firestore references ---
  const userBookingRef = admin.firestore().doc(`users/${userId}/bookings/${bookingId}`);
  const assetBookingRef = admin.firestore().doc(`assets/${assetId}/bookings/${bookingId}`);

  // --- Run transaction ---
  await admin.firestore().runTransaction(async (tx) => {
    const [userSnap, assetSnap] = await Promise.all([tx.get(userBookingRef), tx.get(assetBookingRef)]);

    if (!userSnap.exists || !assetSnap.exists) {
      throw new functions.https.HttpsError("not-found", "Booking not found");
    }

    const userBooking = userSnap.data();
    const assetBooking = assetSnap.data();
    const tokens = userBooking?.tokens || assetBooking?.tokens;

    if (!tokens) {
      throw new functions.https.HttpsError("not-found", "No tokens found in booking");
    }

    // --- Validate the UUID matches ---
    if (tokens[action] !== uuid) {
      throw new functions.https.HttpsError("permission-denied", "Invalid token UUID");
    }

    // --- Check if already marked ---
    const fieldName = action === "handover" ? "handedOver" : "returned";
    const existing = userBooking?.[fieldName]?.status || assetBooking?.[fieldName]?.status;

    if (existing) {
      throw new functions.https.HttpsError("failed-precondition", `Booking already marked as ${action}`);
    }

    // --- Update both booking documents ---
    const updateData = {
      [fieldName]: {
        status: true,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        verifiedBy: auth.uid,
      },
      lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
    };

    tx.update(userBookingRef, updateData);
    tx.update(assetBookingRef, updateData);

    // Optional event logging (recommended for audit trail)
    const event = {
      action,
      actorId: auth.uid,
      verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
      tokenUuid: uuid,
    };
    tx.set(userBookingRef.collection("events").doc(), event);
    tx.set(assetBookingRef.collection("events").doc(), event);
  });

  return {
    success: true,
    message: `Booking ${bookingId} successfully marked as ${action}`,
  };
};
