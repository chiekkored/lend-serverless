const functions = require("firebase-functions");
const admin = require("firebase-admin");
const crypto = require("crypto");
const dotenv = require("dotenv");
const { v4: uuidv4 } = require("uuid");
const { createSignedToken } = require("../utils/token.util");

dotenv.config();

const SECRET = process.env.QR_SECRET;
if (!SECRET) throw new Error("Missing QR_SECRET in .env");

/**
 * Cloud Function to regenerate expired or invalid QR tokens for a booking.
 * This will override the existing tokens with new ones.
 */
exports.regenerateToken = async (request) => {
  const auth = request.auth;
  const { userId, assetId, bookingId } = request.data;

  if (!auth) {
    throw new functions.https.HttpsError("permission-denied", "User must be authenticated");
  }

  if (!userId || !assetId || !bookingId) {
    throw new functions.https.HttpsError("invalid-argument", "Missing userId, assetId, or bookingId");
  }

  // Firestore references
  const userBookingRef = admin.firestore().doc(`users/${userId}/bookings/${bookingId}`);
  const assetBookingRef = admin.firestore().doc(`assets/${assetId}/bookings/${bookingId}`);
  const bookingSnap = await assetBookingRef.get();

  if (!bookingSnap.exists) {
    throw new functions.https.HttpsError("not-found", "Booking not found");
  }

  const booking = bookingSnap.data();
  const bookedDates = booking?.dates ?? [];

  if (bookedDates.length === 0) {
    throw new functions.https.HttpsError("failed-precondition", "Booking has no dates");
  }

  // Extract start and end of booking
  const firstDate = bookedDates[0].toDate ? bookedDates[0].toDate() : new Date(bookedDates[0]);
  const lastDate = bookedDates[bookedDates.length - 1].toDate
    ? bookedDates[bookedDates.length - 1].toDate()
    : new Date(bookedDates[bookedDates.length - 1]);

  const threeDaysMs = 3 * 24 * 60 * 60 * 1000;

  const handoverExpiry = new Date(lastDate.getTime());
  const returnExpiry = new Date(lastDate.getTime() + threeDaysMs);

  // Generate new UUIDs and tokens
  const newHandoverUuid = uuidv4();
  const newReturnUuid = uuidv4();

  const newHandoverToken = createSignedToken({
    bookingId,
    userId,
    assetId,
    action: "handover",
    uuid: newHandoverUuid,
    expiresAt: handoverExpiry.getTime(),
  });

  const newReturnToken = createSignedToken({
    bookingId,
    userId,
    assetId,
    action: "return",
    uuid: newReturnUuid,
    expiresAt: returnExpiry.getTime(),
  });

  // Prepare Firestore update data
  const updateData = {
    tokens: {
      handoverToken: newHandoverToken,
      returnToken: newReturnToken,
      regeneratedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
  };

  // Update both booking documents
  await Promise.all([userBookingRef.update(updateData), assetBookingRef.update(updateData)]);

  return {
    success: true,
    message: "QR tokens regenerated successfully",
    tokens: {
      handover: newHandoverToken,
      return: newReturnToken,
    },
    expiries: {
      handover: handoverExpiry.toISOString(),
      return: returnExpiry.toISOString(),
    },
  };
};
