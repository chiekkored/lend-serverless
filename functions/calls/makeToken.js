const functions = require("firebase-functions");
const admin = require("firebase-admin");
const crypto = require("crypto");
const dotenv = require("dotenv");
const { v4: uuidv4 } = require("uuid");

dotenv.config();

const SECRET = process.env.QR_SECRET;
if (!SECRET) throw new Error("Missing QR_SECRET in .env");

function createSignedToken(payload) {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64");
  const sig = crypto.createHmac("sha256", SECRET).update(payloadB64).digest("hex");
  return `${payloadB64}.${sig}`;
}

exports.makeToken = async (request) => {
  const auth = request.auth;
  const { userId, assetId, bookingId, expiresIn = 15 * 60 * 1000 } = request.data;

  if (!auth) {
    throw new functions.https.HttpsError("permission-denied", "User must be authenticated");
  }

  if (!userId || !assetId || !bookingId) {
    throw new functions.https.HttpsError("invalid-argument", "Missing userId, assetId, or bookingId");
  }

  const expiresAt = Date.now() + expiresIn;

  // Generate distinct tokens for handover & return
  const handoverUuid = uuidv4();
  const returnUuid = uuidv4();

  const handoverToken = createSignedToken({
    bookingId,
    userId,
    assetId,
    action: "handover",
    uuid: handoverUuid,
    expiresAt,
  });

  const returnToken = createSignedToken({
    bookingId,
    userId,
    assetId,
    action: "return",
    uuid: returnUuid,
    expiresAt,
  });

  // Firestore refs
  const userBookingRef = admin.firestore().doc(`users/${userId}/bookings/${bookingId}`);
  const assetBookingRef = admin.firestore().doc(`assets/${assetId}/bookings/${bookingId}`);

  // Update both documents
  const updateData = {
    tokens: {
      handover: handoverUuid,
      return: returnUuid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: admin.firestore.Timestamp.fromMillis(expiresAt),
    },
  };

  await Promise.all([userBookingRef.update(updateData), assetBookingRef.update(updateData)]);

  return {
    success: true,
    tokens: {
      handover: handoverToken,
      return: returnToken,
    },
    expiresAt,
  };
};
