const functions = require("firebase-functions");
const admin = require("firebase-admin");
const dotenv = require("dotenv");
const { throwAndLogHttpsError } = require("../utils/error.util");

dotenv.config();

exports.deleteUserAccount = async (request) => {
  const auth = request.auth;
  const { uid } = request.data;

  if (!auth) {
    throwAndLogHttpsError("permission-denied", "User must be authenticated");
  }

  if (!uid) {
    throwAndLogHttpsError("invalid-argument", "Missing uid");
  }

  const requesterUid = auth.uid;

  const isSelf = requesterUid === uid;
  const isAdmin = auth.token.admin === true;

  if (!isSelf && !isAdmin) {
    throwAndLogHttpsError("permission-denied", "You are not allowed to delete this account");
  }

  // Prevent admin deleting themselves
  if (isAdmin && isSelf) {
    throwAndLogHttpsError("failed-precondition", "Admins cannot delete themselves");
  }

  try {
    const db = admin.firestore();

    // Revoke existing sessions
    await admin.auth().revokeRefreshTokens(uid);

    // Delete root assets owned by user
    const assetsSnap = await db.collection("assets").where("ownerId", "==", uid).get();

    const bulkWriter = db.bulkWriter();

    assetsSnap.docs.forEach((doc) => {
      bulkWriter.delete(doc.ref);
    });

    await bulkWriter.close();

    // Delete user document
    await db.collection("users").doc(uid).delete();

    // Delete auth account
    await admin.auth().deleteUser(uid);

    return {
      success: true,
      deletedAssets: assetsSnap.size,
      uid,
      message: "User and owned assets deleted successfully",
    };
  } catch (error) {
    console.error("Delete user error:", error);

    throwAndLogHttpsError("internal", error.message || "Failed to delete user");
  }
};
