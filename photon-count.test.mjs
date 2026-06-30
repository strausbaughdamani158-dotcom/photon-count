import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  DEFAULT_NOISE_MASK_VALUES,
  accumulateCountFrame,
  appendRxBytes,
  applyNoiseMask,
  calculateAveragedCounts,
  decodePhotonPayload,
  parseNoiseMaskValues,
  scanPhotonCountFrames,
} from "./photon-count.js";
import {
  PHOTON_FRAME_BYTE_LENGTH,
  PHOTON_FRAME_PAYLOAD_LENGTH,
  PHOTON_PIXEL_COUNT,
} from "./protocol.js";

function makeFrame(words = []) {
  const frame = new Uint8Array(PHOTON_FRAME_BYTE_LENGTH);
  frame[0] = 0xaa;
  frame[1] = 0x55;
  for (let index = 0; index < PHOTON_PIXEL_COUNT; index += 1) {
    const word = words[index] ?? (index & 0xff);
    frame[2 + index * 2] = (word >>> 8) & 0xff;
    frame[3 + index * 2] = word & 0xff;
  }
  frame[2050] = 0x5a;
  return frame;
}

// Fixed protocol: AA 55 + 2048-byte payload + tail at byte 2050.
assert.equal(PHOTON_FRAME_BYTE_LENGTH, 2051);
assert.equal(PHOTON_FRAME_PAYLOAD_LENGTH, 2048);
assert.equal(PHOTON_PIXEL_COUNT, 1024);

const completeFrame = makeFrame([
  0x000a,
  0x00ff,
  0x0100,
  0xab34,
]);
assert.equal(completeFrame[0], 0xaa);
assert.equal(completeFrame[1], 0x55);
assert.equal(completeFrame[2050], 0x5a);

// A payload 0x5A is data, not an early tail.
completeFrame[2 + 90 * 2 + 1] = 0x5a;
completeFrame[2 + 500 * 2] = 0x5a;
const originalFrame = completeFrame.slice();
const parsed = scanPhotonCountFrames(completeFrame);
assert.equal(parsed.frames.length, 1);
assert.equal(parsed.nextOffset, 2051);
assert.equal(parsed.frames[0][90 * 2 + 1], 0x5a);
assert.equal(parsed.frames[0][500 * 2], 0x5a);
assert.deepEqual(completeFrame, originalFrame, "解析不得修改 rxBuffer 原始字节");

// Incoming chunks are appended; no previous byte is removed.
let rxBuffer = new Uint8Array(0);
rxBuffer = appendRxBytes(rxBuffer, Uint8Array.of(0x99, ...completeFrame.slice(0, 700)));
const firstPass = scanPhotonCountFrames(rxBuffer);
assert.equal(firstPass.frames.length, 0);
assert.equal(firstPass.nextOffset, 1);
const firstChunkSnapshot = rxBuffer.slice();
rxBuffer = appendRxBytes(rxBuffer, completeFrame.slice(700));
assert.deepEqual(rxBuffer.slice(0, firstChunkSnapshot.length), firstChunkSnapshot);
const secondPass = scanPhotonCountFrames(rxBuffer, firstPass.nextOffset);
assert.equal(secondPass.frames.length, 1);
assert.equal(secondPass.nextOffset, rxBuffer.length);

// Only the fixed byte2050 position validates the tail.
const invalidTail = completeFrame.slice();
invalidTail[2050] = 0x00;
const invalidThenValid = appendRxBytes(invalidTail, completeFrame);
const recovered = scanPhotonCountFrames(invalidThenValid);
assert.equal(recovered.frames.length, 1);
assert.deepEqual(recovered.frames[0], parsed.frames[0]);

// Decode all 1024 pixels directly in row-major order and use word & 0xff.
const counts = decodePhotonPayload(parsed.frames[0]);
assert.equal(counts.length, 1024);
assert.equal(counts[0], 10);
assert.equal(counts[1], 255);
assert.equal(counts[2], 0);
assert.equal(counts[3], 0x34);
assert.equal(counts[90], 0x5a);
assert.equal(counts[500], 500 & 0xff);
assert.equal(counts[31], 31);
assert.equal(counts[32], 32);
assert.equal(counts[1023], 255);

// Ten complete frames average 10..100 to 55.
const averageSum = new Uint32Array(1024);
for (const value of [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) {
  accumulateCountFrame(averageSum, new Uint16Array(1024).fill(value));
}
const averaged = calculateAveragedCounts(averageSum, 10);
assert.equal(averaged.length, 1024);
assert.ok(averaged.every((value) => value === 55));

// Mask exactly the requested values and leave every other value unchanged.
const expectedNoiseValues = [
  1, 2, 3, 4, 6, 8, 11, 12, 15, 16, 20, 24, 32, 48, 64, 96, 128, 192,
];
assert.deepEqual(DEFAULT_NOISE_MASK_VALUES, expectedNoiseValues);
const noiseValues = parseNoiseMaskValues(expectedNoiseValues.join(","));
const maskInput = Uint16Array.from([
  0, ...expectedNoiseValues, 5, 7, 10, 55, 90, 191, 193, 255,
]);
assert.deepEqual(
  [...applyNoiseMask(maskInput, true, noiseValues)],
  [0, ...expectedNoiseValues.map(() => 0), 5, 7, 10, 55, 90, 191, 193, 255],
);
assert.deepEqual(
  applyNoiseMask(maskInput, false, noiseValues),
  maskInput,
);

// UI stays at 32x32 and no background-learning controls or TDC mapper remain.
const html = await readFile(new URL("./photon-count.html", import.meta.url), "utf8");
const script = await readFile(new URL("./photon-count.js", import.meta.url), "utf8");
assert.match(html, /id="averageFrameCount"[^>]*value="10"[^>]*min="1"[^>]*max="100"/);
assert.match(html, /id="noiseMaskEnabled"[^>]*checked/);
assert.match(html, /1,2,3,4,6,8,11,12,15,16,20,24,32,48,64,96,128,192/);
assert.doesNotMatch(html, /background|背景帧数|采集背景|清除背景|背景阈值|背景扣除/i);
assert.doesNotMatch(script, /backgroundCounts|laneWordToPixel|applyBadPixelMask/);

console.log("photon count fixed-frame/averaging/noise-mask tests passed");
