const admin = require("firebase-admin");
const geofire = require("geofire-common");
const { throwAndLogHttpsError } = require("../utils/error.util");
const {
  FEED_LIMIT,
  candidateFeedId,
  feedId,
  isFeedFresh,
  normalizeLocationInput,
  rankPersonalizedRecommendations,
  rankAndDedupe,
  recommendationProfileRef,
  toAssetPreview,
} = require("../utils/recommendations.util");

const NEARBY_RADIUS_KM = 25;
const FALLBACK_THRESHOLD = 12;

exports.getHomeRecommended = async (request) => {
  return getHomeRail(request, "recommended");
};

exports.getHomePopular = async (request) => {
  return getHomeRail(request, "popular");
};

exports.getHomeRecommendations = async (request) => {
  const recommended = await getHomeRail(request, "recommended");
  const popular = await getHomeRail(request, "popular");

  return {
    recommended: recommended.items,
    popular: popular.items,
    scopeUsed: recommended.scopeUsed !== "none" ? recommended.scopeUsed : popular.scopeUsed,
    generatedAt: admin.firestore.Timestamp.now().toMillis(),
  };
};

async function getHomeRail(request, type) {
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
  if (!normalizedLocation.countryKey && !hasCoordinates(normalizedLocation)) {
    return {
      items: [],
      scopeUsed: "none",
      generatedAt: null,
    };
  }

  const db = admin.firestore();
  const limit = Math.max(1, Math.min(Number(limitPerRail) || 12, 12));

  if (type === "recommended") {
    return getPersonalizedRecommendedRail({
      db,
      uid: auth.uid,
      normalizedLocation,
      limit,
    });
  }

  const normalizedHints = Array.isArray(categoryHints)
    ? categoryHints.filter((item) => typeof item === "string" && item.trim()).slice(0, 5)
    : [];

  const nearbyFeed = hasCoordinates(normalizedLocation)
    ? await readNearbyFeed(db, {
        type,
        location: normalizedLocation,
        categoryHints: type === "recommended" ? normalizedHints : [],
        currentUserId: auth.uid,
      })
    : [];

  const localityFeed =
    normalizedLocation.countryKey && normalizedLocation.localityKey
      ? await readOrRefreshFeed(db, {
          type,
          location: normalizedLocation,
          categoryHints: type === "recommended" ? normalizedHints : [],
          currentUserId: auth.uid,
          scope: "locality",
        })
      : null;

  const countryFeed = normalizedLocation.countryKey
    ? await readOrRefreshFeed(db, {
        type,
        location: normalizedLocation,
        categoryHints: type === "recommended" ? normalizedHints : [],
        currentUserId: auth.uid,
        scope: "country",
      })
    : [];

  const feeds = [nearbyFeed];
  if (nearbyFeed.length < FALLBACK_THRESHOLD) {
    feeds.push(localityFeed, countryFeed);
  }

  const items = mergeFeeds(feeds).slice(0, limit);

  return {
    items,
    scopeUsed: nearbyFeed.length
      ? "nearby"
      : localityFeed && localityFeed.length
        ? "locality"
        : normalizedLocation.countryKey
          ? "country"
          : "none",
    generatedAt: admin.firestore.Timestamp.now().toMillis(),
  };
}

async function getPersonalizedRecommendedRail({ db, uid, normalizedLocation, limit }) {
  const profileSnap = await recommendationProfileRef(db, uid).get();
  if (!profileSnap.exists) {
    return {
      items: [],
      scopeUsed: "none",
      generatedAt: admin.firestore.Timestamp.now().toMillis(),
    };
  }

  const nearbyCandidates = hasCoordinates(normalizedLocation)
    ? await buildNearbyAssets(db, { location: normalizedLocation })
    : [];

  const localityCandidates =
    normalizedLocation.countryKey && normalizedLocation.localityKey
      ? await readOrRefreshCandidateFeed(db, {
          location: normalizedLocation,
          scope: "locality",
        })
      : null;

  const countryCandidates = normalizedLocation.countryKey
    ? await readOrRefreshCandidateFeed(db, {
        location: normalizedLocation,
        scope: "country",
      })
    : [];

  const feeds = [nearbyCandidates];
  if (nearbyCandidates.length < FALLBACK_THRESHOLD) {
    feeds.push(localityCandidates, countryCandidates);
  }

  const candidates = mergeFeeds(feeds);
  const items = rankPersonalizedRecommendations(candidates, profileSnap.data(), {
    currentUserId: uid,
    limit,
  });

  return {
    items,
    scopeUsed: nearbyCandidates.length
      ? "nearby"
      : localityCandidates && localityCandidates.length
        ? "locality"
        : normalizedLocation.countryKey
          ? "country"
          : "none",
    generatedAt: admin.firestore.Timestamp.now().toMillis(),
  };
}

function hasCoordinates(location) {
  return Number.isFinite(location.lat) && Number.isFinite(location.lng);
}

async function readNearbyFeed(db, { type, location, categoryHints, currentUserId }) {
  const assets = await buildNearbyAssets(db, { location });
  return rankAndDedupe(assets, { categoryHints, currentUserId, type });
}

async function readOrRefreshFeed(db, { type, location, categoryHints, currentUserId, scope }) {
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
    return rankAndDedupe(items, { categoryHints, currentUserId, type });
  }

  const items = await buildFeed(db, { type, location, categoryHints, scope });
  await feedRef.set(
    {
      id,
      type,
      scope,
      countryKey: location.countryKey,
      localityKey: scope === "locality" ? location.localityKey : null,
      categoryHints,
      items,
      generatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  return rankAndDedupe(items, { categoryHints, currentUserId, type });
}

async function readOrRefreshCandidateFeed(db, { location, scope }) {
  const id = candidateFeedId({ scope, location });
  const feedRef = db.collection("recommendationFeeds").doc(id);
  const feedSnap = await feedRef.get();

  if (feedSnap.exists && isFeedFresh(feedSnap.data())) {
    const items = Array.isArray(feedSnap.data().items) ? feedSnap.data().items : [];
    return items;
  }

  const items = await buildCandidateFeed(db, { location, scope });
  await feedRef.set(
    {
      id,
      type: "candidate",
      scope,
      countryKey: location.countryKey,
      localityKey: scope === "locality" ? location.localityKey : null,
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

  if (scope === "locality" && location.locality) {
    query = query.where("location.locality", "==", location.locality);
  }

  const snapshot = await query.orderBy("createdAt", "desc").limit(FEED_LIMIT).get();
  return snapshot.docs.map(toAssetPreview);
}

async function buildCandidateFeed(db, { location, scope }) {
  let query = db
    .collection("assets")
    .where("isDeleted", "==", false)
    .where("status", "==", "Available")
    .where("location.country", "==", location.country);

  if (scope === "locality" && location.locality) {
    query = query.where("location.locality", "==", location.locality);
  }

  const snapshot = await query.orderBy("createdAt", "desc").limit(FEED_LIMIT).get();
  return snapshot.docs
    .map(toAssetPreview)
    .filter((asset) => asset.id && !asset.isDeleted && asset.status === "Available" && asset.suppressFromRecommendations !== true);
}

async function buildNearbyAssets(db, { location }) {
  const center = [location.lat, location.lng];
  const radiusInM = NEARBY_RADIUS_KM * 1000;
  const bounds = geofire.geohashQueryBounds(center, radiusInM);
  const snapshots = await Promise.all(
    bounds.map(([start, end]) =>
      db
        .collection("assets")
        .where("isDeleted", "==", false)
        .where("status", "==", "Available")
        .orderBy("location.geohash")
        .startAt(start)
        .endAt(end)
        .get(),
    ),
  );
  const assetsById = new Map();

  for (const snapshot of snapshots) {
    for (const doc of snapshot.docs) {
      const asset = toAssetPreview(doc);
      const assetLat = Number(asset.location?.lat);
      const assetLng = Number(asset.location?.lng);
      if (!Number.isFinite(assetLat) || !Number.isFinite(assetLng)) continue;

      const distanceInKm = geofire.distanceBetween(center, [assetLat, assetLng]);
      if (distanceInKm > NEARBY_RADIUS_KM) continue;

      assetsById.set(asset.id, {
        ...asset,
        distanceFromCenterInKm: distanceInKm,
      });
    }
  }

  return [...assetsById.values()].sort(
    (a, b) => (a.distanceFromCenterInKm || 0) - (b.distanceFromCenterInKm || 0),
  );
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
