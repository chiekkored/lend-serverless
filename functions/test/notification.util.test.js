const test = require("node:test");
const assert = require("node:assert/strict");
const { tokenDocId, normalizePlatform, _test } = require("../utils/notification.util");

test("tokenDocId hashes tokens deterministically", () => {
  assert.equal(tokenDocId("abc"), tokenDocId("abc"));
  assert.notEqual(tokenDocId("abc"), tokenDocId("def"));
  assert.equal(tokenDocId("abc").length, 64);
});

test("normalizePlatform allows mobile platforms only", () => {
  assert.equal(normalizePlatform("android"), "android");
  assert.equal(normalizePlatform("ios"), "ios");
  assert.equal(normalizePlatform("web"), "unknown");
  assert.equal(normalizePlatform(undefined), "unknown");
});

test("stringifyData removes empty values and stringifies payload values", () => {
  assert.deepEqual(
    _test.stringifyData({
      type: "chat",
      chatId: 123,
      missing: null,
      absent: undefined,
      enabled: true,
    }),
    {
      type: "chat",
      chatId: "123",
      enabled: "true",
    },
  );
});

test("isInvalidTokenError recognizes FCM cleanup errors", () => {
  assert.equal(
    _test.isInvalidTokenError({ code: "messaging/invalid-registration-token" }),
    true,
  );
  assert.equal(
    _test.isInvalidTokenError({ code: "messaging/registration-token-not-registered" }),
    true,
  );
  assert.equal(_test.isInvalidTokenError({ code: "messaging/internal-error" }), false);
});

test("sendNotificationToUser creates an in-app notification before sending FCM", async () => {
  const writes = [];
  const sentPayloads = [];
  const deletes = [];

  function firestore() {
    return {
    collection: (name) => {
      assert.equal(name, "users");
      return {
        doc: (uid) => ({
          collection: (collectionName) => {
            if (collectionName === "notifications") {
              return {
                add: async (payload) => {
                  writes.push({ uid, payload });
                  return { id: "notification-1" };
                },
              };
            }

            assert.equal(collectionName, "fcmTokens");
            return {
              where: () => ({
                get: async () => ({
                  docs: [
                    {
                      data: () => ({ token: "token-1" }),
                      ref: { delete: async () => deletes.push("token-1") },
                    },
                  ],
                }),
              }),
            };
          },
        }),
      };
    },
  };
  }
  firestore.FieldValue = {
    serverTimestamp: () => "server-timestamp",
  };

  const adminClient = {
    firestore,
    messaging: () => ({
    sendEachForMulticast: async (payload) => {
      sentPayloads.push(payload);
      return { successCount: 1, failureCount: 0, responses: [{ success: true }] };
    },
    }),
  };

  const result = await require("../utils/notification.util").sendNotificationToUser({
      uid: "user-1",
      title: "Title",
      body: "Body",
      data: { type: "verification", status: "Approved", empty: null },
    },
    adminClient,
  );

  assert.equal(result.notificationId, "notification-1");
  assert.equal(result.successCount, 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].uid, "user-1");
  assert.deepEqual(writes[0].payload.data, {
    type: "verification",
    status: "Approved",
  });
  assert.equal(writes[0].payload.type, "verification");
  assert.deepEqual(sentPayloads[0].data, writes[0].payload.data);
  assert.deepEqual(deletes, []);
});

test("sendNotificationToUser still creates an in-app notification without FCM tokens", async () => {
  const writes = [];

  function firestore() {
    return {
    collection: () => ({
      doc: (uid) => ({
        collection: (collectionName) => {
          if (collectionName === "notifications") {
            return {
              add: async (payload) => {
                writes.push({ uid, payload });
                return { id: "notification-2" };
              },
            };
          }

          return {
            where: () => ({
              get: async () => ({ docs: [] }),
            }),
          };
        },
      }),
    }),
  };
  }
  firestore.FieldValue = {
    serverTimestamp: () => "server-timestamp",
  };

  const adminClient = {
    firestore,
  };

  const result = await require("../utils/notification.util").sendNotificationToUser({
      uid: "user-1",
      title: "Title",
      body: "Body",
    },
    adminClient,
  );

  assert.deepEqual(result, {
    successCount: 0,
    failureCount: 0,
    notificationId: "notification-2",
  });
  assert.equal(writes.length, 1);
});
