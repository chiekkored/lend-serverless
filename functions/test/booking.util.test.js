const assert = require("node:assert/strict");
const test = require("node:test");

const {
  assertTokenActionAvailable,
  exclusiveDayCount,
  getCompletionFieldForAction,
  normalizeToDay,
  addDays,
} = require("../utils/booking.util");
const { countPendingBookings } = require("../utils/pendingBookingCount.util");
const {
  createSignedToken,
  validateSignedQrToken,
} = require("../utils/token.util");

process.env.QR_SECRET = "test-secret";

test("exclusiveDayCount excludes the return boundary day", () => {
  assert.equal(
    exclusiveDayCount(
      new Date(2026, 3, 10, 16, 0),
      new Date(2026, 3, 12, 9, 0),
    ),
    2,
  );
});

test("exclusiveDayCount returns zero for same-day or reversed ranges", () => {
  assert.equal(
    exclusiveDayCount(new Date(2026, 3, 10), new Date(2026, 3, 10)),
    0,
  );
  assert.equal(
    exclusiveDayCount(new Date(2026, 3, 12), new Date(2026, 3, 10)),
    0,
  );
});

test("normalizeToDay strips time", () => {
  assert.deepEqual(
    normalizeToDay(new Date(2026, 3, 10, 16, 30)),
    new Date(2026, 3, 10),
  );
});

test("addDays advances calendar days from the normalized date parts", () => {
  assert.deepEqual(addDays(new Date(2026, 3, 30, 16, 30), 1), new Date(2026, 4, 1));
});

test("countPendingBookings only counts pending booking documents", () => {
  assert.equal(
    countPendingBookings([
      { status: "Pending" },
      { status: "Confirmed" },
      { status: "Pending" },
      { status: "Declined" },
      {},
    ]),
    2,
  );
});

test("validateSignedQrToken accepts a current signed QR payload", () => {
  const expiresAt = Date.now() + 60_000;
  const token = createSignedToken({
    bookingId: "booking-1",
    userId: "renter-1",
    assetId: "asset-1",
    action: "handover",
    uuid: "uuid-1",
    expiresAt,
  });

  const result = validateSignedQrToken({ token, nowMs: expiresAt - 1 });

  assert.equal(result.payload.bookingId, "booking-1");
  assert.equal(result.payload.action, "handover");
});

test("validateSignedQrToken rejects malformed, tampered, expired, and incomplete tokens", () => {
  assert.throws(
    () => validateSignedQrToken({ token: "not-a-token" }),
    /Malformed token/,
  );

  const expired = createSignedToken({
    bookingId: "booking-1",
    userId: "renter-1",
    assetId: "asset-1",
    action: "handover",
    uuid: "uuid-1",
    expiresAt: 1000,
  });
  assert.throws(
    () => validateSignedQrToken({ token: expired, nowMs: 1001 }),
    /QR token expired/,
  );

  const current = createSignedToken({
    bookingId: "booking-1",
    userId: "renter-1",
    assetId: "asset-1",
    action: "handover",
    uuid: "uuid-1",
    expiresAt: 2000,
  });
  assert.throws(
    () => validateSignedQrToken({ token: `${current}x`, nowMs: 1000 }),
    /Invalid token signature/,
  );

  const incomplete = createSignedToken({
    bookingId: "booking-1",
    userId: "renter-1",
    assetId: "asset-1",
    action: "handover",
  });
  assert.throws(
    () => validateSignedQrToken({ token: incomplete }),
    /Missing token fields/,
  );
});

test("token action helpers map completion fields and reject completed actions consistently", () => {
  assert.equal(getCompletionFieldForAction("handover"), "handedOver");
  assert.equal(getCompletionFieldForAction("return"), "returned");
  assert.throws(
    () => getCompletionFieldForAction("cancel"),
    /Invalid token action/,
  );

  assert.doesNotThrow(() => assertTokenActionAvailable({}, "handover"));
  assert.throws(
    () => assertTokenActionAvailable({ handedOver: { status: true } }, "handover"),
    /handover already completed/,
  );
  assert.throws(
    () => assertTokenActionAvailable({ returned: { status: true } }, "return"),
    /return already completed/,
  );
});
