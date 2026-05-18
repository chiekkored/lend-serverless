const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} = require("@firebase/rules-unit-testing");
const {
  deleteDoc,
  doc,
  getDocs,
  collection,
  getDoc,
  increment,
  setDoc,
  updateDoc,
  writeBatch,
} = require("firebase/firestore");
const {
  getBytes,
  ref,
  uploadString,
} = require("firebase/storage");

const projectId = `lend-rules-${Date.now()}`;

let testEnv;

test.before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId,
    firestore: {
      rules: fs.readFileSync(path.join(__dirname, "../../firestore.rules"), "utf8"),
    },
    storage: {
      rules: fs.readFileSync(path.join(__dirname, "../../storage.rules"), "utf8"),
    },
  });
});

test.after(async () => {
  await testEnv?.cleanup();
});

test.beforeEach(async () => {
  await testEnv.clearFirestore();
  await seedFirestore();
});

test("guests can read public assets but cannot create protected documents", async () => {
  const db = testEnv.unauthenticatedContext().firestore();

  await assertSucceeds(getDoc(doc(db, "assets/asset-1")));
  await assertSucceeds(getDocs(collection(db, "assets")));
  await assertFails(setDoc(doc(db, "assets/asset-guest"), assetData("guest")));
  await assertFails(setDoc(doc(db, "users/guest"), { uid: "guest" }));
});

test("prod startup reads are allowed for public and signed-in user data", async () => {
  const ownerDb = testEnv.authenticatedContext("owner").firestore();
  const otherDb = testEnv.authenticatedContext("other").firestore();

  await assertSucceeds(getDocs(collection(ownerDb, "assets")));
  await assertSucceeds(getDoc(doc(ownerDb, "users/owner")));
  await assertSucceeds(getDocs(collection(ownerDb, "users/owner/assets")));
  await assertSucceeds(getDocs(collection(ownerDb, "users/owner/saved")));
  await assertSucceeds(getDocs(collection(ownerDb, "users/owner/bookings")));
  await assertSucceeds(getDocs(collection(ownerDb, "userChats/owner/chats")));

  await assertFails(getDocs(collection(otherDb, "users/owner/assets")));
  await assertFails(getDocs(collection(otherDb, "users/owner/saved")));
  await assertFails(getDocs(collection(otherDb, "users/owner/bookings")));
  await assertFails(getDocs(collection(otherDb, "userChats/owner/chats")));
});

test("users can manage only their own profile, saved docs, and asset mirrors", async () => {
  const ownerDb = testEnv.authenticatedContext("owner").firestore();
  const otherDb = testEnv.authenticatedContext("other").firestore();

  await assertSucceeds(updateDoc(doc(ownerDb, "users/owner"), { firstName: "Updated" }));
  await assertFails(updateDoc(doc(otherDb, "users/owner"), { firstName: "Blocked" }));

  await assertSucceeds(setDoc(doc(ownerDb, "users/owner/saved/asset-1"), { id: "asset-1" }));
  await assertFails(setDoc(doc(otherDb, "users/owner/saved/asset-2"), { id: "asset-2" }));

  await assertSucceeds(setDoc(doc(ownerDb, "users/owner/assets/asset-2"), { id: "asset-2" }));
  await assertFails(setDoc(doc(otherDb, "users/owner/assets/asset-3"), { id: "asset-3" }));
});

test("users can create one pending verification submission atomically", async () => {
  const ownerDb = testEnv.authenticatedContext("owner").firestore();
  const otherDb = testEnv.authenticatedContext("other").firestore();

  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await updateDoc(doc(db, "users/owner"), {
      verified: "Basic",
      fullVerification: null,
      userMetadataVersion: 1,
    });
  });

  const batch = writeBatch(ownerDb);
  batch.set(doc(ownerDb, "verificationSubmissions/submission-1"), verificationSubmissionData("submission-1", "owner"));
  batch.update(doc(ownerDb, "users/owner"), {
    phone: "09171234567",
    fullVerification: verificationSummaryData("submission-1"),
    userMetadataVersion: increment(1),
  });

  await assertSucceeds(batch.commit());
  await assertFails(setDoc(
    doc(otherDb, "verificationSubmissions/submission-other"),
    verificationSubmissionData("submission-other", "owner"),
  ));
});

test("users cannot create another verification submission while pending", async () => {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await updateDoc(doc(db, "users/owner"), {
      fullVerification: verificationSummaryData("submission-existing"),
    });
  });

  const ownerDb = testEnv.authenticatedContext("owner").firestore();
  const batch = writeBatch(ownerDb);
  batch.set(doc(ownerDb, "verificationSubmissions/submission-2"), verificationSubmissionData("submission-2", "owner"));
  batch.update(doc(ownerDb, "users/owner"), {
    phone: "09176543210",
    fullVerification: verificationSummaryData("submission-2"),
    userMetadataVersion: increment(1),
  });

  await assertFails(batch.commit());
});

test("admins can review verification submissions and non-admins cannot", async () => {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, "verificationSubmissions/submission-1"), verificationSubmissionData("submission-1", "owner"));
  });

  const adminDb = testEnv.authenticatedContext("admin", {
    admin: true,
    adminType: "admin",
  }).firestore();
  const ownerDb = testEnv.authenticatedContext("owner").firestore();

  await assertSucceeds(updateDoc(doc(adminDb, "verificationSubmissions/submission-1"), {
    reviewedAt: new Date("2026-04-03T00:00:00.000Z"),
    status: "Approved",
  }));
  await assertFails(updateDoc(doc(ownerDb, "verificationSubmissions/submission-1"), {
    status: "Rejected",
  }));
});

test("asset writes are owner-scoped and booking/rating writes remain backend-only", async () => {
  const ownerDb = testEnv.authenticatedContext("owner").firestore();
  const otherDb = testEnv.authenticatedContext("other").firestore();

  await assertSucceeds(setDoc(doc(ownerDb, "assets/asset-owner-new"), assetData("owner")));
  await assertFails(setDoc(doc(ownerDb, "assets/asset-other-new"), assetData("other")));
  await assertFails(updateDoc(doc(otherDb, "assets/asset-1"), { title: "Hijacked" }));

  await assertFails(setDoc(doc(ownerDb, "assets/asset-1/bookings/booking-new"), bookingData()));
  await assertFails(updateDoc(doc(ownerDb, "assets/asset-1/bookings/booking-1"), { status: "Confirmed" }));
  await assertFails(setDoc(doc(ownerDb, "assets/asset-1/ratings/rating-new"), { rating: 5 }));
});

test("admins can update canonical assets and owner asset mirrors", async () => {
  const adminDb = testEnv.authenticatedContext("admin", {
    admin: true,
    adminType: "admin",
  }).firestore();
  const otherDb = testEnv.authenticatedContext("other").firestore();

  await assertSucceeds(updateDoc(doc(adminDb, "assets/asset-1"), { status: "Rejected" }));
  await assertSucceeds(updateDoc(doc(adminDb, "users/owner/assets/asset-1"), { status: "Rejected" }));
  await assertFails(updateDoc(doc(otherDb, "users/owner/assets/asset-1"), { status: "Rejected" }));
});

test("admins can create asset audits and non-admins cannot", async () => {
  const adminDb = testEnv.authenticatedContext("admin", {
    admin: true,
    adminType: "admin",
  }).firestore();
  const ownerDb = testEnv.authenticatedContext("owner").firestore();

  await assertSucceeds(setDoc(doc(adminDb, "assets/asset-1/audits/audit-1"), auditData("Rejected")));
  await assertSucceeds(getDoc(doc(adminDb, "assets/asset-1/audits/audit-1")));
  await assertFails(setDoc(doc(ownerDb, "assets/asset-1/audits/audit-2"), auditData("Deleted")));
  await assertFails(updateDoc(doc(adminDb, "assets/asset-1/audits/audit-1"), { notes: "Changed" }));
});

test("account feedback is backend-written and admin-readable", async () => {
  const ownerDb = testEnv.authenticatedContext("owner").firestore();
  const otherDb = testEnv.authenticatedContext("other").firestore();
  const guestDb = testEnv.unauthenticatedContext().firestore();
  const adminDb = testEnv.authenticatedContext("admin", {
    admin: true,
    adminType: "admin",
  }).firestore();

  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(
      doc(db, "accountFeedback/feedback-1"),
      accountFeedbackData("feedback-1"),
    );
  });

  await assertSucceeds(getDoc(doc(adminDb, "accountFeedback/feedback-1")));
  await assertFails(getDoc(doc(otherDb, "accountFeedback/feedback-1")));
  await assertFails(updateDoc(doc(ownerDb, "accountFeedback/feedback-1"), { reason: "Changed" }));
  await assertFails(deleteDoc(doc(ownerDb, "accountFeedback/feedback-1")));

  await assertFails(setDoc(
    doc(ownerDb, "accountFeedback/feedback-owner"),
    accountFeedbackData("feedback-owner"),
  ));
  await assertFails(setDoc(
    doc(guestDb, "accountFeedback/feedback-guest"),
    accountFeedbackData("feedback-guest"),
  ));
  await assertFails(setDoc(
    doc(ownerDb, "accountFeedback/feedback-personal"),
    {
      ...accountFeedbackData("feedback-personal"),
      uid: "owner",
      email: "owner@example.com",
    },
  ));
  await assertFails(setDoc(
    doc(ownerDb, "accountFeedback/feedback-disable-text"),
    accountFeedbackData("feedback-disable-text", {
      action: "disable",
      feedback: "This should only be accepted for delete feedback.",
    }),
  ));
});

test("admins can update booking mirrors and user chat booking summaries", async () => {
  const adminDb = testEnv.authenticatedContext("admin", {
    admin: true,
    adminType: "admin",
  }).firestore();
  const otherDb = testEnv.authenticatedContext("other").firestore();

  await assertSucceeds(updateDoc(doc(adminDb, "assets/asset-1/bookings/booking-1"), { status: "Cancelled" }));
  await assertSucceeds(updateDoc(doc(adminDb, "users/renter/bookings/booking-1"), { status: "Cancelled" }));
  await assertSucceeds(updateDoc(doc(adminDb, "userChats/owner/chats/chat-1"), { bookingStatus: "Cancelled" }));
  await assertFails(updateDoc(doc(otherDb, "assets/asset-1/bookings/booking-1"), { status: "Cancelled" }));
});

test("booking reads allow signed-in asset booking reads and limit user mirrors", async () => {
  const ownerDb = testEnv.authenticatedContext("owner").firestore();
  const renterDb = testEnv.authenticatedContext("renter").firestore();
  const otherDb = testEnv.authenticatedContext("other").firestore();

  await assertSucceeds(getDoc(doc(ownerDb, "assets/asset-1/bookings/booking-1")));
  await assertSucceeds(getDoc(doc(renterDb, "assets/asset-1/bookings/booking-1")));
  await assertSucceeds(getDoc(doc(otherDb, "assets/asset-1/bookings/booking-1")));

  await assertSucceeds(getDoc(doc(ownerDb, "users/renter/bookings/booking-1")));
  await assertSucceeds(getDoc(doc(renterDb, "users/renter/bookings/booking-1")));
  await assertFails(getDoc(doc(otherDb, "users/renter/bookings/booking-1")));
});

test("users can list only their own booking mirror collection", async () => {
  const renterDb = testEnv.authenticatedContext("renter").firestore();
  const otherDb = testEnv.authenticatedContext("other").firestore();

  await assertSucceeds(getDocs(collection(renterDb, "users/renter/bookings")));
  await assertFails(getDocs(collection(otherDb, "users/renter/bookings")));
});

test("user booking updates cannot mutate lifecycle fields", async () => {
  const renterDb = testEnv.authenticatedContext("renter").firestore();

  await assertFails(updateDoc(doc(renterDb, "users/renter/bookings/booking-1"), { status: "Confirmed" }));
  await assertFails(deleteDoc(doc(renterDb, "users/renter/bookings/booking-1")));
});

test("chat messages are limited to chat participants", async () => {
  const renterDb = testEnv.authenticatedContext("renter").firestore();
  const ownerDb = testEnv.authenticatedContext("owner").firestore();
  const otherDb = testEnv.authenticatedContext("other").firestore();
  const adminDb = testEnv.authenticatedContext("admin", {
    admin: true,
    adminType: "admin",
  }).firestore();

  await assertSucceeds(getDoc(doc(ownerDb, "chats/chat-1")));
  await assertSucceeds(getDoc(doc(adminDb, "chats/chat-1")));
  await assertSucceeds(getDocs(collection(adminDb, "chats/chat-1/messages")));
  await assertSucceeds(setDoc(doc(renterDb, "chats/chat-1/messages/message-new"), {
    id: "message-new",
    text: "Hello",
    senderId: "renter",
  }));
  await assertFails(getDoc(doc(otherDb, "chats/chat-1")));
  await assertFails(setDoc(doc(otherDb, "chats/chat-1/messages/message-blocked"), {
    id: "message-blocked",
    text: "Blocked",
    senderId: "other",
  }));
});

test("storage listing uploads are scoped to the authenticated user", async () => {
  const ownerStorage = testEnv.authenticatedContext("owner").storage();
  const otherStorage = testEnv.authenticatedContext("other").storage();
  const guestStorage = testEnv.unauthenticatedContext().storage();

  await assertSucceeds(uploadString(ref(ownerStorage, "owner/posts/images/photo.jpg"), "image"));
  await assertSucceeds(getBytes(ref(guestStorage, "owner/posts/images/photo.jpg")));
  await assertFails(uploadString(ref(otherStorage, "owner/posts/images/hijack.jpg"), "image"));
});

test("storage chat uploads are scoped to the authenticated user's path", async () => {
  const renterStorage = testEnv.authenticatedContext("renter").storage();
  const otherStorage = testEnv.authenticatedContext("other").storage();
  const guestStorage = testEnv.unauthenticatedContext().storage();

  await assertSucceeds(uploadString(ref(renterStorage, "renter/chats/chat-1/message.txt"), "hello"));
  await assertFails(uploadString(ref(otherStorage, "renter/chats/chat-1/blocked.txt"), "blocked"));
  await assertFails(getBytes(ref(guestStorage, "renter/chats/chat-1/message.txt")));
});

async function seedFirestore() {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();

    await setDoc(doc(db, "users/owner"), { uid: "owner", firstName: "Owner", verified: "Full" });
    await setDoc(doc(db, "users/renter"), { uid: "renter", firstName: "Renter", verified: "Basic" });
    await setDoc(doc(db, "users/other"), { uid: "other", firstName: "Other", verified: "None" });
    await setDoc(doc(db, "assets/asset-1"), assetData("owner"));
    await setDoc(doc(db, "users/owner/assets/asset-1"), simpleAssetData("owner"));
    await setDoc(doc(db, "assets/asset-1/bookings/booking-1"), bookingData());
    await setDoc(doc(db, "users/renter/bookings/booking-1"), bookingData());
    await setDoc(doc(db, "chats/chat-1"), { chatType: "Private" });
    await setDoc(doc(db, "chats/chat-1/messages/message-1"), {
      id: "message-1",
      text: "Booking Received!",
      senderId: "owner",
    });
    await setDoc(doc(db, "userChats/owner/chats/chat-1"), { id: "chat-1", bookingId: "booking-1" });
    await setDoc(doc(db, "userChats/renter/chats/chat-1"), { id: "chat-1", bookingId: "booking-1" });
  });
}

function assetData(ownerId) {
  return {
    id: `asset-${ownerId}`,
    ownerId,
    owner: {
      uid: ownerId,
      firstName: "Owner",
      verified: "Full",
    },
    title: "Camera",
    isDeleted: false,
    status: "Available",
  };
}

function simpleAssetData(ownerId) {
  return {
    id: "asset-1",
    owner: {
      uid: ownerId,
      firstName: "Owner",
      verified: "Full",
    },
    title: "Camera",
    isDeleted: false,
    status: "Available",
  };
}

function auditData(type) {
  return {
    type,
    notes: "Incomplete listing details",
    createdBy: {
      uid: "admin",
      name: "Admin User",
    },
    createdAt: new Date("2026-04-02T00:00:00.000Z"),
  };
}

function accountFeedbackData(id, overrides = {}) {
  return {
    id,
    action: "delete",
    reason: "No longer need Lend",
    feedback: "Optional product feedback",
    createdAt: new Date("2026-04-02T00:00:00.000Z"),
    ...overrides,
  };
}

function verificationSummaryData(submissionId) {
  return {
    status: "Pending",
    activeSubmissionId: submissionId,
    submittedAt: new Date("2026-04-02T00:00:00.000Z"),
    reviewedAt: null,
  };
}

function verificationSubmissionData(id, userId) {
  return {
    id,
    userId,
    phone: "09171234567",
    address: "Makati City",
    faceKycStatus: "Submitted",
    status: "Pending",
    submittedAt: new Date("2026-04-02T00:00:00.000Z"),
    reviewedAt: null,
  };
}

function bookingData() {
  return {
    id: "booking-1",
    chatId: "chat-1",
    asset: {
      id: "asset-1",
      owner: {
        uid: "owner",
        verified: "Full",
      },
    },
    renter: {
      uid: "renter",
      verified: "Basic",
    },
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    startDate: new Date("2026-04-10T00:00:00.000Z"),
    endDate: new Date("2026-04-12T00:00:00.000Z"),
    numDays: 2,
    totalPrice: 1000,
    status: "Pending",
    tokens: null,
  };
}

assert.ok(projectId);
