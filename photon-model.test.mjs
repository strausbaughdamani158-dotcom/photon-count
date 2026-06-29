import assert from "node:assert/strict";
import {
  configurePhotonScene,
  generatePhotonCounts,
} from "./photon-count.js";

let seed = 0x51a7c0de;
const originalRandom = Math.random;
Math.random = () => {
  seed = (1664525 * seed + 1013904223) >>> 0;
  return seed / 0x100000000;
};

function correlation(first, second) {
  const length = Math.min(first.length, second.length);
  let firstSum = 0;
  let secondSum = 0;
  for (let index = 0; index < length; index += 1) {
    firstSum += first[index];
    secondSum += second[index];
  }
  const firstMean = firstSum / length;
  const secondMean = secondSum / length;
  let covariance = 0;
  let firstVariance = 0;
  let secondVariance = 0;
  for (let index = 0; index < length; index += 1) {
    const firstDelta = first[index] - firstMean;
    const secondDelta = second[index] - secondMean;
    covariance += firstDelta * secondDelta;
    firstVariance += firstDelta ** 2;
    secondVariance += secondDelta ** 2;
  }
  return covariance / Math.sqrt(firstVariance * secondVariance);
}

function neighborCorrelation(values) {
  const first = [];
  const second = [];
  for (let row = 0; row < 32; row += 1) {
    for (let col = 0; col < 32; col += 1) {
      const index = row * 32 + col;
      if (col < 31) {
        first.push(values[index]);
        second.push(values[index + 1]);
      }
      if (row < 31) {
        first.push(values[index]);
        second.push(values[index + 32]);
      }
    }
  }
  return correlation(first, second);
}

try {
  configurePhotonScene(10);
  const firstFrame = generatePhotonCounts(1);
  let laterFrame = firstFrame;
  for (let frame = 2; frame <= 12; frame += 1) {
    laterFrame = generatePhotonCounts(frame);
  }

  const temporalCorrelation = correlation(firstFrame, laterFrame);
  const spatialCorrelation = neighborCorrelation(laterFrame);

  configurePhotonScene(20);
  const changedExposureFrame = generatePhotonCounts(1);
  const exposureChangeCorrelation = correlation(
    laterFrame,
    changedExposureFrame,
  );

  assert.ok(
    spatialCorrelation > 0.12,
    `相邻像素相关性不足：${spatialCorrelation}`,
  );
  assert.ok(
    temporalCorrelation > 0.15 && temporalCorrelation < 0.9,
    `帧间相关性过弱或过于规律：${temporalCorrelation}`,
  );
  assert.ok(
    exposureChangeCorrelation < 0.7,
    `曝光变化后图样仍过于相似：${exposureChangeCorrelation}`,
  );

  console.log(JSON.stringify({
    spatialCorrelation,
    temporalCorrelation,
    exposureChangeCorrelation,
  }));
} finally {
  Math.random = originalRandom;
}
