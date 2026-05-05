const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { throwAndLogHttpsError } = require("../utils/error.util");
const {
  BOOKING_STATUS,
  buildTokenUpdateData,
  assertBookingOwner,
  assertCanonicalBookingRange,
  assertPendingBooking,
  getBookingActors,
  getLifecycleMessageId,
} = require("../utils/booking.util");
const { getTaskServiceAccountEmail } = require("../utils/task.util");
const { pendingBookingCountIncrementValue } = require("../utils/pendingBookingCount.util");

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
exports.confirmBooking = async (request) => {
  const data = request.data;
  const context = { auth: request.auth };

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
      const userBookingSnap = await transaction.get(userBookingRef);

      if (!selectedSnap.exists || !userBookingSnap.exists) {
        throw new Error("Booking not found");
      }

      const booking = selectedSnap.data();
      assertBookingOwner(context.auth.uid, booking);
      assertCanonicalBookingRange(booking);
      assertPendingBooking(booking);
      const { ownerId } = getBookingActors(booking);
      const ownerAssetMirrorRef = ownerId ? db.collection("users").doc(ownerId).collection("assets").doc(assetId) : null;
      const ownerAssetMirrorSnap = ownerAssetMirrorRef ? await transaction.get(ownerAssetMirrorRef) : null;

      if (booking?.renter?.uid !== renterId) {
        throw new Error("Booking renter does not match request");
      }

      const tokenData = buildTokenUpdateData({
        bookingId,
        renterId,
        assetId,
        endDate: booking.endDate,
        existingTokens: booking.tokens,
      });

      // Confirm selected booking
      transaction.update(selectedBookingRef, {
        status: BOOKING_STATUS.confirmed,
        tokens: tokenData.tokens,
        lastUpdated: admin.firestore?.FieldValue?.serverTimestamp() || new Date(),
      });

      transaction.update(userBookingRef, {
        status: BOOKING_STATUS.confirmed,
        tokens: tokenData.tokens,
        lastUpdated: admin.firestore?.FieldValue?.serverTimestamp() || new Date(),
      });

      const now = admin.firestore?.FieldValue?.serverTimestamp() || new Date();
      const event = {
        type: "confirmed",
        actorId: context.auth.uid,
        fromStatus: BOOKING_STATUS.pending,
        toStatus: BOOKING_STATUS.confirmed,
        createdAt: now,
      };
      transaction.set(selectedBookingRef.collection("events").doc("confirmed"), event, { merge: true });
      transaction.set(userBookingRef.collection("events").doc("confirmed"), event, { merge: true });

      if (ownerId) {
        transaction.set(
          ownerAssetMirrorRef,
          {
            pendingBookingCount: pendingBookingCountIncrementValue({
              fieldValue: admin.firestore.FieldValue,
              currentValue: ownerAssetMirrorSnap.data()?.pendingBookingCount,
              delta: -1,
            }),
          },
          { merge: true },
        );
      }

      // --- SEND CONFIRMATION MESSAGE (Critical UX feature) ---
      // Notify renter that booking was confirmed
      const chatId = booking.chatId;
      if (chatId) {
        const messageId = getLifecycleMessageId("confirmed", bookingId);
        const messageRef = db.collection("chats").doc(chatId).collection("messages").doc(messageId);

        const messageText =
          "Booking Confirmed!\n\nYou may now view the complete information of the owner details by clicking the information button above.";

        transaction.set(messageRef, {
          id: messageId,
          text: messageText,
          senderId: "", // System message
          createdAt: admin.firestore?.FieldValue?.serverTimestamp() || new Date(),
          type: "system",
        });

        // Update userChats metadata with last message (for both renter and owner)
        const renterUserChatRef = db.collection("userChats").doc(renterId).collection("chats").doc(chatId);

        transaction.update(renterUserChatRef, {
          lastMessage: messageText,
          lastMessageDate: admin.firestore?.FieldValue?.serverTimestamp() || new Date(),
          lastMessageSenderId: "", // System message indicator
        });

        const ownerUserChatRef = db
          .collection("userChats")
          .doc(booking.asset?.owner?.uid)
          .collection("chats")
          .doc(chatId);

        transaction.update(ownerUserChatRef, {
          lastMessage: messageText,
          lastMessageDate: admin.firestore?.FieldValue?.serverTimestamp() || new Date(),
          lastMessageSenderId: "", // System message indicator
        });
      }

      return {
        success: true,
        confirmed: bookingId,
        startDate: booking.startDate,
        endDate: booking.endDate,
        messagesSent: !!chatId,
        tokens: tokenData.rawTokens,
        expiries: tokenData.expiries,
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
      return {
        success: true,
        message: `Booking ${bookingId} confirmed`,
        phase1: "completed",
        phase2: "enqueued",
        tokens: confirmResult.tokens,
        expiries: confirmResult.expiries,
      };
    } catch (enqueueError) {
      console.warn(
        `[confirmBooking] Failed to enqueue decline task: ${enqueueError.message}. Overlapping bookings will be declined manually or on next sync.`,
      );
      return {
        success: true,
        message: `Booking ${bookingId} confirmed`,
        phase1: "completed",
        phase2: "enqueue_failed",
        warning: enqueueError.message,
        tokens: confirmResult.tokens,
        expiries: confirmResult.expiries,
      };
    }
  } catch (error) {
    console.error(`[confirmBooking] Error: ${error.message}`);
    throwAndLogHttpsError("internal", error.message);
  }
};

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
    const url = `https://us-central1-${project}.cloudfunctions.net/declineOverlappingBookings`;
    const serviceAccountEmail = getTaskServiceAccountEmail(project);

    const parent = client.queuePath(project, location, queue);

    const task = {
      httpRequest: {
        httpMethod: "POST",
        url,
        headers: {
          "Content-Type": "application/json",
        },
        body: Buffer.from(
          JSON.stringify({
            assetId,
            selectedBookingId,
            startDate: startDate?.toMillis?.() || startDate,
            endDate: endDate?.toMillis?.() || endDate,
          }),
        ).toString("base64"),
        oidcToken: {
          serviceAccountEmail,
          audience: url,
        },
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
