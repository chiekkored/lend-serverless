const { adminFieldValue, normalizeLocationPart } = require("./feedAlgorithm.util");

function normalizeCategoryKey(category) {
  return normalizeLocationPart(category || "");
}

function recommendationProfileRef(db, uid) {
  return db.collection("users").doc(uid).collection("recommendationProfile").doc("current");
}

function updateRecommendationProfile(transaction, db, { uid, asset, weight, signalType }) {
  if (!uid || !asset?.id) return;

  const categoryKey = normalizeCategoryKey(asset.category);
  if (!categoryKey) return;

  const profileRef = recommendationProfileRef(db, uid);
  const increment = adminFieldValue().increment(weight);
  const now = adminFieldValue().serverTimestamp();

  transaction.set(
    profileRef,
    {
      [`categoryWeights.${categoryKey}`]: increment,
      [`categoryLabels.${categoryKey}`]: asset.category,
      [`signals.${signalType}`]: adminFieldValue().increment(1),
      recentAssetIds: adminFieldValue().arrayUnion(asset.id),
      lastUpdated: now,
    },
    { merge: true },
  );
}

/**
 * Scores the personalized Recommended rail from the user's recommendation
 * profile. A category must have positive user affinity to qualify. The final
 * score combines:
 *   categoryAffinity * 10
 *   + marketplace recommendationScore * 0.5
 *   + qualityScore * 0.2
 *   + freshnessBoost
 *
 * Filtering before scoring is intentional: own assets, deleted/unavailable
 * assets, and suppressed assets must never enter the rail. The owner cap keeps
 * one lender from dominating a user's home feed.
 *
 * Simple version for Recommended:
 * - First, the user's profile categoryWeights says which categories they care
 *   about.
 * - If an asset's category has no positive user weight, it gets score 0 and is
 *   not shown.
 * - If the category matches, the category weight is the biggest score piece.
 * - recommendationScore is used as marketplaceScore and multiplied by 0.5.
 * - qualityScore is multiplied by 0.2.
 * - Freshness is a small tie-breaker.
 * - categoryBoost is not used here; personalized category affinity comes from
 *   categoryWeights instead.
 */
function rankPersonalizedRecommendations(assets, profile, { limit = 12, currentUserId } = {}) {
  const categoryWeights = profile?.categoryWeights || {};
  const hasProfileSignal = Object.values(categoryWeights).some((value) => Number(value || 0) > 0);
  if (!hasProfileSignal) return [];

  const ownerCounts = new Map();
  return assets
    .filter(
      (asset) =>
        asset.id &&
        asset.ownerId !== currentUserId &&
        !asset.isDeleted &&
        asset.status === "Available" &&
        asset.suppressFromRecommendations !== true,
    )
    .map((asset) => ({
      asset,
      score: scorePersonalizedAsset(asset, categoryWeights),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .filter(({ asset }) => {
      const ownerId = asset.ownerId || "unknown";
      const count = ownerCounts.get(ownerId) || 0;
      if (count >= 3) return false;
      ownerCounts.set(ownerId, count + 1);
      return true;
    })
    .slice(0, Math.max(1, Math.min(Number(limit) || 12, 12)))
    .map(({ asset }) => asset);
}

function scorePersonalizedAsset(asset, categoryWeights) {
  const categoryAffinity = Number(categoryWeights[normalizeCategoryKey(asset.category)] || 0);
  if (categoryAffinity <= 0) return 0;

  const reviewCount = Number(asset.reviewCount || 0);
  const averageRating = Number(asset.averageRating || 0);
  const qualityScore =
    Number(asset.qualityScore || 0) || (reviewCount > 0 ? averageRating * Math.min(reviewCount, 10) : 0);
  const marketplaceScore = Math.max(0, Number(asset.recommendationScore || 0));
  const createdAtMs = asset.createdAt?.toMillis?.() || 0;
  const ageDays = createdAtMs > 0 ? (Date.now() - createdAtMs) / 86400000 : 365;
  const freshnessBoost = Math.max(0, 2 - ageDays / 30);

  return categoryAffinity * 10 + marketplaceScore * 0.5 + qualityScore * 0.2 + freshnessBoost;
}

module.exports = {
  rankPersonalizedRecommendations,
  recommendationProfileRef,
  scorePersonalizedAsset,
  updateRecommendationProfile,
};
