const admin = require("firebase-admin");
const { v4: uuidv4 } = require("uuid");
const { createSignedToken } = require("./token.util");
const { throwAndLogHttpsError } = require("./error.util");

const BOOKING_STATUS = {
  pending: "Pending",
  confirmed: "Confirmed",
  declined: "Declined",
  cancelled: "Cancelled",
};

const CHAT_STATUS = {
  active: "Active",
  archived: "Archived",
};

function parseFirestoreDate(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  if (value instanceof Date) return value;
  if (typeof value === "number") return new Date(value);
  return new Date(value);
}

function normalizeToDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function exclusiveDayCount(startDate, endDate) {
  const normalizedStart = normalizeToDay(startDate);
  const normalizedEnd = normalizeToDay(endDate);

  if (normalizedEnd <= normalizedStart) {
    return 0;
  }

  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  return Math.floor((normalizedEnd.getTime() - normalizedStart.getTime()) / millisecondsPerDay);
}

function addDays(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function getBookingRefs({ assetId, bookingId, renterId }) {
  return {
    assetBookingRef: admin.firestore().doc(`assets/${assetId}/bookings/${bookingId}`),
    userBookingRef: admin.firestore().doc(`users/${renterId}/bookings/${bookingId}`),
  };
}

function getBookingActors(booking) {
  return {
    ownerId: booking?.asset?.owner?.uid || null,
    renterId: booking?.renter?.uid || null,
    chatId: booking?.chatId || null,
  };
}

function assertBookingOwner(authUid, booking) {
  const { ownerId } = getBookingActors(booking);

  if (!ownerId || authUid !== ownerId) {
    throwAndLogHttpsError("permission-denied", "Only the asset owner can perform this action");
  }
}

function assertBookingParticipant(authUid, booking) {
  const { ownerId, renterId } = getBookingActors(booking);

  if (!authUid || (authUid !== ownerId && authUid !== renterId)) {
    throwAndLogHttpsError("permission-denied", "Only booking participants can perform this action");
  }
}

function assertQrScannerAuthorized({ authUid, action, booking }) {
  const { ownerId, renterId } = getBookingActors(booking);

  if (action === "handover" && authUid !== renterId) {
    throwAndLogHttpsError("permission-denied", "Only the renter can verify handover");
  }

  if (action === "return" && authUid !== ownerId) {
    throwAndLogHttpsError("permission-denied", "Only the owner can verify return");
  }
}

function assertConfirmedBooking(booking) {
  if (booking?.status !== BOOKING_STATUS.confirmed) {
    throwAndLogHttpsError("failed-precondition", "Booking must be confirmed");
  }
}

function buildTokenBundle({ bookingId, renterId, assetId, endDate }) {
  const normalizedEndDate = parseFirestoreDate(endDate);

  if (!normalizedEndDate) {
    throwAndLogHttpsError("failed-precondition", "Booking must have endDate");
  }

  const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
  const handoverExpiry = new Date(normalizedEndDate.getTime());
  const returnExpiry = new Date(normalizedEndDate.getTime() + threeDaysMs);

  const handoverToken = createSignedToken({
    bookingId,
    userId: renterId,
    assetId,
    action: "handover",
    uuid: uuidv4(),
    expiresAt: handoverExpiry.getTime(),
  });

  const returnToken = createSignedToken({
    bookingId,
    userId: renterId,
    assetId,
    action: "return",
    uuid: uuidv4(),
    expiresAt: returnExpiry.getTime(),
  });

  return {
    handoverToken,
    returnToken,
    handoverExpiry,
    returnExpiry,
  };
}

function buildTokenUpdateData({
  bookingId,
  renterId,
  assetId,
  endDate,
  existingTokens,
  markRegenerated = false,
}) {
  const bundle = buildTokenBundle({ bookingId, renterId, assetId, endDate });

  return {
    tokens: {
      handoverToken: bundle.handoverToken,
      returnToken: bundle.returnToken,
      handoverExpiry: admin.firestore.Timestamp.fromDate(bundle.handoverExpiry),
      returnExpiry: admin.firestore.Timestamp.fromDate(bundle.returnExpiry),
      createdAt: existingTokens?.createdAt || admin.firestore.FieldValue.serverTimestamp(),
      ...(markRegenerated
        ? { regeneratedAt: admin.firestore.FieldValue.serverTimestamp() }
        : {}),
    },
    rawTokens: {
      handover: bundle.handoverToken,
      return: bundle.returnToken,
    },
    expiries: {
      handover: bundle.handoverExpiry.toISOString(),
      return: bundle.returnExpiry.toISOString(),
    },
  };
}

function getExpectedTokenForAction(tokens, action) {
  if (action === "handover") return tokens?.handoverToken || null;
  if (action === "return") return tokens?.returnToken || null;
  return null;
}

function getCompletionFieldForAction(action) {
  if (action === "handover") return "handedOver";
  if (action === "return") return "returned";
  throwAndLogHttpsError("invalid-argument", "Invalid token action");
}

function assertTokenActionAvailable(booking, action) {
  const completionField = getCompletionFieldForAction(action);
  if (booking?.[completionField]?.status === true) {
    throwAndLogHttpsError("already-exists", `${action} already completed for this booking`);
  }
}

module.exports = {
  BOOKING_STATUS,
  CHAT_STATUS,
  parseFirestoreDate,
  normalizeToDay,
  exclusiveDayCount,
  addDays,
  getBookingRefs,
  getBookingActors,
  assertBookingOwner,
  assertBookingParticipant,
  assertQrScannerAuthorized,
  assertConfirmedBooking,
  buildTokenUpdateData,
  getExpectedTokenForAction,
  getCompletionFieldForAction,
  assertTokenActionAvailable,
};
