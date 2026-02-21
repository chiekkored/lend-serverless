const functions = require("firebase-functions");
const admin = require("firebase-admin");
const crypto = require("crypto");
const dotenv = require("dotenv");
const { sendSystemChatMessage } = require("../utils/chat.util"); // Import the chat utility
const { throwAndLogHttpsError } = require("../utils/error.util"); // Import the error utility

dotenv.config();

const SECRET = process.env.QR_SECRET;
if (!SECRET) throw new Error("Missing QR_SECRET in .env");

exports.verifyAndMark = async (request) => {
  const { token } = request.data;
  const auth = request.auth;

  if (!auth) {
    throwAndLogHttpsError("permission-denied", "User must be authenticated");
  }

  if (!token) {
    throwAndLogHttpsError("invalid-argument", "Token is required");
  }

  // --- Decode and verify token ---
  const [payloadB64, sig] = token.split(".");
  if (!payloadB64 || !sig) {
    throwAndLogHttpsError("invalid-argument", "Malformed token");
  }

  // Recreate the expected signature using HMAC and compare with the provided signature
  const expectedSig = crypto.createHmac("sha256", SECRET).update(payloadB64).digest("hex");
  if (expectedSig !== sig) {
    throwAndLogHttpsError("permission-denied", "Invalid token signature");
  }

  // Parse payload
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64").toString());
  } catch (error) {
    throwAndLogHttpsError("invalid-argument", "Invalid token payload", error);
  }

  const { bookingId, userId, assetId, action, uuid, expiresAt } = payload;

  if (!bookingId || !userId || !assetId || !action || !uuid) {
    throwAndLogHttpsError("invalid-argument", "Invalid token payload");
  }

  // --- Check token expiry ---
  const now = Date.now();
  if (expiresAt && now > expiresAt) {
    throwAndLogHttpsError("deadline-exceeded", "QR token expired");
  }

  // --- Firestore references ---
  const userBookingRef = admin.firestore().doc(`users/${userId}/bookings/${bookingId}`);
  const assetBookingRef = admin.firestore().doc(`assets/${assetId}/bookings/${bookingId}`);

  let chatID = null;
  let ownerID = null;

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

    // Retrieve chatID and ownerID for sending system message
    chatID = userBooking.chatId;
    ownerID = userBooking.asset.owner.uid;

    // --- Validate the UUID matches ---
    // if (tokens[`${action}Token`].uuid !== uuid) {
    //   throwAndLogHttpsError("permission-denied", "Invalid token UUID");
    // }

    // --- Check if already marked ---
    const fieldName = action === "handover" ? "handedOver" : "returned";
    const existing = userBooking?.[fieldName]?.status || assetBooking?.[fieldName]?.status;

    if (existing) {
      throwAndLogHttpsError("failed-precondition", `Booking already marked as ${action}`);
    }

    const now = admin.firestore.FieldValue?.serverTimestamp() || new Date();

    // --- Update both booking documents ---
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

    // Optional event logging (recommended for audit trail)
    const event = {
      action,
      actorId: auth.uid,
      verifiedAt: now,
      tokenUuid: uuid,
    };
    tx.set(userBookingRef.collection("events").doc(), event);
    tx.set(assetBookingRef.collection("events").doc(), event);
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
      includeOwner: false,
    });

    // Archive owner's chat
    const ownerUserChatRef = admin.firestore().collection("userChats").doc(ownerID).collection("chats").doc(chatID);

    await admin.firestore().runTransaction(async (tx) => {
      tx.update(ownerUserChatRef, { status: "archived" }); // Ensure status string matches Flutter enum
    });
  }

  return {
    success: true,
    message: `Booking ${bookingId} successfully marked as ${action}`,
  };
};
