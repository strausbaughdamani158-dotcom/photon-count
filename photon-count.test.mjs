import assert from "node:assert/strict";
import {
  applyBackgroundFilter,
  getDisplayFrameIntervalMs,
  parseBackgroundNoiseValues,
  shouldDisplayFrame,
} from "./photon-count.js";

const defaultNoiseValues = parseBackgroundNoiseValues(
  "1,2,3,6,12,24,48,96,128,192,240",
);

function filter(values, overrides = {}) {
  return [...applyBackgroundFilter(values, {
    enabled: true,
    noiseValues: new Set(),
    threshold: 0,
    subtract: 0,
    ...overrides,
  })];
}

assert.deepEqual(
  filter(
    [0, 1, 2, 3, 6, 12, 24, 48, 96, 128, 192, 240, 255],
    { noiseValues: defaultNoiseValues },
  ),
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255],
);

assert.deepEqual(
  filter([0, 1, 5, 6, 10, 20], { threshold: 5 }),
  [0, 0, 0, 6, 10, 20],
);

assert.deepEqual(
  filter([0, 3, 5, 6, 10, 20], { subtract: 5 }),
  [0, 0, 0, 1, 5, 15],
);

assert.deepEqual(
  filter(
    [1, 10, 24, 30, 192, 255],
    { noiseValues: defaultNoiseValues, subtract: 5 },
  ),
  [0, 5, 0, 25, 0, 250],
);

const rawCounts = Uint16Array.from({ length: 1024 }, (_, index) => index & 0xff);
const unfiltered = applyBackgroundFilter(rawCounts, { enabled: false });
assert.equal(unfiltered.length, 1024);
assert.deepEqual(unfiltered, rawCounts);
assert.notEqual(unfiltered, rawCounts);

assert.equal(getDisplayFrameIntervalMs(1), 1000);
assert.equal(getDisplayFrameIntervalMs(10), 100);
assert.equal(getDisplayFrameIntervalMs(50), 20);
assert.equal(shouldDisplayFrame(1000, 1999, 1), false);
assert.equal(shouldDisplayFrame(1000, 2000, 1), true);
assert.equal(shouldDisplayFrame(1000, 1019, 50), false);
assert.equal(shouldDisplayFrame(1000, 1020, 50), true);

console.log("photon count background/filter frame-rate tests passed");
