const assert = require("node:assert/strict");
const test = require("node:test");

const {
  candidateFeedId,
  feedId,
  normalizeLocationInput,
  rankPersonalizedRecommendations,
  rankAndDedupe,
} = require("../utils/recommendations.util");

test("normalizeLocationInput prefers locality and keeps coordinates", () => {
  const location = normalizeLocationInput({
    country: " Philippines ",
    locality: " Makati ",
    cityState: "Legacy",
    lat: "14.5547",
    lng: 121.0244,
    geohash: "wdw4f",
  });

  assert.equal(location.country, "Philippines");
  assert.equal(location.locality, "Makati");
  assert.equal(location.localityKey, "makati");
  assert.equal(location.lat, 14.5547);
  assert.equal(location.lng, 121.0244);
  assert.equal(location.geohash, "wdw4f");
});

test("normalizeLocationInput falls back to legacy cityState", () => {
  const location = normalizeLocationInput({
    country: "Philippines",
    cityState: "Metro Manila",
  });

  assert.equal(location.locality, "Metro Manila");
  assert.equal(location.localityKey, "metro-manila");
});

test("feedId uses locality scope ids", () => {
  const location = normalizeLocationInput({
    country: "Philippines",
    locality: "Makati",
  });

  assert.equal(
    feedId({
      type: "recommended",
      scope: "locality",
      location,
      category: "Cameras",
    }),
    "recommended_locality:philippines:makati:cameras",
  );
});

test("candidateFeedId is neutral and does not include user category hints", () => {
  const location = normalizeLocationInput({
    country: "Philippines",
    locality: "Makati",
  });

  assert.equal(
    candidateFeedId({
      scope: "locality",
      location,
    }),
    "candidate_locality:philippines:makati:all",
  );
});

test("rankPersonalizedRecommendations returns empty without user profile signal", () => {
  const assets = [
    asset({ id: "asset-1", category: "Cameras", recommendationScore: 10 }),
  ];

  assert.deepEqual(
    rankPersonalizedRecommendations(assets, { categoryWeights: {} }),
    [],
  );
});

test("rankPersonalizedRecommendations ranks uniquely by user category affinity", () => {
  const assets = [
    asset({ id: "camera", category: "Cameras", recommendationScore: 1 }),
    asset({ id: "tool", category: "Tools", recommendationScore: 20 }),
  ];

  const cameraUser = rankPersonalizedRecommendations(
    assets,
    { categoryWeights: { cameras: 3 } },
    { limit: 12, currentUserId: "user-1" },
  );
  const toolUser = rankPersonalizedRecommendations(
    assets,
    { categoryWeights: { tools: 3 } },
    { limit: 12, currentUserId: "user-1" },
  );

  assert.deepEqual(
    cameraUser.map((item) => item.id),
    ["camera"],
  );
  assert.deepEqual(
    toolUser.map((item) => item.id),
    ["tool"],
  );
});

test("rankPersonalizedRecommendations excludes current user's own assets", () => {
  const assets = [
    asset({ id: "mine", ownerId: "user-1", category: "Cameras" }),
    asset({ id: "other", ownerId: "user-2", category: "Cameras" }),
  ];

  const ranked = rankPersonalizedRecommendations(
    assets,
    { categoryWeights: { cameras: 3 } },
    { limit: 12, currentUserId: "user-1" },
  );

  assert.deepEqual(
    ranked.map((item) => item.id),
    ["other"],
  );
});

test("rankAndDedupe excludes current user's own assets from popular results", () => {
  const assets = [
    asset({ id: "mine", ownerId: "user-1", popularityScore: 100 }),
    asset({ id: "other", ownerId: "user-2", popularityScore: 10 }),
  ];

  const ranked = rankAndDedupe(assets, {
    currentUserId: "user-1",
    type: "popular",
  });

  assert.deepEqual(
    ranked.map((item) => item.id),
    ["other"],
  );
});

function asset(overrides = {}) {
  return {
    id: "asset",
    ownerId: "owner",
    category: "Cameras",
    status: "Available",
    isDeleted: false,
    suppressFromRecommendations: false,
    recommendationScore: 0,
    qualityScore: 0,
    averageRating: null,
    reviewCount: null,
    ...overrides,
  };
}
