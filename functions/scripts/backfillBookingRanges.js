const admin = require("firebase-admin");
const {
  addDays,
  exclusiveDayCount,
  normalizeToDay,
  parseFirestoreDate,
} = require("../utils/booking.util");

const shouldWrite = process.env.RUN_BACKFILL === "true";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
}

async function main() {
  const db = admin.firestore();
  const snapshot = await db.collectionGroup("bookings").get();

  let scanned = 0;
  let skipped = 0;
  let updated = 0;

  for (const doc of snapshot.docs) {
    scanned++;
    const data = doc.data();
    const patch = buildRangePatch(data);

    if (!patch) {
      skipped++;
      continue;
    }

    updated++;
    console.log(
      `${shouldWrite ? "Updating" : "Would update"} ${doc.ref.path}: ` +
        describePatch(patch),
    );

    if (shouldWrite) {
      await doc.ref.set(patch, { merge: true });
    }
  }

  console.log(
    `Booking range backfill complete. scanned=${scanned}, ` +
      `matched=${updated}, skipped=${skipped}, dryRun=${!shouldWrite}`,
  );
}

function buildRangePatch(data) {
  const explicitStart = parseFirestoreDate(data.startDate);
  const explicitEnd = parseFirestoreDate(data.endDate);

  if (explicitStart && explicitEnd && data.numDays != null) {
    return null;
  }

  if (Array.isArray(data.dates) && data.dates.length > 0) {
    const dates = data.dates
      .map(parseFirestoreDate)
      .filter(Boolean)
      .map(normalizeToDay)
      .sort((a, b) => a.getTime() - b.getTime());

    if (dates.length === 0) {
      return null;
    }

    const startDate = dates[0];
    const endDate = addDays(dates[dates.length - 1], 1);

    return {
      startDate: admin.firestore.Timestamp.fromDate(startDate),
      endDate: admin.firestore.Timestamp.fromDate(endDate),
      numDays: dates.length,
    };
  }

  if (explicitStart && explicitEnd && data.numDays == null) {
    return {
      numDays: exclusiveDayCount(explicitStart, explicitEnd),
    };
  }

  return null;
}

function describePatch(patch) {
  const fields = [];

  if (patch.startDate) {
    fields.push(`startDate=${patch.startDate.toDate().toISOString()}`);
  }

  if (patch.endDate) {
    fields.push(`endDate=${patch.endDate.toDate().toISOString()}`);
  }

  if (patch.numDays != null) {
    fields.push(`numDays=${patch.numDays}`);
  }

  return fields.join(", ");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
