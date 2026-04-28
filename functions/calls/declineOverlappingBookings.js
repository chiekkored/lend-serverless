const functions = require("firebase-functions");
const admin = require("firebase-admin");
const {
  BOOKING_STATUS,
  CHAT_STATUS,
  parseFirestoreDate,
  normalizeToDay,
} = require("../utils/booking.util");
const { verifyCloudTaskRequest } = require("../utils/task.util");

/**
 * Cloud Function: Decline Overlapping Bookings (Cloud Tasks Handler)
 *
 * Called asynchronously by Cloud Tasks queue when a booking is confirmed.
 * Finds all pending bookings that overlap with confirmed booking
 * and declines them with best-effort retries.
 *
 * NOTE: This is HTTP-triggered (not callable) because it's invoked by Cloud Tasks.
 * Cloud Tasks provides automatic retries with exponential backoff.
 */
exports.declineOverlappingBookings = functions.https.onRequest(async (request, response) => {
  if (request.method !== "POST") {
    return response.status(405).send("Method Not Allowed");
  }

  const db = admin.firestore();

  try {
    await verifyCloudTaskRequest(request);
  } catch (authError) {
    console.error(`[declineOverlappingBookings] Unauthorized request: ${authError.message}`);
    return response.status(401).send("Unauthorized");
  }

  let payload;
  try {
    payload = typeof request.body === "string" ? JSON.parse(request.body) : request.body;
  } catch (parseError) {
    console.error(`[declineOverlappingBookings] Failed to parse Cloud Tasks payload: ${parseError.message}`);
    return response.status(400).send("Invalid payload");
  }

  const { assetId, selectedBookingId, startDate, endDate } = payload;

  if (!assetId || !selectedBookingId || !startDate || !endDate) {
    console.error("[declineOverlappingBookings] Missing required fields");
    return response.status(400).send("Missing required fields");
  }

  try {
    console.log(
      `[declineOverlappingBookings] Processing asset=${assetId}, skipping=${selectedBookingId}`,
    );

    // Convert timestamps
    const startDateObj = normalizeToDay(parseFirestoreDate(startDate));
    const endDateObj = normalizeToDay(parseFirestoreDate(endDate));

    // Find all pending bookings that overlap with confirmed booking's date range
    const overlappingQuery = await db
      .collection("assets")
      .doc(assetId)
      .collection("bookings")
      .where("startDate", "<", admin.firestore.Timestamp.fromDate(endDateObj))
      .where("endDate", ">", admin.firestore.Timestamp.fromDate(startDateObj))
      .where("status", "==", BOOKING_STATUS.pending)
      .get();

    console.log(`[declineOverlappingBookings] Found ${overlappingQuery.docs.length} overlapping pending bookings`);

    let declinedCount = 0;
    let errorCount = 0;

    // Process each overlapping booking
    for (const doc of overlappingQuery.docs) {
      const bookingId = doc.id;
      const bookingData = doc.data();
      const renterId = bookingData.renter?.uid;

      // Skip the selected booking that was just confirmed
      if (bookingId === selectedBookingId) {
        console.log(`[declineOverlappingBookings] Skipping confirmed booking ${bookingId}`);
        continue;
      }

      try {
        await declineBooking({
          assetId,
          bookingId,
          renterId,
          chatId: bookingData.chatId,
        });
        declinedCount++;
      } catch (declineError) {
        console.error(`[declineOverlappingBookings] Failed to decline booking ${bookingId}: ${declineError.message}`);
        errorCount++;
        // Continue with next booking instead of failing entire task
      }
    }

    console.log(
      `[declineOverlappingBookings] Completed: declined=${declinedCount}, errors=${errorCount}`,
    );

    // Return 200 to mark task as successful even if some declines failed
    return response.status(200).json({
      success: true,
      declinedCount,
      errorCount,
    });
  } catch (error) {
    console.error(`[declineOverlappingBookings] Error processing task: ${error.message}`);
    // Return 500 to trigger Cloud Tasks retry
    return response.status(500).send(`Error: ${error.message}`);
  }
});

/**
 * Helper: Decline a single booking
 *
 * Updates booking status to "Declined" in both collections
 * and updates chat status to "Archived"
 */
async function declineBooking({ assetId, bookingId, renterId, chatId }) {
  const db = admin.firestore();

  return new Promise(async (resolve, reject) => {
    try {
      // Use batch write for multiple updates (non-transactional is acceptable here)
      const batch = db.batch();

      const assetBookingRef = db.doc(`assets/${assetId}/bookings/${bookingId}`);
      const userBookingRef = db.doc(`users/${renterId}/bookings/${bookingId}`);
      const chatRef = db.doc(`userChats/${renterId}/chats/${chatId}`);

      // Decline booking in asset collection
      batch.update(assetBookingRef, {
        status: BOOKING_STATUS.declined,
        lastUpdated: admin.firestore?.FieldValue?.serverTimestamp() || new Date(),
      });

      // Decline booking in user collection
      batch.update(userBookingRef, {
        status: BOOKING_STATUS.declined,
        lastUpdated: admin.firestore?.FieldValue?.serverTimestamp() || new Date(),
      });

      // Archive chat
      batch.update(chatRef, {
        status: CHAT_STATUS.archived,
        lastUpdated: admin.firestore?.FieldValue?.serverTimestamp() || new Date(),
      });

      await batch.commit();

      console.log(`[declineBooking] Declined booking ${bookingId}`);
      resolve();
    } catch (error) {
      reject(error);
    }
  });
}
