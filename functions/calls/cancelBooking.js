const admin = require("firebase-admin");
const { throwAndLogHttpsError } = require("../utils/error.util");
const { BOOKING_STATUS, CHAT_STATUS, getBookingRefs, getLifecycleMessageId } = require("../utils/booking.util");
const { pendingBookingCountIncrementValue } = require("../utils/pendingBookingCount.util");

exports.cancelBooking = async (request) => {
  const auth = request.auth;
  const { assetId, bookingId, reason } = request.data || {};

  if (!auth) {
    throwAndLogHttpsError("permission-denied", "User must be authenticated");
  }

  if (!assetId || !bookingId) {
    throwAndLogHttpsError("invalid-argument", "Missing assetId or bookingId");
  }

  const cancelReason = normalizeCancelReason(reason);

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

  if (auth.uid !== renterId) {
    throwAndLogHttpsError("permission-denied", "Only the renter can cancel a pending booking");
  }

  if (booking?.status !== BOOKING_STATUS.pending) {
    throwAndLogHttpsError("failed-precondition", "Only pending bookings can be cancelled");
  }

  const userBookingRef = db.collection("users").doc(renterId).collection("bookings").doc(bookingId);
  const ownerAssetMirrorRef = db.collection("users").doc(ownerId).collection("assets").doc(assetId);
  const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();

  await db.runTransaction(async (tx) => {
    const latestAssetBookingSnap = await tx.get(assetBookingRef);
    if (!latestAssetBookingSnap.exists) {
      throwAndLogHttpsError("not-found", "Booking not found");
    }

    const latestBooking = latestAssetBookingSnap.data();
    if (latestBooking?.status !== BOOKING_STATUS.pending) {
      throwAndLogHttpsError("failed-precondition", "Only pending bookings can be cancelled");
    }

    const ownerAssetMirrorSnap = await tx.get(ownerAssetMirrorRef);
    const cancelData = {
      status: BOOKING_STATUS.cancelled,
      cancelReason,
      cancelledBy: auth.uid,
      cancelledAt: now,
      lastUpdated: now,
    };

    tx.update(assetBookingRef, {
      ...cancelData,
    });
    tx.update(userBookingRef, {
      ...cancelData,
    });

    tx.set(
      ownerAssetMirrorRef,
      {
        pendingBookingCount: pendingBookingCountIncrementValue({
          fieldValue: admin.firestore.FieldValue,
          currentValue: ownerAssetMirrorSnap.data()?.pendingBookingCount,
          delta: -1,
        }),
      },
      { merge: true },
    );

    if (chatId) {
      const renterChatRef = db.collection("userChats").doc(renterId).collection("chats").doc(chatId);
      const ownerChatRef = db.collection("userChats").doc(ownerId).collection("chats").doc(chatId);
      const messageText = `Booking cancelled: ${cancelReason}`;
      const messageId = getLifecycleMessageId("cancelled", bookingId);
      const messageRef = db.collection("chats").doc(chatId).collection("messages").doc(messageId);
      const chatUpdate = {
        bookingStatus: BOOKING_STATUS.cancelled,
        status: CHAT_STATUS.archived,
        hasRead: false,
        lastMessage: messageText,
        lastMessageDate: now,
        lastMessageSenderId: "",
        lastUpdated: now,
      };

      tx.set(messageRef, {
        id: messageId,
        text: messageText,
        senderId: "",
        createdAt: now,
        type: "system",
      });

      tx.set(
        renterChatRef,
        chatUpdate,
        { merge: true },
      );
      tx.set(
        ownerChatRef,
        chatUpdate,
        { merge: true },
      );
    }
  });

  return {
    success: true,
  };
};

function normalizeCancelReason(reason) {
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throwAndLogHttpsError("invalid-argument", "Missing cancellation reason");
  }

  const trimmed = reason.trim();
  if (trimmed.length > 120) {
    throwAndLogHttpsError("invalid-argument", "Cancellation reason is too long");
  }

  return trimmed;
}

exports._test = {
  normalizeCancelReason,
};
