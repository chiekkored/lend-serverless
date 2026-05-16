const functions = require("firebase-functions");
const admin = require("firebase-admin");
const dotenv = require("dotenv");
const { throwAndLogHttpsError } = require("../utils/error.util");

dotenv.config();

exports.disableUser = async (request) => {
  const auth = request.auth;
  const { uid, disabled = true } = request.data;

  // Must be authenticated
  if (!auth) {
    throwAndLogHttpsError("permission-denied", "User must be authenticated");
  }

  // Validate input
  if (!uid) {
    throwAndLogHttpsError("invalid-argument", "Missing uid");
  }

  const requesterUid = auth.uid;

  // Only:
  // 1. Admins
  // 2. Current logged-in user disabling themselves
  const isSelf = requesterUid === uid;
  const isAdmin = auth.token.admin === true;

  if (!isSelf && !isAdmin) {
    throwAndLogHttpsError("permission-denied", "You are not allowed to disable this account");
  }

  // Prevent admin self-disable (recommended)
  if (isAdmin && isSelf && disabled === true) {
    throwAndLogHttpsError("failed-precondition", "Admins cannot disable themselves");
  }

  try {
    // Disable / enable user
    await admin.auth().updateUser(uid, {
      disabled,
    });

    await admin.auth().revokeRefreshTokens(uid);

    await admin.firestore().collection("users").doc(uid).update({
      status: "Disabled",
    });

    return {
      success: true,
      uid,
      disabled,
      message: disabled ? "User disabled successfully" : "User enabled successfully",
    };
  } catch (error) {
    console.error("Disable user error:", error);

    throwAndLogHttpsError("internal", error.message || "Failed to update user status");
  }
};
