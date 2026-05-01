const admin = require("firebase-admin");
const { sendSystemChatMessage } = require("../utils/chat.util"); // Import the chat utility
const { throwAndLogHttpsError } = require("../utils/error.util"); // Import the error utility
const { validateSignedQrToken } = require("../utils/token.util");
const {
  assertConfirmedBooking,
  assertCanonicalBookingRange,
  assertQrScannerAuthorized,
  CHAT_STATUS,
  getCompletionFieldForAction,
  getExpectedTokenForAction,
  getLifecycleMessageId,
  isTokenActionCompleted,
} = require("../utils/booking.util");

exports.verifyAndMark = async (request) => {
  const { token } = request.data || {};
  const auth = request.auth;

  if (!auth) {
    throwAndLogHttpsError("permission-denied", "User must be authenticated");
  }

  const { payload, payloadB64 } = validateSignedQrToken({ token });
  const { bookingId, userId, assetId, action, uuid } = payload;

  // --- Firestore references ---
  const userBookingRef = admin.firestore().doc(`users/${userId}/bookings/${bookingId}`);
  const assetBookingRef = admin.firestore().doc(`assets/${assetId}/bookings/${bookingId}`);

  let chatID = null;
  let ownerID = null;
  let alreadyCompleted = false;

  // --- Run transaction ---
  await admin.firestore().runTransaction(async (tx) => {
    const [userSnap, assetSnap] = await Promise.all([tx.get(userBookingRef), tx.get(assetBookingRef)]);

    if (!userSnap.exists || !assetSnap.exists) {
      throwAndLogHttpsError("not-found", "Booking not found");
    }

    const userBooking = userSnap.data();
    const assetBooking = assetSnap.data();
    const tokens = userBooking?.tokens || assetBooking?.tokens;

    if (!tokens) {
      throwAndLogHttpsError("not-found", "No tokens found in booking");
    }

    assertConfirmedBooking(userBooking || assetBooking);
    assertCanonicalBookingRange(userBooking);
    assertCanonicalBookingRange(assetBooking);
    assertQrScannerAuthorized({
      authUid: auth.uid,
      action,
      booking: userBooking || assetBooking,
    });

    // Retrieve chatID and ownerID for sending system message
    chatID = userBooking.chatId;
    ownerID = userBooking.asset.owner.uid;

    const expectedToken = getExpectedTokenForAction(tokens, action);
    if (!expectedToken || expectedToken !== token) {
      throwAndLogHttpsError("permission-denied", "Token mismatch or outdated QR");
    }

    const expectedPayloadB64 = expectedToken.split(".")[0];
    if (expectedPayloadB64 !== payloadB64) {
      throwAndLogHttpsError("permission-denied", "Invalid token payload");
    }

    // --- Check if already marked ---
    const fieldName = getCompletionFieldForAction(action);
    alreadyCompleted =
      isTokenActionCompleted(userBooking, action) ||
      isTokenActionCompleted(assetBooking, action);

    const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();

    if (!alreadyCompleted) {
      const updateData = {
        [fieldName]: {
          status: true,
          updatedAt: now,
          verifiedBy: auth.uid,
        },
        lastUpdated: now,
      };

      tx.update(userBookingRef, updateData);
      tx.update(assetBookingRef, updateData);
    }

    // Optional event logging (recommended for audit trail)
    const event = {
      action,
      actorId: auth.uid,
      verifiedAt: now,
      tokenUuid: uuid,
    };
    tx.set(userBookingRef.collection("events").doc(`${action}-${uuid}`), event, { merge: true });
    tx.set(assetBookingRef.collection("events").doc(`${action}-${uuid}`), event, { merge: true });
  });

  let systemMessageText = "";
  if (action === "handover") {
    systemMessageText = "Unit has been handed over!";
  } else if (action === "return") {
    systemMessageText = "Unit has been returned!";
  }

  // Send system chat message for handover/return
  if (systemMessageText) {
    await sendSystemChatMessage({
      chatId: chatID,
      ownerId: ownerID,
      renterId: userId,
      messageText: systemMessageText,
      messageType: "system", // MessageType.system for general updates
      messageId: getLifecycleMessageId(action, bookingId),
      includeLastMessage: false,
    });
  }

  // After 'return' action, send rating message to renter and archive owner's chat
  if (action === "return") {
    await sendSystemChatMessage({
      chatId: chatID,
      ownerId: ownerID,
      renterId: userId,
      messageText: "You can now rate your experience with this booking!",
      messageType: "rating",
      messageId: getLifecycleMessageId("rating-prompt", bookingId),
      includeOwner: false,
    });

    // Archive owner's chat
    const ownerUserChatRef = admin.firestore().collection("userChats").doc(ownerID).collection("chats").doc(chatID);

    await admin.firestore().runTransaction(async (tx) => {
      tx.update(ownerUserChatRef, { status: CHAT_STATUS.archived });
    });
  }

  return {
    success: true,
    alreadyCompleted,
    message: alreadyCompleted
      ? `Booking ${bookingId} was already marked as ${action}`
      : `Booking ${bookingId} successfully marked as ${action}`,
  };
};
