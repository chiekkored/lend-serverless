const admin = require("firebase-admin");
const { throwAndLogHttpsError } = require("../utils/error.util");
const {
  BOOKING_STATUS,
  CHAT_STATUS,
  parseFirestoreDate,
  normalizeToDay,
  exclusiveDayCount,
} = require("../utils/booking.util");

exports.createBookingRequest = async (request) => {
  const auth = request.auth;
  const { assetId, startDateMs, endDateMs, totalPrice } = request.data || {};

  if (!auth) {
    throwAndLogHttpsError("permission-denied", "User must be authenticated");
  }

  if (!assetId || startDateMs == null || endDateMs == null || totalPrice == null) {
    throwAndLogHttpsError("invalid-argument", "Missing assetId, startDateMs, endDateMs, or totalPrice");
  }

  const renterId = auth.uid;
  const startDate = parseFirestoreDate(startDateMs);
  const endDate = parseFirestoreDate(endDateMs);

  if (!(startDate instanceof Date) || Number.isNaN(startDate.getTime())) {
    throwAndLogHttpsError("invalid-argument", "Invalid startDateMs");
  }

  if (!(endDate instanceof Date) || Number.isNaN(endDate.getTime())) {
    throwAndLogHttpsError("invalid-argument", "Invalid endDateMs");
  }

  const normalizedStart = normalizeToDay(startDate);
  const normalizedEnd = normalizeToDay(endDate);

  const numDays = exclusiveDayCount(normalizedStart, normalizedEnd);
  if (numDays < 1) {
    throwAndLogHttpsError("invalid-argument", "End date must be after start date");
  }

  if (typeof totalPrice !== "number" || totalPrice <= 0) {
    throwAndLogHttpsError("invalid-argument", "Invalid totalPrice");
  }

  const db = admin.firestore();
  const assetRef = db.collection("assets").doc(assetId);
  const renterRef = db.collection("users").doc(renterId);

  const [assetSnap, renterSnap] = await Promise.all([assetRef.get(), renterRef.get()]);

  if (!assetSnap.exists) {
    throwAndLogHttpsError("not-found", "Asset not found");
  }

  if (!renterSnap.exists) {
    throwAndLogHttpsError("not-found", "Renter not found");
  }

  const asset = assetSnap.data();
  const renter = renterSnap.data();

  if (!asset || asset.isDeleted === true) {
    throwAndLogHttpsError("failed-precondition", "Asset is unavailable");
  }

  if (!asset.ownerId || !asset.owner) {
    throwAndLogHttpsError("failed-precondition", "Asset owner is missing");
  }

  if (asset.ownerId === renterId) {
    throwAndLogHttpsError("failed-precondition", "Owner cannot book their own asset");
  }

  const overlapSnap = await db
    .collection("assets")
    .doc(assetId)
    .collection("bookings")
    .where("startDate", "<", admin.firestore.Timestamp.fromDate(normalizedEnd))
    .where("endDate", ">", admin.firestore.Timestamp.fromDate(normalizedStart))
    .where("status", "==", BOOKING_STATUS.confirmed)
    .limit(1)
    .get();

  if (!overlapSnap.empty) {
    throwAndLogHttpsError("already-exists", "Asset is unavailable for the selected dates");
  }

  const bookingRef = db.collection("users").doc(renterId).collection("bookings").doc();
  const assetBookingRef = db.collection("assets").doc(assetId).collection("bookings").doc(bookingRef.id);
  const chatRef = db.collection("chats").doc();
  const messageRef = chatRef.collection("messages").doc();
  const renterUserChatRootRef = db.collection("userChats").doc(renterId);
  const renterUserChatRef = renterUserChatRootRef.collection("chats").doc(chatRef.id);
  const ownerUserChatRootRef = db.collection("userChats").doc(asset.ownerId);
  const ownerUserChatRef = ownerUserChatRootRef.collection("chats").doc(chatRef.id);

  const renterSnapshot = toSimpleUser(renter, renterId);
  const assetSnapshot = toSimpleAsset(asset, assetId);
  const bookingText = "Booking Received!";

  const bookingPayload = {
    id: bookingRef.id,
    chatId: chatRef.id,
    asset: assetSnapshot,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    startDate: admin.firestore.Timestamp.fromDate(normalizedStart),
    endDate: admin.firestore.Timestamp.fromDate(normalizedEnd),
    numDays,
    payment: null,
    renter: renterSnapshot,
    status: BOOKING_STATUS.pending,
    totalPrice,
  };

  const chatPayload = {
    id: chatRef.id,
    chatId: chatRef.id,
    bookingId: bookingRef.id,
    renterId,
    asset: assetSnapshot,
    participants: [asset.owner, renterSnapshot],
    lastMessage: bookingText,
    lastMessageDate: admin.firestore.FieldValue.serverTimestamp(),
    lastMessageSenderId: renterId,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    hasRead: false,
    status: CHAT_STATUS.active,
  };

  await db.runTransaction(async (transaction) => {
    transaction.set(bookingRef, bookingPayload);
    transaction.set(assetBookingRef, bookingPayload);
    transaction.set(chatRef, { chatType: "Private" });
    transaction.set(messageRef, {
      id: messageRef.id,
      text: bookingText,
      senderId: renterId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      type: "Text",
    });
    transaction.set(renterUserChatRootRef, { isOnline: true }, { merge: true });
    transaction.set(ownerUserChatRootRef, { isOnline: true }, { merge: true });
    transaction.set(renterUserChatRef, chatPayload);
    transaction.set(ownerUserChatRef, chatPayload);
  });

  return {
    success: true,
    bookingId: bookingRef.id,
    chatId: chatRef.id,
    message: "Booking request created",
  };
};

function toSimpleUser(user, uid) {
  return {
    uid,
    firstName: user.firstName || null,
    lastName: user.lastName || null,
    photoUrl: user.photoUrl || null,
    userMetadataVersion: user.userMetadataVersion || 1,
  };
}

function toSimpleAsset(asset, assetId) {
  return {
    id: assetId,
    owner: asset.owner || null,
    title: asset.title || null,
    images: asset.images || [],
    category: asset.category || null,
    createdAt: asset.createdAt || null,
    status: asset.status || null,
    location: asset.location || null,
    isDeleted: asset.isDeleted === true,
  };
}
