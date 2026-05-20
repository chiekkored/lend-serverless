const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { sendNotificationToUser } = require("../utils/notification.util");

const APPROVED = "Approved";
const PENDING = "Pending";
const REJECTED = "Rejected";

function buildVerificationReviewNotification(before, after, submissionId) {
  if (!after?.userId) return null;
  if (before?.status !== PENDING) return null;
  if (![APPROVED, REJECTED].includes(after.status)) return null;

  const approved = after.status === APPROVED;

  return {
    uid: after.userId,
    title: approved ? "Verification approved" : "Verification rejected",
    body: approved
      ? "Your full verification has been approved. You can now list items on Lend."
      : "Your verification was rejected. Open Lend to review your status.",
    data: {
      type: "verification",
      submissionId,
      status: after.status,
    },
  };
}

exports.notifyVerificationReview = onDocumentUpdated(
  "verificationSubmissions/{submissionId}",
  async (event) => {
    const notification = buildVerificationReviewNotification(
      event.data?.before?.data(),
      event.data?.after?.data(),
      event.params.submissionId,
    );

    if (!notification) return null;

    await sendNotificationToUser(notification);
    return null;
  },
);

exports._test = {
  buildVerificationReviewNotification,
};
