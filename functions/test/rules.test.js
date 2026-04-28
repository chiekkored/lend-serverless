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
  getDoc,
  setDoc,
  updateDoc,
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
  await assertFails(setDoc(doc(db, "assets/asset-guest"), assetData("guest")));
  await assertFails(setDoc(doc(db, "users/guest"), { uid: "guest" }));
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

test("booking reads are limited to renter and owner participants", async () => {
  const ownerDb = testEnv.authenticatedContext("owner").firestore();
  const renterDb = testEnv.authenticatedContext("renter").firestore();
  const otherDb = testEnv.authenticatedContext("other").firestore();

  await assertSucceeds(getDoc(doc(ownerDb, "assets/asset-1/bookings/booking-1")));
  await assertSucceeds(getDoc(doc(renterDb, "assets/asset-1/bookings/booking-1")));
  await assertFails(getDoc(doc(otherDb, "assets/asset-1/bookings/booking-1")));

  await assertSucceeds(getDoc(doc(ownerDb, "users/renter/bookings/booking-1")));
  await assertSucceeds(getDoc(doc(renterDb, "users/renter/bookings/booking-1")));
  await assertFails(getDoc(doc(otherDb, "users/renter/bookings/booking-1")));
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

  await assertSucceeds(getDoc(doc(ownerDb, "chats/chat-1")));
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

    await setDoc(doc(db, "users/owner"), { uid: "owner", firstName: "Owner" });
    await setDoc(doc(db, "users/renter"), { uid: "renter", firstName: "Renter" });
    await setDoc(doc(db, "users/other"), { uid: "other", firstName: "Other" });
    await setDoc(doc(db, "assets/asset-1"), assetData("owner"));
    await setDoc(doc(db, "assets/asset-1/bookings/booking-1"), bookingData());
    await setDoc(doc(db, "users/renter/bookings/booking-1"), bookingData());
    await setDoc(doc(db, "chats/chat-1"), { chatType: "Private" });
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
    },
    title: "Camera",
    isDeleted: false,
    status: "Available",
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
      },
    },
    renter: {
      uid: "renter",
    },
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    startDate: new Date("2026-04-10T00:00:00.000Z"),
    endDate: new Date("2026-04-12T00:00:00.000Z"),
    numDays: 2,
    totalPrice: 1000,
    status: "Pending",
    tokens: null,
    handedOver: null,
    returned: null,
    reviewed: false,
  };
}

assert.ok(projectId);
