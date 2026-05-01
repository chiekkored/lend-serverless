const assert = require("node:assert/strict");
const test = require("node:test");

const {
  exclusiveDayCount,
  normalizeToDay,
  addDays,
} = require("../utils/booking.util");
const { countPendingBookings } = require("../utils/pendingBookingCount.util");

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
