const admin = require("firebase-admin");
const { throwAndLogHttpsError } = require("../utils/error.util");
const { BOOKING_STATUS, CHAT_STATUS, getBookingRefs } = require("../utils/booking.util");

exports.cancelBooking = async (request) => {
  const auth = request.auth;
  const { assetId, bookingId } = request.data || {};

  if (!auth) {
    throwAndLogHttpsError("permission-denied", "User must be authenticated");
  }

  if (!assetId || !bookingId) {
    throwAndLogHttpsError("invalid-argument", "Missing assetId or bookingId");
  }

  const db = admin.firestore();
  const { assetBookingRef } = getBookingRefs({ assetId, bookingId, renterId: auth.uid });
  const assetBookingSnap = await assetBookingRef.get();

  if (!assetBookingSnap.exists) {
    throwAndLogHttpsError("not-found", "Booking not found");
  }

  const booking = assetBookingSnap.data();
  const renterId = booking?.renter?.uid;
  const ownerId = booking?.asset?.owner?.uid;
  const chatId = booking?.chatId;

  if (!renterId || !ownerId) {
    throwAndLogHttpsError("failed-precondition", "Booking participants are missing");
  }

  if (auth.uid !== renterId && auth.uid !== ownerId) {
    throwAndLogHttpsError("permission-denied", "Only booking participants can cancel this booking");
  }

  const cancellableStatuses = [
    BOOKING_STATUS.pending,
    BOOKING_STATUS.confirmed,
    BOOKING_STATUS.handedOver,
    BOOKING_STATUS.returned,
  ];

  if (!cancellableStatuses.includes(booking?.status)) {
    throwAndLogHttpsError("failed-precondition", "Booking cannot be cancelled from its current status");
  }

  const userBookingRef = db.collection("users").doc(renterId).collection("bookings").doc(bookingId);
  const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();

  await db.runTransaction(async (tx) => {
    tx.update(assetBookingRef, {
      status: BOOKING_STATUS.cancelled,
      lastUpdated: now,
    });
    tx.update(userBookingRef, {
      status: BOOKING_STATUS.cancelled,
      lastUpdated: now,
    });

    if (chatId) {
      const renterChatRef = db.collection("userChats").doc(renterId).collection("chats").doc(chatId);
      const ownerChatRef = db.collection("userChats").doc(ownerId).collection("chats").doc(chatId);

      tx.set(
        renterChatRef,
        {
          bookingStatus: BOOKING_STATUS.cancelled,
          ...(auth.uid === renterId ? { status: CHAT_STATUS.archived } : {}),
        },
        { merge: true },
      );
      tx.set(
        ownerChatRef,
        {
          bookingStatus: BOOKING_STATUS.cancelled,
          ...(auth.uid === ownerId ? { status: CHAT_STATUS.archived } : {}),
        },
        { merge: true },
      );
    }
  });

  return {
    success: true,
  };
};
