const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { makeToken } = require("./calls/makeToken.js");
const { verifyAndMark } = require("./calls/verifyAndMark.js");
const { regenerateToken } = require("./calls/regenerateToken.js");
const { verifyToken } = require("./calls/verifyToken.js");
const { confirmBooking } = require("./calls/confirmBooking.js");
const { createBookingRequest } = require("./calls/createBookingRequest.js");
const { declineOverlappingBookings } = require("./calls/declineOverlappingBookings.js");
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

// Export HTTP-triggered function (for Cloud Tasks)
exports.declineOverlappingBookings = declineOverlappingBookings;

// Export scheduled functions
// exports.syncUserMetadata = syncUserMetadata;
