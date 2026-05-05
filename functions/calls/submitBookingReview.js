const admin = require("firebase-admin");
const { throwAndLogHttpsError } = require("../utils/error.util");
const {
  BOOKING_STATUS,
  CHAT_STATUS,
  assertReviewableBooking,
  getBookingRefs,
} = require("../utils/booking.util");

exports.submitBookingReview = async (request) => {
  const auth = request.auth;
  const { bookingId, assetId, chatId, rating, review } = request.data || {};

  if (!auth) {
    throwAndLogHttpsError("permission-denied", "User must be authenticated");
  }

  if (!bookingId || !assetId || !chatId || rating == null || review == null) {
    throwAndLogHttpsError("invalid-argument", "Missing bookingId, assetId, chatId, rating, or review");
  }

  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throwAndLogHttpsError("invalid-argument", "Rating must be between 1 and 5");
  }

  if (typeof review !== "string") {
    throwAndLogHttpsError("invalid-argument", "Review must be a string");
  }

  const renterId = auth.uid;
  const trimmedReview = review.trim();
  const db = admin.firestore();
  const assetRef = db.collection("assets").doc(assetId);
  const assetRatingRef = assetRef.collection("ratings").doc(bookingId);
  const renterUserChatRef = db.collection("userChats").doc(renterId).collection("chats").doc(chatId);
  const { assetBookingRef, userBookingRef } = getBookingRefs({ assetId, bookingId, renterId });

  await db.runTransaction(async (transaction) => {
    const [assetSnap, ratingSnap, userBookingSnap, assetBookingSnap] = await Promise.all([
      transaction.get(assetRef),
      transaction.get(assetRatingRef),
      transaction.get(userBookingRef),
      transaction.get(assetBookingRef),
    ]);

    if (!assetSnap.exists) {
      throwAndLogHttpsError("not-found", "Asset not found");
    }

    if (!userBookingSnap.exists || !assetBookingSnap.exists) {
      throwAndLogHttpsError("not-found", "Booking not found");
    }

    const assetData = assetSnap.data() || {};
    const userBooking = userBookingSnap.data() || {};
    const assetBooking = assetBookingSnap.data() || {};
    const booking = userBookingSnap.data() || assetBookingSnap.data() || {};

    if (booking?.renter?.uid !== renterId) {
      throwAndLogHttpsError("permission-denied", "Only the renter can submit a review");
    }

    if (booking?.asset?.id !== assetId || booking?.chatId !== chatId) {
      throwAndLogHttpsError("failed-precondition", "Booking context does not match the selected chat or asset");
    }

    assertReviewableBooking(userBooking);
    assertReviewableBooking(assetBooking);

    if (ratingSnap.exists) {
      throwAndLogHttpsError("already-exists", "You have already reviewed this booking.");
    }

    const currentAverage = Number(assetData.averageRating || 0);
    const currentCount = Number(assetData.reviewCount || 0);
    const newCount = currentCount + 1;
    const newAverage = (currentAverage * currentCount + rating) / newCount;
    const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();

    transaction.set(assetRatingRef, {
      rating,
      review: trimmedReview,
      userId: renterId,
      timestamp: now,
    });

    transaction.update(assetRef, {
      averageRating: newAverage,
      reviewCount: newCount,
    });

    transaction.update(userBookingRef, {
      status: BOOKING_STATUS.completed,
      lastUpdated: now,
    });

    transaction.update(assetBookingRef, {
      status: BOOKING_STATUS.completed,
      lastUpdated: now,
    });

    const event = {
      type: "review-submitted",
      actorId: renterId,
      fromStatus: BOOKING_STATUS.returned,
      toStatus: BOOKING_STATUS.completed,
      createdAt: now,
    };
    transaction.set(userBookingRef.collection("events").doc("review-submitted"), event, { merge: true });
    transaction.set(assetBookingRef.collection("events").doc("review-submitted"), event, { merge: true });

    transaction.set(
      renterUserChatRef,
      {
        status: CHAT_STATUS.archived,
      },
      { merge: true },
    );
  });

  const ratingMessagesSnap = await db
    .collection("chats")
    .doc(chatId)
    .collection("messages")
    .where("type", "==", "rating")
    .where("senderId", "==", "")
    .get();

  if (!ratingMessagesSnap.empty) {
    const batch = db.batch();
    for (const doc of ratingMessagesSnap.docs) {
      batch.delete(doc.ref);
    }
    await batch.commit();
  }

  return {
    success: true,
    message: "Review submitted successfully",
  };
};
