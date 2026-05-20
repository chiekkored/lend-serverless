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
