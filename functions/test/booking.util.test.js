const assert = require("node:assert/strict");
const test = require("node:test");

const {
  assertCanonicalBookingRange,
  assertNotReturned,
  assertPendingBooking,
  assertReviewableBooking,
  assertTokenActionAvailable,
  assertTokenActionAvailableOrCompleted,
  assertTokenGenerationAllowed,
  BOOKING_STATUS,
  exclusiveDayCount,
  getLifecycleMessageId,
  getExpectedStatusForAction,
  getTargetStatusForAction,
  isTokenActionCompleted,
  normalizeToDay,
  normalizeBookingRange,
  addDays,
} = require("../utils/booking.util");
const {
  countPendingBookings,
  pendingBookingCountIncrementValue,
} = require("../utils/pendingBookingCount.util");
const {
  getDeclineOverlappingBookingsUrl,
  resolveProjectId,
} = require("../utils/task.util");
const {
  createSignedToken,
  validateSignedQrToken,
} = require("../utils/token.util");
const {
  _test: declineOverlappingBookingsTest,
} = require("../calls/declineOverlappingBookings");
const {
  _test: confirmBookingTest,
} = require("../calls/confirmBooking");
const {
  _test: cancelBookingTest,
} = require("../calls/cancelBooking");
const {
  _test: submitBookingReviewTest,
} = require("../calls/submitBookingReview");

process.env.QR_SECRET = "test-secret";

function withEnv(overrides, callback) {
  const previous = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }

  try {
    return callback();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
}

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

test("normalizeBookingRange enforces exclusive-end canonical ranges", () => {
  const range = normalizeBookingRange({
    startDate: new Date(2026, 3, 10, 16, 30),
    endDate: new Date(2026, 3, 12, 9, 15),
  });

  assert.deepEqual(range.startDate, new Date(2026, 3, 10));
  assert.deepEqual(range.endDate, new Date(2026, 3, 12));
  assert.equal(range.numDays, 2);

  assert.throws(
    () => normalizeBookingRange({
      startDate: new Date(2026, 3, 12),
      endDate: new Date(2026, 3, 10),
    }),
    /End date must be after start date/,
  );
});

test("assertCanonicalBookingRange requires startDate, endDate, and matching numDays", () => {
  assert.doesNotThrow(() => assertCanonicalBookingRange({
    startDate: new Date(2026, 3, 10),
    endDate: new Date(2026, 3, 12),
    numDays: 2,
  }));

  assert.throws(
    () => assertCanonicalBookingRange({
      startDate: new Date(2026, 3, 10),
      endDate: new Date(2026, 3, 12),
    }),
    /Booking must have startDate, endDate, and numDays/,
  );

  assert.throws(
    () => assertCanonicalBookingRange({
      startDate: new Date(2026, 3, 10),
      endDate: new Date(2026, 3, 12),
      numDays: 3,
    }),
    /Booking numDays does not match startDate\/endDate/,
  );
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

test("pendingBookingCountIncrementValue uses Firestore increment when available", () => {
  const sentinel = { type: "increment", delta: 1 };
  const fieldValue = {
    increment(delta) {
      assert.equal(delta, 1);
      return sentinel;
    },
  };

  assert.equal(
    pendingBookingCountIncrementValue({
      fieldValue,
      currentValue: 4,
      delta: 1,
    }),
    sentinel,
  );
});

test("pendingBookingCountIncrementValue falls back to current count plus delta", () => {
  assert.equal(
    pendingBookingCountIncrementValue({
      fieldValue: null,
      currentValue: 4,
      delta: 1,
    }),
    5,
  );
  assert.equal(
    pendingBookingCountIncrementValue({
      fieldValue: null,
      currentValue: 4,
      delta: -1,
    }),
    3,
  );
});

test("pendingBookingCountIncrementValue treats missing or invalid current values as zero", () => {
  for (const currentValue of [undefined, null, "4", Number.NaN, Infinity]) {
    assert.equal(
      pendingBookingCountIncrementValue({
        fieldValue: {},
        currentValue,
        delta: -1,
      }),
      -1,
    );
  }
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

test("token action helpers map status transitions and reject invalid actions consistently", () => {
  assert.equal(getExpectedStatusForAction("handover"), BOOKING_STATUS.confirmed);
  assert.equal(getTargetStatusForAction("handover"), BOOKING_STATUS.handedOver);
  assert.equal(getExpectedStatusForAction("return"), BOOKING_STATUS.handedOver);
  assert.equal(getTargetStatusForAction("return"), BOOKING_STATUS.returned);
  assert.equal(isTokenActionCompleted({ status: BOOKING_STATUS.handedOver }, "handover"), true);
  assert.equal(isTokenActionCompleted({ status: BOOKING_STATUS.returned }, "return"), true);
  assert.equal(isTokenActionCompleted({ status: BOOKING_STATUS.handedOver }, "return"), false);
  assert.throws(
    () => getTargetStatusForAction("cancel"),
    /Invalid token action/,
  );

  assert.doesNotThrow(() => assertTokenActionAvailable({ status: BOOKING_STATUS.confirmed }, "handover"));
  assert.doesNotThrow(() => assertTokenActionAvailable({ status: BOOKING_STATUS.handedOver }, "return"));
  assert.doesNotThrow(() => assertTokenActionAvailableOrCompleted({ status: BOOKING_STATUS.returned }, "return"));
  assert.throws(
    () => assertTokenActionAvailable({ status: BOOKING_STATUS.handedOver }, "handover"),
    /handover already completed/,
  );
  assert.throws(
    () => assertTokenActionAvailable({ status: BOOKING_STATUS.confirmed }, "return"),
    /Booking must be HandedOver before return/,
  );
});

test("lifecycle preconditions and message ids are deterministic", () => {
  assert.doesNotThrow(() => assertPendingBooking({ status: "Pending" }));
  assert.throws(
    () => assertPendingBooking({ status: "Confirmed" }),
    /Booking is no longer pending/,
  );

  assert.doesNotThrow(() => assertNotReturned({ status: BOOKING_STATUS.handedOver }));
  assert.throws(
    () => assertNotReturned({ status: BOOKING_STATUS.returned }),
    /Booking already returned/,
  );

  assert.doesNotThrow(() => assertReviewableBooking({ status: BOOKING_STATUS.returned }));
  assert.throws(
    () => assertReviewableBooking({ status: BOOKING_STATUS.handedOver }),
    /Booking must be returned before submitting a review/,
  );

  assert.doesNotThrow(() => assertTokenGenerationAllowed({ status: BOOKING_STATUS.confirmed }));
  assert.doesNotThrow(() => assertTokenGenerationAllowed({ status: BOOKING_STATUS.handedOver }));
  assert.throws(
    () => assertTokenGenerationAllowed({ status: BOOKING_STATUS.returned }),
    /Booking is not eligible for QR token generation/,
  );

  assert.equal(getLifecycleMessageId("confirmed", "booking-1"), "booking-confirmed-booking-1");
  assert.equal(getLifecycleMessageId("handover", "booking-1"), "booking-handover-booking-1");
  assert.equal(getLifecycleMessageId("return", "booking-1"), "booking-return-booking-1");
  assert.equal(getLifecycleMessageId("rating-prompt", "booking-1"), "booking-rating-prompt-booking-1");
});

test("decline overlap payload normalizes canonical ranges", () => {
  const payload = declineOverlappingBookingsTest.normalizeOverlapPayload({
    assetId: "asset-1",
    selectedBookingId: "booking-1",
    startDate: new Date(2026, 3, 10, 16, 30).getTime(),
    endDate: new Date(2026, 3, 12, 9, 0).getTime(),
  });

  assert.equal(payload.assetId, "asset-1");
  assert.equal(payload.selectedBookingId, "booking-1");
  assert.deepEqual(payload.range.startDate, new Date(2026, 3, 10));
  assert.deepEqual(payload.range.endDate, new Date(2026, 3, 12));
  assert.equal(payload.range.numDays, 2);

  assert.throws(
    () => declineOverlappingBookingsTest.normalizeOverlapPayload({
      assetId: "asset-1",
      selectedBookingId: "booking-1",
    }),
    /Missing required fields/,
  );
});

test("decline overlap summary classifies partial mirror failures", () => {
  const summary = declineOverlappingBookingsTest.summarizeDeclineResults([
    { bookingId: "selected", status: "skipped_selected" },
    { bookingId: "declined", status: "declined" },
    {
      bookingId: "partial",
      status: "declined_with_missing_mirrors",
      missing: ["renterChat"],
    },
    { bookingId: "failed", status: "failed" },
  ]);

  assert.deepEqual(summary, {
    declinedCount: 2,
    skippedCount: 1,
    missingMirrorCount: 1,
    errorCount: 1,
  });
});

test("confirm booking rejects active overlapping bookings", () => {
  assert.doesNotThrow(() => confirmBookingTest.assertNoActiveOverlap({ empty: true }));
  assert.throws(
    () => confirmBookingTest.assertNoActiveOverlap({ empty: false }),
    /This booking overlaps an active booking/,
  );
});

test("decline task target points to functions emulator when enabled", () => {
  withEnv(
    {
      FUNCTIONS_EMULATOR: "true",
      GCP_PROJECT: undefined,
      GCLOUD_PROJECT: "lend-54b2e",
      FIREBASE_CONFIG: undefined,
      FUNCTIONS_EMULATOR_HOST: undefined,
      FUNCTIONS_EMULATOR_PORT: undefined,
    },
    () => {
      assert.equal(resolveProjectId(), "lend-54b2e");
      assert.equal(
        getDeclineOverlappingBookingsUrl(),
        "http://127.0.0.1:5001/lend-54b2e/us-central1/declineOverlappingBookings",
      );
    },
  );
});

test("decline task target uses deployed URL outside emulator", () => {
  withEnv(
    {
      FUNCTIONS_EMULATOR: undefined,
      GCP_PROJECT: "lend-54b2e",
      GCLOUD_PROJECT: undefined,
      FIREBASE_CONFIG: undefined,
    },
    () => {
      assert.equal(
        getDeclineOverlappingBookingsUrl(),
        "https://declineoverlappingbookings-5d4s7snsja-uc.a.run.app",
      );
    },
  );
});

test("decline task omits oidc token for emulator target", () => {
  const task = confirmBookingTest.buildDeclineTask({
    assetId: "asset-1",
    selectedBookingId: "booking-1",
    startDate: 1775750400000,
    endDate: 1775923200000,
    project: "lend-54b2e",
    url: "http://127.0.0.1:5001/lend-54b2e/us-central1/declineOverlappingBookings",
    includeOidcToken: false,
  });

  assert.equal(task.httpRequest.oidcToken, undefined);
  assert.equal(
    task.httpRequest.url,
    "http://127.0.0.1:5001/lend-54b2e/us-central1/declineOverlappingBookings",
  );
  assert.deepEqual(
    JSON.parse(Buffer.from(task.httpRequest.body, "base64").toString("utf8")),
    {
      assetId: "asset-1",
      selectedBookingId: "booking-1",
      startDate: 1775750400000,
      endDate: 1775923200000,
    },
  );
});

test("decline task includes oidc token for production target", () => {
  withEnv(
    {
      TASKS_SERVICE_ACCOUNT_EMAIL: "tasks@lend-54b2e.iam.gserviceaccount.com",
    },
    () => {
      const task = confirmBookingTest.buildDeclineTask({
        assetId: "asset-1",
        selectedBookingId: "booking-1",
        startDate: 1775750400000,
        endDate: 1775923200000,
        project: "lend-54b2e",
        url: "https://declineoverlappingbookings-5d4s7snsja-uc.a.run.app",
        includeOidcToken: true,
      });

      assert.deepEqual(task.httpRequest.oidcToken, {
        serviceAccountEmail: "tasks@lend-54b2e.iam.gserviceaccount.com",
        audience: "https://declineoverlappingbookings-5d4s7snsja-uc.a.run.app",
      });
    },
  );
});

test("cancel booking reason is required and normalized", () => {
  assert.equal(cancelBookingTest.normalizeCancelReason("  Found another listing  "), "Found another listing");
  assert.throws(
    () => cancelBookingTest.normalizeCancelReason(""),
    /Missing cancellation reason/,
  );
  assert.throws(
    () => cancelBookingTest.normalizeCancelReason("x".repeat(121)),
    /Cancellation reason is too long/,
  );
});

test("review aggregate writes averageRating as a Firestore double for whole-number averages", () => {
  const write = submitBookingReviewTest.buildAssetRatingAggregateWrite(assetRef(), {
    averageRating: 5,
    reviewCount: 1,
  });

  assert.deepEqual(write.update.fields.averageRating, { doubleValue: 5 });
  assert.equal(write.update.fields.averageRating.integerValue, undefined);
  assert.deepEqual(write.update.fields.reviewCount, { integerValue: 1 });
  assert.deepEqual(write.updateMask.fieldPaths, ["averageRating", "reviewCount"]);
});

test("review aggregate writes averageRating as a Firestore double for fractional averages", () => {
  const write = submitBookingReviewTest.buildAssetRatingAggregateWrite(assetRef(), {
    averageRating: 4.5,
    reviewCount: 2,
  });

  assert.deepEqual(write.update.fields.averageRating, { doubleValue: 4.5 });
  assert.equal(write.update.fields.averageRating.integerValue, undefined);
  assert.deepEqual(write.update.fields.reviewCount, { integerValue: 2 });
});

function assetRef() {
  return {
    path: "assets/asset-1",
    formattedName: "projects/test-project/databases/(default)/documents/assets/asset-1",
  };
}
