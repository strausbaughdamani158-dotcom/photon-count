import assert from "node:assert/strict";
import {
  accumulateCountFrame,
  applyBackgroundFilter,
  calculateAveragedCounts,
  getDisplayFrameIntervalMs,
  parseBackgroundNoiseValues,
  shouldDisplayFrame,
} from "./photon-count.js";

const defaultNoiseValues = parseBackgroundNoiseValues(
  "1,2,3,4,6,8,11,12,15,16,20,24,32,48,64,96,128,192,240",
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
    [0, 1, 2, 3, 4, 6, 8, 11, 12, 15, 16, 20, 24, 32, 48, 64, 96, 128, 192, 240, 255],
    { noiseValues: defaultNoiseValues },
  ),
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255],
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

const averageSum = new Uint32Array(1024);
for (let frame = 1; frame <= 10; frame += 1) {
  accumulateCountFrame(
    averageSum,
    new Uint16Array(1024).fill(frame * 10),
  );
}
const averagedCounts = calculateAveragedCounts(averageSum, 10);
assert.equal(averagedCounts.length, 1024);
assert.ok(averagedCounts.every((value) => value === 55));

assert.deepEqual(
  filter([50], {
    backgroundCounts: Uint16Array.of(20),
  }),
  [30],
);
assert.deepEqual(
  filter([20], {
    backgroundCounts: Uint16Array.of(50),
  }),
  [0],
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

console.log("photon count averaging/background/filter frame-rate tests passed");
