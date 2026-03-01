const functions = require("firebase-functions");
const admin = require("firebase-admin");
const crypto = require("crypto");
const dotenv = require("dotenv");
const { v4: uuidv4 } = require("uuid");
const { createSignedToken } = require("../utils/token.util");
const { throwAndLogHttpsError } = require("../utils/error.util");

dotenv.config();

const SECRET = process.env.QR_SECRET;
if (!SECRET) throw new Error("Missing QR_SECRET in .env");

exports.makeToken = async (request) => {
  const auth = request.auth;
  const { userId, assetId, bookingId } = request.data;

  if (!auth) {
    throwAndLogHttpsError("permission-denied", "User must be authenticated");
  }

  if (!userId || !assetId || !bookingId) {
    throwAndLogHttpsError("invalid-argument", "Missing userId, assetId, or bookingId");
  }

  // Firestore references
  const userBookingRef = admin.firestore().doc(`users/${userId}/bookings/${bookingId}`);
  const assetBookingRef = admin.firestore().doc(`assets/${assetId}/bookings/${bookingId}`);

  const bookingSnap = await assetBookingRef.get();

  if (!bookingSnap.exists) {
    throwAndLogHttpsError("not-found", "Booking not found");
  }

  const booking = bookingSnap.data();
  const bookedDates = booking?.dates ?? [];

  if (bookedDates.length === 0) {
    throwAndLogHttpsError("failed-precondition", "Booking has no dates");
  }

  // Get first and last booking dates
  const firstDate = bookedDates[0].toDate ? bookedDates[0].toDate() : new Date(bookedDates[0]);
  const lastDate = bookedDates[bookedDates.length - 1].toDate
    ? bookedDates[bookedDates.length - 1].toDate()
    : new Date(bookedDates[bookedDates.length - 1]);

  const threeDaysMs = 3 * 24 * 60 * 60 * 1000;

  // Calculate expiries based on booked dates + 3 days
  const handoverExpiry = new Date(lastDate.getTime());
  const returnExpiry = new Date(lastDate.getTime() + threeDaysMs);

  // Generate distinct tokens
  const handoverUuid = uuidv4();
  const returnUuid = uuidv4();

  const handoverToken = createSignedToken({
    bookingId,
    userId,
    assetId,
    action: "handover",
    uuid: handoverUuid,
    expiresAt: handoverExpiry.getTime(),
  });

  const returnToken = createSignedToken({
    bookingId,
    userId,
    assetId,
    action: "return",
    uuid: returnUuid,
    expiresAt: returnExpiry.getTime(),
  });

  // Prepare Firestore update data
  const updateData = {
    tokens: {
      handoverToken,
      returnToken,
      createdAt: admin.firestore?.FieldValue?.serverTimestamp() || new Date(),
      handoverExpiry: admin.firestore?.Timestamp?.fromDate(handoverExpiry) || handoverExpiry,
      returnExpiry: admin.firestore?.Timestamp?.fromDate(returnExpiry) || returnExpiry,
    },
  };

  // SAFE: Atomic transaction - both updates or neither
  await admin.firestore().runTransaction(async (transaction) => {
    // Verify both documents exist before updating
    const userBookingSnap = await transaction.get(userBookingRef);
    const assetBookingSnap = await transaction.get(assetBookingRef);

    if (!userBookingSnap.exists || !assetBookingSnap.exists) {
      throw new Error("Booking documents not found");
    }

    // Update both atomically
    transaction.update(userBookingRef, updateData);
    transaction.update(assetBookingRef, updateData);
  });

  return {
    success: true,
    tokens: {
      handover: handoverToken,
      return: returnToken,
    },
    expiries: {
      handover: handoverExpiry.toISOString(),
      return: returnExpiry.toISOString(),
    },
  };
};
