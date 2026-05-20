const crypto = require("crypto");
const admin = require("firebase-admin");

function tokenDocId(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function normalizePlatform(platform) {
  return ["android", "ios"].includes(platform) ? platform : "unknown";
}

async function sendNotificationToUser({ uid, title, body, data = {} }, adminClient = admin) {
  if (!uid || !title || !body) return { successCount: 0, failureCount: 0 };

  const db = adminClient.firestore();
  const notificationData = stringifyData(data);
  const notificationRef = await db
    .collection("users")
    .doc(uid)
    .collection("notifications")
    .add({
      title,
      body,
      type: notificationData.type || "general",
      data: notificationData,
      readAt: null,
      createdAt: adminClient.firestore.FieldValue.serverTimestamp(),
    });

  const tokensSnap = await db
    .collection("users")
    .doc(uid)
    .collection("fcmTokens")
    .where("enabled", "==", true)
    .get();

  const tokenDocs = tokensSnap.docs
    .map((doc) => ({ ref: doc.ref, token: doc.data()?.token }))
    .filter((doc) => typeof doc.token === "string" && doc.token.length > 0);

  if (tokenDocs.length === 0) {
    return { successCount: 0, failureCount: 0, notificationId: notificationRef.id };
  }

  const payload = {
    tokens: tokenDocs.map((doc) => doc.token),
    notification: { title, body },
    data: notificationData,
    android: {
      priority: "high",
      notification: {
        sound: "default",
      },
    },
    apns: {
      payload: {
        aps: {
          sound: "default",
        },
      },
    },
  };

  const response = await adminClient.messaging().sendEachForMulticast(payload);
  const cleanup = [];

  response.responses.forEach((result, index) => {
    if (!result.success && isInvalidTokenError(result.error)) {
      cleanup.push(tokenDocs[index].ref.delete());
    }
  });

  if (cleanup.length > 0) {
    await Promise.allSettled(cleanup);
  }

  return {
    successCount: response.successCount,
    failureCount: response.failureCount,
    notificationId: notificationRef.id,
  };
}

function stringifyData(data) {
  return Object.fromEntries(
    Object.entries(data)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)]),
  );
}

function isInvalidTokenError(error) {
  const code = error?.code;
  return (
    code === "messaging/invalid-registration-token" ||
    code === "messaging/registration-token-not-registered"
  );
}

module.exports = {
  tokenDocId,
  normalizePlatform,
  sendNotificationToUser,
  _test: {
    stringifyData,
    isInvalidTokenError,
  },
};
