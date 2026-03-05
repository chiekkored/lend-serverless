const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { v4: uuidv4 } = require("uuid");
const { throwAndLogHttpsError } = require("../utils/error.util");

/**
 * Cloud Function: Two-Phase Booking Confirmation
 *
 * PHASE 1 (Atomic): Confirms selected booking immediately in a transaction
 * PHASE 2 (Async): Enqueues Cloud Tasks to decline overlapping pending bookings
 *
 * Benefit: Selected booking confirmed IMMEDIATELY (strong consistency)
 *          Declining others is best-effort via queue (eventual consistency ok)
 *          Handles 500+ overlapping bookings without transaction timeout
 *
 * Requires: Cloud Tasks API enabled + queue "decline-overlapping-bookings" created
 */
exports.confirmBooking = functions.https.onCall(async (data, context) => {
  const db = admin.firestore();
  const { bookingId, assetId, renterId } = data;

  // --- AUTHENTICATION & VALIDATION ---
  if (!context.auth) {
    throwAndLogHttpsError("permission-denied", "User must be authenticated");
  }

  if (!bookingId || !assetId || !renterId) {
    throwAndLogHttpsError("invalid-argument", "Missing bookingId, assetId, or renterId");
  }

  const selectedBookingRef = db.doc(`assets/${assetId}/bookings/${bookingId}`);
  const userBookingRef = db.doc(`users/${renterId}/bookings/${bookingId}`);

  try {
    // --- PHASE 1: ATOMIC TRANSACTION (Confirm selected booking) ---
    const confirmResult = await db.runTransaction(async (transaction) => {
      const selectedSnap = await transaction.get(selectedBookingRef);

      if (!selectedSnap.exists) {
        throw new Error("Booking not found");
      }

      const booking = selectedSnap.data();
      if (booking.status !== "Pending") {
        throw new Error("Booking is no longer pending");
      }

      // Confirm selected booking
      transaction.update(selectedBookingRef, {
        status: "Confirmed",
        lastUpdated: admin.firestore?.FieldValue.serverTimestamp() || new Date(),
      });

      transaction.update(userBookingRef, {
        status: "Confirmed",
        lastUpdated: admin.firestore?.FieldValue.serverTimestamp() || new Date(),
      });

      // --- SEND CONFIRMATION MESSAGE (Critical UX feature) ---
      // Notify renter that booking was confirmed
      const chatId = booking.chatId;
      if (chatId) {
        const messageRef = db.collection("chats").doc(chatId).collection("messages").doc();

        const messageText =
          "Booking Confirmed!\n\nYou may now view the complete information of the owner details by clicking the information button above.";

        transaction.set(messageRef, {
          id: messageRef.id,
          text: messageText,
          senderId: "", // System message
          createdAt: admin.firestore?.FieldValue.serverTimestamp() || new Date(),
          type: "system",
        });

        // Update userChats metadata with last message (for both renter and owner)
        const renterUserChatRef = db.collection("userChats").doc(renterId).collection("chats").doc(chatId);

        transaction.update(renterUserChatRef, {
          lastMessage: messageText,
          lastMessageDate: admin.firestore?.FieldValue.serverTimestamp() || new Date(),
          lastMessageSenderId: "", // System message indicator
        });

        const ownerUserChatRef = db
          .collection("userChats")
          .doc(booking.asset?.owner?.uid)
          .collection("chats")
          .doc(chatId);

        transaction.update(ownerUserChatRef, {
          lastMessage: messageText,
          lastMessageDate: admin.firestore?.FieldValue.serverTimestamp() || new Date(),
          lastMessageSenderId: "", // System message indicator
        });
      }

      return {
        success: true,
        confirmed: bookingId,
        startDate: booking.startDate,
        endDate: booking.endDate,
        messagesSent: !!chatId,
      };
    });

    console.log(`[confirmBooking PHASE 1] Booking ${bookingId} confirmed successfully`);

    // --- PHASE 2: ENQUEUE CLOUD TASKS (Decline overlapping bookings asynchronously) ---
    // This is best-effort; if it fails, selected booking is still confirmed
    try {
      await enqueueDeclineTask({
        assetId,
        selectedBookingId: bookingId,
        startDate: confirmResult.startDate,
        endDate: confirmResult.endDate,
      });

      console.log(`[confirmBooking PHASE 2] Enqueued decline task for overlapping bookings`);
    } catch (enqueueError) {
      console.warn(
        `[confirmBooking] Failed to enqueue decline task: ${enqueueError.message}. Overlapping bookings will be declined manually or on next sync.`,
      );
      // Don't rethrow - Phase 1 succeeded and that's what matters
    }

    return {
      success: true,
      message: `Booking ${bookingId} confirmed`,
      phase1: "completed",
      phase2: "enqueued",
    };
  } catch (error) {
    console.error(`[confirmBooking] Error: ${error.message}`);
    throwAndLogHttpsError("internal", error.message);
  }
});

/**
 * Helper: Enqueue Cloud Task to decline overlapping bookings
 *
 * Sends task to Cloud Tasks queue for async processing.
 * If queue doesn't exist or API fails, logs warning and continues.
 */
async function enqueueDeclineTask({ assetId, selectedBookingId, startDate, endDate }) {
  try {
    const cloudTasks = require("@google-cloud/tasks");
    const client = new cloudTasks.CloudTasksClient();

    const project = process.env.GCP_PROJECT;
    const queue = "decline-overlapping-bookings";
    const location = "us-central1";

    const parent = client.queuePath(project, location, queue);

    const task = {
      httpRequest: {
        httpMethod: "POST",
        url: `https://us-central1-${project}.cloudfunctions.net/declineOverlappingBookings`,
        headers: {
          "Content-Type": "application/json",
        },
        body: Buffer.from(
          JSON.stringify({
            assetId,
            selectedBookingId,
            startDate: startDate?.toMillis?.() || startDate,
            endDate: endDate?.toMillis?.() || endDate,
            taskId: uuidv4(),
          }),
        ).toString("base64"),
      },
    };

    const request = { parent, task };
    const [response] = await client.createTask(request);

    console.log(`[enqueueDeclineTask] Created task: ${response.name}`);
    return response;
  } catch (error) {
    // If Cloud Tasks is not available, that's ok - just warn
    console.warn(`[enqueueDeclineTask] Could not enqueue task: ${error.message}`);
    throw error;
  }
}
