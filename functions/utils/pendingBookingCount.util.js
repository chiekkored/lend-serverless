const { BOOKING_STATUS } = require("./booking.util");

function countPendingBookings(bookings) {
  return bookings.filter((booking) => booking?.status === BOOKING_STATUS.pending).length;
}

module.exports = {
  countPendingBookings,
};
