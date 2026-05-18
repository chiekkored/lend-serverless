const admin = require("firebase-admin");
const { throwAndLogHttpsError } = require("../utils/error.util");
const {
  FEED_LIMIT,
  feedId,
  isFeedFresh,
  normalizeLocationInput,
  rankAndDedupe,
  toAssetPreview,
} = require("../utils/recommendations.util");

exports.getHomeRecommendations = async (request) => {
  const auth = request.auth;
  const {
    location = {},
    categoryHints = [],
    limitPerRail = 12,
  } = request.data || {};

  if (!auth) {
    throwAndLogHttpsError("permission-denied", "User must be authenticated");
  }

  const normalizedLocation = normalizeLocationInput(location);
  if (!normalizedLocation.countryKey) {
    return {
      recommended: [],
      popular: [],
      scopeUsed: "none",
      generatedAt: null,
    };
  }

  const db = admin.firestore();
  const limit = Math.max(1, Math.min(Number(limitPerRail) || 12, 12));
  const normalizedHints = Array.isArray(categoryHints)
    ? categoryHints.filter((item) => typeof item === "string" && item.trim()).slice(0, 5)
    : [];

  const cityFeeds =
    normalizedLocation.cityKey
      ? await readScopedFeeds(db, {
          location: normalizedLocation,
          categoryHints: normalizedHints,
          scope: "city",
        })
      : null;

  const countryFeeds = await readScopedFeeds(db, {
    location: normalizedLocation,
    categoryHints: normalizedHints,
    scope: "country",
  });

  const recommended = mergeFeeds([
    cityFeeds?.recommended,
    countryFeeds.recommended,
  ]).slice(0, limit);
  const popular = mergeFeeds([
    cityFeeds?.popular,
    countryFeeds.popular,
  ]).slice(0, limit);

  return {
    recommended,
    popular,
    scopeUsed: cityFeeds && (cityFeeds.recommended.length || cityFeeds.popular.length) ? "city" : "country",
    generatedAt: admin.firestore.Timestamp.now().toMillis(),
  };
};

async function readScopedFeeds(db, { location, categoryHints, scope }) {
  const recommendedFeed = await readOrRefreshFeed(db, {
    type: "recommended",
    location,
    categoryHints,
    scope,
  });
  const popularFeed = await readOrRefreshFeed(db, {
    type: "popular",
    location,
    categoryHints: [],
    scope,
  });

  return {
    recommended: recommendedFeed,
    popular: popularFeed,
  };
}

async function readOrRefreshFeed(db, { type, location, categoryHints, scope }) {
  const id = feedId({
    type,
    scope,
    location,
    category: type === "recommended" ? categoryHints[0] : "all",
  });
  const feedRef = db.collection("recommendationFeeds").doc(id);
  const feedSnap = await feedRef.get();

  if (feedSnap.exists && isFeedFresh(feedSnap.data())) {
    const items = Array.isArray(feedSnap.data().items) ? feedSnap.data().items : [];
    return items;
  }

  const items = await buildFeed(db, { type, location, categoryHints, scope });
  await feedRef.set(
    {
      id,
      type,
      scope,
      countryKey: location.countryKey,
      cityKey: scope === "city" ? location.cityKey : null,
      categoryHints,
      items,
      generatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  return items;
}

async function buildFeed(db, { type, location, categoryHints, scope }) {
  let query = db
    .collection("assets")
    .where("isDeleted", "==", false)
    .where("status", "==", "Available")
    .where("location.country", "==", location.country);

  if (scope === "city" && location.cityState) {
    query = query.where("location.cityState", "==", location.cityState);
  }

  const snapshot = await query.orderBy("createdAt", "desc").limit(FEED_LIMIT).get();
  const assets = snapshot.docs.map(toAssetPreview);
  return rankAndDedupe(assets, { categoryHints, type });
}

function mergeFeeds(feeds) {
  const seen = new Set();
  const merged = [];

  for (const feed of feeds) {
    for (const item of feed || []) {
      if (!item?.id || seen.has(item.id)) continue;
      seen.add(item.id);
      merged.push(item);
    }
  }

  return merged;
}
