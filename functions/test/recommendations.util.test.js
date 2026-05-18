const assert = require("node:assert/strict");
const test = require("node:test");

const {
  feedId,
  normalizeLocationInput,
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
