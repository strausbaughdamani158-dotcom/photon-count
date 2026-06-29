import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  CHIP_NO_DATA_VALUE,
  buildChipPerformanceProfile,
  buildElectricalDemoFrame,
  buildPhotonCountFrame,
  decodePhotonCountWord,
  decodeTwoStageTdc,
  encodePhotonCountWord,
  encodeTwoStageTdc,
  createBinaryFrame,
  extractBinaryFrames,
  extractPhotonCountFrames,
  laneWordToPixel,
  parseBinaryFrame,
  parseChipHexLine,
  parsePhotonCountLine,
  parseO12FirstTwoTdc,
  parseTextLine,
  sampleTdcJitterSteps,
  wrapPhotonCounter,
} from "./protocol.js";

assert.deepEqual(parseTextLine("2,3,1005"), {
  version: 1,
  mode: 1,
  seq: null,
  row: 2,
  col: 3,
  tdc: 1005,
  raw16: null,
  status: 0,
});

assert.equal(parseTextLine("8", { row: 4, col: 5 }).row, 4);
assert.equal(parseTextLine('{"seq":7,"row":1,"col":2,"tdc":1234}').seq, 7);

const frame = createBinaryFrame({
  seq: 42,
  row: 12,
  col: 24,
  tdc: 123456,
  status: 0,
});
const parsed = parseBinaryFrame(frame);
assert.equal(parsed.seq, 42);
assert.equal(parsed.row, 12);
assert.equal(parsed.col, 24);
assert.equal(parsed.tdc, 123456);

const noisy = new Uint8Array([0x00, 0xff, ...frame, ...frame.slice(0, 7)]);
const extracted = extractBinaryFrames(new Uint8Array(0), noisy);
assert.equal(extracted.frames.length, 1);
assert.equal(extracted.remainder.length, 7);

assert.deepEqual(laneWordToPixel(1, 0), { row: 0, col: 0 });
assert.deepEqual(laneWordToPixel(1, 31), { row: 0, col: 31 });
assert.deepEqual(laneWordToPixel(1, 32), { row: 1, col: 31 });
assert.deepEqual(laneWordToPixel(1, 63), { row: 1, col: 0 });
assert.deepEqual(laneWordToPixel(16, 63), { row: 31, col: 0 });

const chipLine = parseChipHexLine("O12: 0003 F81B 0400");
assert.equal(chipLine.lane, 1);
assert.equal(chipLine.noDataCount, 1);
assert.equal(chipLine.records.length, 2);
assert.equal(chipLine.records[0].row, 0);
assert.equal(chipLine.records[0].col, 1);
assert.equal(chipLine.records[0].tdc, 0x001b);
assert.equal(chipLine.records[0].raw16, 0xf81b);
assert.equal(CHIP_NO_DATA_VALUE, 0x0003);

const laneTwelve = parseChipHexLine("CH12: 0004");
assert.equal(laneTwelve.lane, 12);
assert.equal(laneTwelve.records[0].row, 22);

const compactHex = parseChipHexLine("000300040005", 1);
assert.equal(compactHex.noDataCount, 1);
assert.equal(compactHex.records.length, 2);

const documentedCode = Number.parseInt("00010011010", 2);
const documentedDecode = decodeTwoStageTdc(documentedCode);
assert.equal(documentedDecode.coarseCount, 236);
assert.equal(documentedDecode.fineCount, 2);
assert.equal(documentedDecode.timeNs, 295.3125);

const encodedDocumentedTime = encodeTwoStageTdc(295.3125);
assert.equal(encodedDocumentedTime.raw11, documentedCode);
assert.equal(encodedDocumentedTime.quantizedTimeNs, 295.3125);

const quantized = encodeTwoStageTdc(150.13);
assert.ok(Math.abs(quantized.quantizedTimeNs - 150.13) <= 0.15625);
assert.notEqual(quantized.raw11, CHIP_NO_DATA_VALUE);

const demoFrame = buildElectricalDemoFrame(100, 15, [-1, 1]);
assert.equal(demoFrame.words.length, 64);
assert.equal(demoFrame.noDataCount, 62);
assert.notEqual(demoFrame.words[0], "0x0003");
assert.notEqual(demoFrame.words[1], "0x0003");
assert.ok(demoFrame.words.slice(2).every((word) => word === "0x0003"));
assert.equal(parseChipHexLine(demoFrame.line).records.length, 2);
const o12FirstTwo = parseO12FirstTwoTdc(demoFrame.line);
assert.equal(o12FirstTwo.valid, true);
assert.equal(o12FirstTwo.pixels.length, 2);
assert.equal(o12FirstTwo.pixels[0].row, 0);
assert.equal(o12FirstTwo.pixels[0].col, 0);
assert.equal(o12FirstTwo.pixels[1].col, 1);
assert.equal(o12FirstTwo.pixels[0].hex, demoFrame.words[0]);
assert.equal(o12FirstTwo.pixels[1].hex, demoFrame.words[1]);
assert.equal(
  o12FirstTwo.averageTimeNs,
  (o12FirstTwo.pixels[0].timeNs + o12FirstTwo.pixels[1].timeNs) / 2,
);
assert.equal(parseO12FirstTwoTdc("O34: 0004 0005"), null);
assert.equal(parseO12FirstTwoTdc("CH1: 0003 0004").valid, false);

const photonWord = decodePhotonCountWord(0x07ad);
assert.equal(photonWord.raw11, 0x07ad);
assert.equal(photonWord.count, 0xad);
assert.equal(photonWord.ignoredBits, 7);
assert.equal(photonWord.overflowBits, 7);
assert.equal(decodePhotonCountWord(0x000a).count, 10);
assert.equal(decodePhotonCountWord(0x000b).count, 11);
assert.equal(decodePhotonCountWord(0x00ff).count, 255);
assert.equal(decodePhotonCountWord(0x0100).count, 0);
assert.equal(decodePhotonCountWord(0x0100).overflowBits, 1);
assert.equal(decodePhotonCountWord(0x07ff).count, 255);

const encodedPhotonWord = encodePhotonCountWord(2047, 7);
assert.equal(encodedPhotonWord.count, 255);
assert.equal(encodedPhotonWord.ignoredBits, 0);
assert.equal(encodedPhotonWord.overflowBits, 0);
assert.equal(encodedPhotonWord.raw11, 0x00ff);
assert.equal(encodedPhotonWord.raw16, 0x00ff);
assert.equal(encodedPhotonWord.hex, "0x00FF");

let photonBinaryResult = extractPhotonCountFrames(
  new Uint8Array(0),
  Uint8Array.from([0x99, 0xaa, 0x55, 0x00, 0x0a, 0x00]),
);
assert.equal(photonBinaryResult.frames.length, 0);
assert.equal(photonBinaryResult.discardedBytes, 1);
photonBinaryResult = extractPhotonCountFrames(
  photonBinaryResult.remainder,
  Uint8Array.from([0x0b, 0x00, 0xff, 0x01, 0x00, 0x5a]),
);
assert.equal(photonBinaryResult.frames.length, 1);
assert.deepEqual(
  [...photonBinaryResult.frames[0]],
  [0x00, 0x0a, 0x00, 0x0b, 0x00, 0xff, 0x01, 0x00],
);
assert.equal(photonBinaryResult.remainder.length, 0);
for (const pointCount of [64, 1024]) {
  const frame = new Uint8Array(2 + pointCount * 2 + 1);
  frame.set([0xaa, 0x55]);
  for (let index = 0; index < pointCount; index += 1) {
    frame[2 + index * 2] = (index >>> 8) & 0x07;
    frame[3 + index * 2] = index & 0xff;
  }
  frame[frame.length - 1] = 0x5a;
  const extracted = extractPhotonCountFrames(new Uint8Array(0), frame);
  assert.equal(extracted.frames.length, 1);
  assert.equal(extracted.frames[0].length, pointCount * 2);
  assert.equal(extracted.remainder.length, 0);
}

const photonLineWords = Array.from(
  { length: 64 },
  (_, index) => `0x${index
    .toString(16).toUpperCase().padStart(4, "0")}`,
);
const photonLine = parsePhotonCountLine(`O12: ${photonLineWords.join(" ")}`);
assert.equal(photonLine.lane, 1);
assert.equal(photonLine.records.length, 64);
assert.equal(photonLine.records[0].row, 0);
assert.equal(photonLine.records[0].col, 0);
assert.equal(photonLine.records[0].count, 0);
assert.equal(photonLine.records[0].ignoredBits, 0);
assert.equal(photonLine.records[31].row, 0);
assert.equal(photonLine.records[31].col, 31);
assert.equal(photonLine.records[31].count, 31);
assert.equal(photonLine.records[32].row, 1);
assert.equal(photonLine.records[32].col, 31);
assert.equal(photonLine.records[32].count, 32);
assert.equal(photonLine.records[63].row, 1);
assert.equal(photonLine.records[63].col, 0);
assert.equal(photonLine.records[63].count, 63);

const lowPhotonLine = parsePhotonCountLine("CH16: 0x0003");
assert.equal(lowPhotonLine.records.length, 1);
assert.equal(lowPhotonLine.records[0].row, 30);
assert.equal(lowPhotonLine.records[0].count, 3);

const photonCounts = Uint16Array.from(
  { length: 32 * 32 },
  (_, index) => index,
);
const fullPhotonFrame = buildPhotonCountFrame(photonCounts);
assert.equal(fullPhotonFrame.lines.length, 16);
assert.ok(fullPhotonFrame.lines[0].startsWith("O12:"));
assert.ok(fullPhotonFrame.lines[15].startsWith("O3132:"));
assert.ok(fullPhotonFrame.lanes.every((lane) => lane.words.length === 64));
const parsedFirstPhotonLane = parsePhotonCountLine(fullPhotonFrame.lines[0]);
assert.equal(parsedFirstPhotonLane.records[0].count, photonCounts[0]);
assert.equal(parsedFirstPhotonLane.records[31].count, photonCounts[31]);
assert.equal(parsedFirstPhotonLane.records[32].count, photonCounts[63]);
assert.equal(parsedFirstPhotonLane.records[63].count, photonCounts[32]);
assert.ok(
  parsedFirstPhotonLane.records.every((record) => record.ignoredBits === 0),
);
assert.equal(wrapPhotonCounter(0), 0);
assert.equal(wrapPhotonCounter(255), 255);
assert.equal(wrapPhotonCounter(256), 0);
assert.equal(wrapPhotonCounter(2047), 255);
assert.equal(wrapPhotonCounter(2048), 0);
assert.equal(wrapPhotonCounter(2348), 44);
assert.equal(wrapPhotonCounter(-5), 0);

const badPixelConfig = JSON.parse(
  await readFile(new URL("./bad-pixels.json", import.meta.url), "utf8"),
);
assert.equal(badPixelConfig.array.rows, 32);
assert.equal(badPixelConfig.array.columns, 32);
assert.equal(badPixelConfig.coordinateBase, 0);
assert.equal(badPixelConfig.badPixelCount, 142);
assert.equal(badPixelConfig.pixels.length, 142);
const badPixelKeys = new Set(
  badPixelConfig.pixels.map(([row, col]) => `${row},${col}`),
);
assert.equal(badPixelKeys.size, 142);
assert.ok(
  badPixelConfig.pixels.every(
    ([row, col]) => Number.isInteger(row) && row >= 0 && row < 32
      && Number.isInteger(col) && col >= 0 && col < 32,
  ),
);
const rightBadPixelCount = badPixelConfig.pixels.filter(
  ([, col]) => col >= badPixelConfig.rightRegion.columnStart
    && col <= badPixelConfig.rightRegion.columnEnd,
).length;
assert.equal(rightBadPixelCount, 57);
assert.equal(rightBadPixelCount, badPixelConfig.rightRegion.badPixelCount);

const maskedPhotonCounts = new Uint16Array(32 * 32).fill(87);
for (const [row, col] of badPixelConfig.pixels) {
  maskedPhotonCounts[row * 32 + col] = 0;
}
const maskedPhotonFrame = buildPhotonCountFrame(maskedPhotonCounts);
for (const line of maskedPhotonFrame.lines) {
  const parsedLine = parsePhotonCountLine(line);
  for (const record of parsedLine.records) {
    const key = `${record.row},${record.col}`;
    if (badPixelKeys.has(key)) {
      assert.equal(record.count, 0);
      assert.equal(record.raw16, 0x0000);
    } else {
      assert.equal(record.count, 87);
    }
  }
}

let seed = 0x12345678;
const seededRandom = () => {
  seed = (1664525 * seed + 1013904223) >>> 0;
  return seed / 0x100000000;
};
const jitterSamples = Array.from(
  { length: 50000 },
  () => sampleTdcJitterSteps({
    sigmaLsb: 2.5,
    outlierProbability: 0.02,
    outlierSigmaLsb: 18,
    outlierMinimumLsb: 8,
  }, seededRandom),
);
const jitterMean = jitterSamples.reduce((sum, sample) => sum + sample.steps, 0)
  / jitterSamples.length;
const jitterVariance = jitterSamples.reduce(
  (sum, sample) => sum + (sample.steps - jitterMean) ** 2,
  0,
) / jitterSamples.length;
const outlierSamples = jitterSamples.filter((sample) => sample.isOutlier);

assert.ok(Math.abs(jitterMean) < 0.25);
assert.ok(Math.sqrt(jitterVariance) > 3);
assert.ok(jitterSamples.some((sample) => Math.abs(sample.steps) > 20));
assert.ok(outlierSamples.length > 700 && outlierSamples.length < 1300);
assert.ok(outlierSamples.every((sample) => Math.abs(sample.steps) >= 8));

const idealPerformance = buildChipPerformanceProfile(100);
const reducedPerformance = buildChipPerformanceProfile(60);
const poorPerformance = buildChipPerformanceProfile(0);
assert.equal(idealPerformance.performancePercent, 100);
assert.equal(idealPerformance.sigmaLsb, 1.2);
assert.equal(idealPerformance.outlierProbability, 0.005);
assert.equal(idealPerformance.outlierSigmaLsb, 10);
assert.equal(idealPerformance.commonDriftSigmaLsb, 0.25);
assert.equal(reducedPerformance.performancePercent, 60);
assert.ok(reducedPerformance.sigmaLsb > idealPerformance.sigmaLsb);
assert.ok(reducedPerformance.outlierProbability > idealPerformance.outlierProbability);
assert.ok(reducedPerformance.outlierSigmaLsb > idealPerformance.outlierSigmaLsb);
assert.ok(reducedPerformance.commonDriftSigmaLsb > 0);
assert.equal(poorPerformance.performancePercent, 0);
assert.equal(poorPerformance.sigmaLsb, 9);
assert.equal(poorPerformance.outlierProbability, 0.1);
assert.equal(poorPerformance.outlierSigmaLsb, 45);
assert.equal(poorPerformance.commonDriftSigmaLsb, 6.25);

console.log("protocol tests passed");
