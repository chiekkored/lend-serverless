const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { makeToken } = require("./calls/makeToken.js");
const { verifyAndMark } = require("./calls/verifyAndMark.js");
const { regenerateToken } = require("./calls/regenerateToken.js");
const { verifyToken } = require("./calls/verifyToken.js");
const { confirmBooking } = require("./calls/confirmBooking.js");
const { createBookingRequest } = require("./calls/createBookingRequest.js");
const { declineOverlappingBookings } = require("./calls/declineOverlappingBookings.js");
const { submitBookingReview } = require("./calls/submitBookingReview.js");
const { cancelBooking } = require("./calls/cancelBooking.js");
const { createAdminUser } = require("./calls/createAdminUser.js");
const { deleteAdminUser } = require("./calls/deleteAdminUser.js");
const { deleteUserAccount } = require("./calls/deleteUser.js");
const { updateAdminUser } = require("./calls/updateAdminUser.js");
const { disableUser } = require("./calls/disableUser.js");
const { syncUserMetadata } = require("./scheduled/syncUserMetadata.js");

// Initialize Firebase Admin SDK only once
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
});

// Export your HTTPS callable or REST functions
exports.makeToken = functions.https.onCall(makeToken);
exports.verifyAndMark = functions.https.onCall(verifyAndMark);
exports.regenerateToken = functions.https.onCall(regenerateToken);
exports.verifyToken = functions.https.onCall(verifyToken);
exports.confirmBooking = functions.https.onCall(confirmBooking);
exports.createBookingRequest = functions.https.onCall(createBookingRequest);
exports.submitBookingReview = functions.https.onCall(submitBookingReview);
exports.cancelBooking = functions.https.onCall(cancelBooking);
exports.createAdminUser = functions.https.onCall(createAdminUser);
exports.deleteAdminUser = functions.https.onCall(deleteAdminUser);
exports.deleteUser = functions.https.onCall(deleteUserAccount);
exports.updateAdminUser = functions.https.onCall(updateAdminUser);
exports.disableUser = functions.https.onCall(disableUser);
if (process.env.FUNCTIONS_EMULATOR === "true") {
  const { bootstrapAdminUser } = require("./calls/bootstrapAdminUser.js");
  exports.bootstrapAdminUser = functions.https.onCall(bootstrapAdminUser);
}

// Export HTTP-triggered function (for Cloud Tasks)
exports.declineOverlappingBookings = declineOverlappingBookings;

// Export scheduled functions
// exports.syncUserMetadata = syncUserMetadata;
