const FEED_TTL_MS = 60 * 60 * 1000;
const FEED_LIMIT = 36;

function normalizeLocationPart(value) {
  return typeof value === "string"
    ? value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    : "";
}

function normalizeLocationInput(location = {}) {
  const country = typeof location.country === "string" ? location.country.trim() : "";
  const locality =
    typeof location.locality === "string"
      ? location.locality.trim()
      : typeof location.cityState === "string"
        ? location.cityState.trim()
        : "";
  const lat = typeof location.lat === "number" ? location.lat : Number(location.lat);
  const lng = typeof location.lng === "number" ? location.lng : Number(location.lng);
  const countryKey = normalizeLocationPart(location.countryKey || country);
  const localityKey = normalizeLocationPart(location.localityKey || location.cityKey || locality);
  const geohash = typeof location.geohash === "string" ? location.geohash.trim() : "";

  return {
    country,
    locality,
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    geohash,
    countryKey,
    localityKey,
    cityState: locality,
    cityKey: localityKey,
  };
}

function feedId({ type, scope, location, category }) {
  const categoryKey = normalizeLocationPart(category || "all");
  if (scope === "locality" && location.localityKey) {
    return `${type}_locality:${location.countryKey}:${location.localityKey}:${categoryKey}`;
  }
  return `${type}_country:${location.countryKey}:${categoryKey}`;
}

function isFeedFresh(feed, nowMs = Date.now()) {
  const generatedAt = feed?.generatedAt?.toMillis?.() || 0;
  return generatedAt > 0 && nowMs - generatedAt < FEED_TTL_MS;
}

function toAssetPreview(doc) {
  const data = doc.data() || {};
  return {
    id: data.id || doc.id,
    ownerId: data.ownerId || null,
    title: data.title || null,
    category: data.category || null,
    rates: data.rates || null,
    images: Array.isArray(data.images) ? data.images.slice(0, 3) : [],
    location: data.location || null,
    createdAt: data.createdAt || null,
    status: data.status || null,
    isDeleted: data.isDeleted === true,
    averageRating: typeof data.averageRating === "number" ? data.averageRating : null,
    reviewCount: typeof data.reviewCount === "number" ? data.reviewCount : null,
    suppressFromRecommendations: data.suppressFromRecommendations === true,
    popularityScore: Number(data.popularityScore || 0),
    qualityScore: Number(data.qualityScore || 0),
    recommendationScore: Number(data.recommendationScore || 0),
  };
}

function scoreAsset(asset, { categoryHints = [], type }) {
  const reviewCount = Number(asset.reviewCount || 0);
  const averageRating = Number(asset.averageRating || 0);
  const qualityScore = reviewCount > 0 ? averageRating * Math.min(reviewCount, 10) : 2.5;
  const popularityScore = Number(asset.popularityScore || 0);
  const categoryBoost = categoryHints.includes(asset.category) ? 8 : 0;
  const createdAtMs = asset.createdAt?.toMillis?.() || 0;
  const ageDays = createdAtMs > 0 ? (Date.now() - createdAtMs) / 86400000 : 365;
  const freshnessBoost = Math.max(0, 4 - ageDays / 14);

  if (type === "popular") {
    return popularityScore + qualityScore + freshnessBoost;
  }

  return Number(asset.recommendationScore || 0) + qualityScore + categoryBoost + freshnessBoost;
}

function rankAndDedupe(assets, options) {
  const ownerCounts = new Map();
  return assets
    .filter(
      (asset) =>
        asset.id &&
        !asset.isDeleted &&
        asset.status === "Available" &&
        asset.suppressFromRecommendations !== true,
    )
    .map((asset) => ({ asset, score: scoreAsset(asset, options) }))
    .sort((a, b) => b.score - a.score)
    .filter(({ asset }) => {
      const ownerId = asset.ownerId || "unknown";
      const count = ownerCounts.get(ownerId) || 0;
      if (count >= 3) return false;
      ownerCounts.set(ownerId, count + 1);
      return true;
    })
    .slice(0, FEED_LIMIT)
    .map(({ asset }) => asset);
}

module.exports = {
  FEED_LIMIT,
  feedId,
  isFeedFresh,
  normalizeLocationInput,
  rankAndDedupe,
  toAssetPreview,
};
