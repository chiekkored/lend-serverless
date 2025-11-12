const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { makeToken } = require("./calls/makeToken.js");
const { verifyAndMark } = require("./calls/verifyAndMark.js");
const { regenerateToken } = require("./calls/regenerateToken.js");
const { verifyToken } = require("./calls/verifyToken.js");

// Initialize Firebase Admin SDK only once
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
});

// Export your HTTPS callable or REST functions
exports.makeToken = functions.https.onCall(makeToken);
exports.verifyAndMark = functions.https.onCall(verifyAndMark);
exports.regenerateToken = functions.https.onCall(regenerateToken);
exports.verifyToken = functions.https.onCall(verifyToken);
