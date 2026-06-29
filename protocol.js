export const BINARY_FRAME_SIZE = 16;
export const FRAME_HEADER = [0xaa, 0x55];
export const CHIP_DATA_MASK = 0x07ff;
export const CHIP_NO_DATA_VALUE = 0x0003;
export const CHIP_WORDS_PER_LANE = 64;
export const TDC_COARSE_RESOLUTION_NS = 1.25;
export const TDC_FINE_RESOLUTION_NS = 0.15625;
export const TDC_MAX_TIME_NS = 255 * TDC_COARSE_RESOLUTION_NS
  + 7 * TDC_FINE_RESOLUTION_NS;

export function gaussianRandom(random = Math.random) {
  let first = 0;
  let second = 0;
  while (first <= Number.EPSILON) first = Number(random());
  while (second <= Number.EPSILON) second = Number(random());
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
}

export function sampleTdcJitterSteps(options = {}, random = Math.random) {
  const sigmaLsb = Math.max(0, Number(options.sigmaLsb ?? 2.5));
  const outlierProbability = Math.max(
    0,
    Math.min(1, Number(options.outlierProbability ?? 0.02)),
  );
  const outlierSigmaLsb = Math.max(
    sigmaLsb,
    Number(options.outlierSigmaLsb ?? 18),
  );
  const outlierMinimumLsb = Math.max(
    0,
    Math.round(Number(options.outlierMinimumLsb ?? 8)),
  );
  const isOutlier = Number(random()) < outlierProbability;
  const sigma = isOutlier ? outlierSigmaLsb : sigmaLsb;
  let steps = Math.round(gaussianRandom(random) * sigma);

  if (isOutlier && Math.abs(steps) < outlierMinimumLsb) {
    const direction = steps === 0
      ? (Number(random()) < 0.5 ? -1 : 1)
      : Math.sign(steps);
    steps = direction * outlierMinimumLsb;
  }

  return { steps, isOutlier };
}

export function buildChipPerformanceProfile(performance = 60) {
  const requestedPerformance = Number(performance);
  const performancePercent = Math.max(
    0,
    Math.min(100, Number.isFinite(requestedPerformance) ? requestedPerformance : 60),
  );
  const degradation = ((100 - performancePercent) / 100) ** 1.35;

  return {
    performancePercent,
    sigmaLsb: 1.2 + 7.8 * degradation,
    outlierProbability: 0.005 + 0.095 * degradation,
    outlierSigmaLsb: 10 + 35 * degradation,
    outlierMinimumLsb: 6 + Math.round(8 * degradation),
    commonDriftSigmaLsb: 0.25 + 6 * degradation,
  };
}

export function clampPixel(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(31, Math.trunc(number)));
}

export function crc16Modbus(bytes) {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
  }
  return crc & 0xffff;
}

export function decodeTwoStageTdc(code) {
  const raw11 = Number(code) & CHIP_DATA_MASK;
  const encodedCoarse = (raw11 >>> 3) & 0xff;
  const coarseCount = (~encodedCoarse) & 0xff;
  const fineCount = raw11 & 0x07;
  return {
    raw11,
    encodedCoarse,
    coarseCount,
    fineCount,
    timeNs: coarseCount * TDC_COARSE_RESOLUTION_NS
      + fineCount * TDC_FINE_RESOLUTION_NS,
  };
}

export function encodeTwoStageTdc(timeNs) {
  const requestedTimeNs = Number(timeNs);
  if (!Number.isFinite(requestedTimeNs)) {
    throw new Error(`TDC 时间无效: ${timeNs}`);
  }

  const clampedTimeNs = Math.max(0, Math.min(TDC_MAX_TIME_NS, requestedTimeNs));
  let totalFineTicks = Math.round(clampedTimeNs / TDC_FINE_RESOLUTION_NS);
  totalFineTicks = Math.max(0, Math.min(2047, totalFineTicks));
  const coarseCount = Math.floor(totalFineTicks / 8);
  const fineCount = totalFineTicks % 8;
  const encodedCoarse = (~coarseCount) & 0xff;
  let raw11 = (encodedCoarse << 3) | fineCount;

  // 0x003 is reserved by the chip as its no-data output.
  if (raw11 === CHIP_NO_DATA_VALUE) {
    totalFineTicks += totalFineTicks < 2047 ? 1 : -1;
    raw11 = (((~Math.floor(totalFineTicks / 8)) & 0xff) << 3) | (totalFineTicks % 8);
  }

  return {
    requestedTimeNs,
    quantizedTimeNs: decodeTwoStageTdc(raw11).timeNs,
    raw11,
    raw16: raw11,
    hex: `0x${raw11.toString(16).toUpperCase().padStart(4, "0")}`,
  };
}

export function buildElectricalDemoFrame(
  tofNs,
  hardwareBiasNs = 15,
  jitterSteps = [0, 0],
) {
  const words = new Array(CHIP_WORDS_PER_LANE).fill("0x0003");
  const valid = [];

  for (let pixel = 0; pixel < 2; pixel += 1) {
    const jitter = Number(jitterSteps[pixel] ?? 0);
    const targetTimeNs = Number(tofNs) + Number(hardwareBiasNs)
      + jitter * TDC_FINE_RESOLUTION_NS;
    const encoded = encodeTwoStageTdc(targetTimeNs);
    words[pixel] = encoded.hex;
    valid.push({
      pixel,
      jitterSteps: jitter,
      targetTimeNs,
      ...encoded,
      decoded: decodeTwoStageTdc(encoded.raw11),
    });
  }

  return {
    line: `O12: ${words.join(" ")}`,
    words,
    valid,
    noDataCount: CHIP_WORDS_PER_LANE - valid.length,
  };
}

export function laneWordToPixel(lane, wordIndex) {
  const laneIndex = Number(lane) - 1;
  const index = Number(wordIndex);
  if (!Number.isInteger(laneIndex) || laneIndex < 0 || laneIndex > 15) {
    throw new Error(`输出组应为 1～16，当前为 ${lane}`);
  }
  if (!Number.isInteger(index) || index < 0 || index >= CHIP_WORDS_PER_LANE) {
    throw new Error(`组内字序号应为 0～63，当前为 ${wordIndex}`);
  }

  const firstRow = laneIndex * 2;
  if (index < 32) {
    return { row: firstRow, col: index };
  }
  return { row: firstRow + 1, col: 63 - index };
}

export function parseChipHexLine(line, fallbackLane = 1, startIndex = 0) {
  let text = String(line).trim();
  if (!text) return { lane: fallbackLane, records: [], noDataCount: 0, nextIndex: startIndex };

  let lane = Number(fallbackLane);
  const prefix = text.match(/^(?:(O|CH))?\s*(\d{1,4})(?:\s*\/\s*(\d{1,2}))?\s*[:=]\s*/i);
  if (prefix) {
    lane = laneFromLabel(prefix[2], prefix[3], prefix[1]?.toUpperCase() === "CH");
    text = text.slice(prefix[0].length);
  }
  if (!Number.isInteger(lane) || lane < 1 || lane > 16) {
    throw new Error(`无法识别输出组: ${lane}`);
  }

  let tokens = text.split(/[\s,;]+/).filter(Boolean);
  if (tokens.length === 1) {
    const compact = tokens[0].replace(/^0x/i, "");
    if (compact.length > 4 && compact.length % 4 === 0 && /^[0-9a-f]+$/i.test(compact)) {
      tokens = compact.match(/.{4}/g);
    }
  }
  if (!tokens.length) return { lane, records: [], noDataCount: 0, nextIndex: startIndex };

  const records = [];
  let noDataCount = 0;
  const cursor = Array.isArray(startIndex) || ArrayBuffer.isView(startIndex)
    ? Number(startIndex[lane - 1] ?? 0)
    : Number(startIndex);
  let index = tokens.length > 1 ? 0 : cursor;

  for (const token of tokens) {
    const normalized = token.replace(/^0x/i, "");
    if (!/^[0-9a-f]{1,4}$/i.test(normalized)) {
      throw new Error(`无效的 16 位十六进制数据: ${token}`);
    }
    if (index >= CHIP_WORDS_PER_LANE) index = 0;
    const raw16 = Number.parseInt(normalized, 16);
    const tdc = raw16 & CHIP_DATA_MASK;
    const pixel = laneWordToPixel(lane, index);
    if (tdc === CHIP_NO_DATA_VALUE) {
      noDataCount += 1;
    } else {
      records.push(normalizeRecord({
        mode: 2,
        row: pixel.row,
        col: pixel.col,
        tdc,
        raw16,
        status: 0,
      }));
    }
    index += 1;
  }

  return {
    lane,
    records,
    noDataCount,
    nextIndex: index % CHIP_WORDS_PER_LANE,
  };
}

export function parseO12FirstTwoTdc(line) {
  const text = String(line).trim();
  if (!text) return null;

  const prefix = text.match(/(?:^|\s)(?:O\s*(?:12|1\s*\/\s*2)|CH\s*1)\s*[:=]\s*/i);
  if (!prefix) return null;

  const prefixEnd = (prefix.index ?? 0) + prefix[0].length;
  let tokens = text.slice(prefixEnd).split(/[\s,;]+/).filter(Boolean);
  if (tokens.length === 1) {
    const compact = tokens[0].replace(/^0x/i, "");
    if (compact.length > 4 && compact.length % 4 === 0 && /^[0-9a-f]+$/i.test(compact)) {
      tokens = compact.match(/.{4}/g);
    }
  }

  if (tokens.length < 2) {
    throw new Error("O12 数据至少需要前两个 16-bit HEX 字");
  }

  const pixels = tokens.slice(0, 2).map((token, pixel) => {
    const normalized = token.replace(/^0x/i, "");
    if (!/^[0-9a-f]{1,4}$/i.test(normalized)) {
      throw new Error(`无效的 O12 16-bit HEX 数据: ${token}`);
    }
    const raw16 = Number.parseInt(normalized, 16) & 0xffff;
    const raw11 = raw16 & CHIP_DATA_MASK;
    const valid = raw11 !== CHIP_NO_DATA_VALUE;
    const decoded = valid ? decodeTwoStageTdc(raw11) : null;
    return {
      pixel,
      row: 0,
      col: pixel,
      wordIndex: pixel,
      raw16,
      raw11,
      hex: `0x${raw16.toString(16).toUpperCase().padStart(4, "0")}`,
      valid,
      decoded,
      timeNs: decoded?.timeNs ?? null,
    };
  });

  const valid = pixels.every((pixel) => pixel.valid);
  return {
    line: text,
    pixels,
    valid,
    averageTimeNs: valid
      ? (pixels[0].timeNs + pixels[1].timeNs) / 2
      : null,
  };
}

export function decodePhotonCountWord(word) {
  const raw16 = Number(word) & 0xffff;
  const raw11 = raw16 & CHIP_DATA_MASK;
  return {
    raw16,
    raw11,
    count: (raw11 >>> 3) & 0xff,
    ignoredBits: raw11 & 0x07,
  };
}

export function encodePhotonCountWord(count, ignoredBits = 3) {
  const photonCount = Math.max(0, Math.min(255, Math.round(Number(count) || 0)));
  const lowBits = Number(ignoredBits) & 0x07;
  const raw11 = (photonCount << 3) | lowBits;
  return {
    count: photonCount,
    ignoredBits: lowBits,
    raw11,
    raw16: raw11,
    hex: `0x${raw11.toString(16).toUpperCase().padStart(4, "0")}`,
  };
}

export function wrapPhotonCounter(count) {
  const rawCount = Math.max(0, Math.round(Number(count) || 0));
  return rawCount % 256;
}

export function buildPhotonCountFrame(counts, ignoredBits = 3) {
  if (!counts || counts.length < 32 * 32) {
    throw new Error("光子计数帧需要 1024 个像素值");
  }

  const lines = [];
  const lanes = [];
  for (let lane = 1; lane <= 16; lane += 1) {
    const words = [];
    for (let wordIndex = 0; wordIndex < CHIP_WORDS_PER_LANE; wordIndex += 1) {
      const pixel = laneWordToPixel(lane, wordIndex);
      const count = counts[pixel.row * 32 + pixel.col];
      words.push(encodePhotonCountWord(count, ignoredBits).hex);
    }
    const firstRow = lane * 2 - 1;
    const label = `O${firstRow}${firstRow + 1}`;
    const line = `${label}: ${words.join(" ")}`;
    lines.push(line);
    lanes.push({ lane, label, words, line });
  }

  return {
    lines,
    lanes,
    text: lines.join("\n"),
  };
}

export function parsePhotonCountLine(line, fallbackLane = 1, startIndex = 0) {
  let text = String(line).trim();
  if (!text) {
    return { lane: fallbackLane, records: [], nextIndex: startIndex };
  }

  let lane = Number(fallbackLane);
  const prefix = text.match(/^(?:(O|CH))?\s*(\d{1,4})(?:\s*\/\s*(\d{1,2}))?\s*[:=]\s*/i);
  if (prefix) {
    lane = laneFromLabel(prefix[2], prefix[3], prefix[1]?.toUpperCase() === "CH");
    text = text.slice(prefix[0].length);
  }
  if (!Number.isInteger(lane) || lane < 1 || lane > 16) {
    throw new Error(`无法识别输出组 ${lane}`);
  }

  let tokens = text.split(/[\s,;]+/).filter(Boolean);
  if (tokens.length === 1) {
    const compact = tokens[0].replace(/^0x/i, "");
    if (compact.length > 4 && compact.length % 4 === 0 && /^[0-9a-f]+$/i.test(compact)) {
      tokens = compact.match(/.{4}/g);
    }
  }

  const cursor = Array.isArray(startIndex) || ArrayBuffer.isView(startIndex)
    ? Number(startIndex[lane - 1] ?? 0)
    : Number(startIndex);
  let index = tokens.length > 1 ? 0 : cursor;
  const records = [];

  for (const token of tokens) {
    const normalized = token.replace(/^0x/i, "");
    if (!/^[0-9a-f]{1,4}$/i.test(normalized)) {
      throw new Error(`无效的 16 位十六进制数据: ${token}`);
    }
    if (index >= CHIP_WORDS_PER_LANE) index = 0;
    const decoded = decodePhotonCountWord(Number.parseInt(normalized, 16));
    const pixel = laneWordToPixel(lane, index);
    records.push({
      lane,
      wordIndex: index,
      row: pixel.row,
      col: pixel.col,
      ...decoded,
    });
    index += 1;
  }

  return {
    lane,
    records,
    nextIndex: index % CHIP_WORDS_PER_LANE,
  };
}

function laneFromLabel(first, second, directChannel = false) {
  if (directChannel) {
    const lane = Number(first);
    if (second !== undefined || !Number.isInteger(lane) || lane < 1 || lane > 16) {
      throw new Error(`CH 输出组应为 CH1～CH16: CH${first}`);
    }
    return lane;
  }
  if (second !== undefined) {
    const firstRow = Number(first);
    const secondRow = Number(second);
    if (secondRow !== firstRow + 1 || firstRow % 2 !== 1) {
      throw new Error(`输出组行号应为相邻奇偶行: O${first}/${second}`);
    }
    return (firstRow + 1) / 2;
  }

  const digits = String(first);
  const direct = Number(digits);
  for (let split = 1; split < digits.length; split += 1) {
    const firstRow = Number(digits.slice(0, split));
    const secondRow = Number(digits.slice(split));
    if (firstRow % 2 === 1 && secondRow === firstRow + 1 && secondRow <= 32) {
      return (firstRow + 1) / 2;
    }
  }
  if (direct >= 1 && direct <= 16) return direct;
  throw new Error(`无法识别输出组标签: O${digits}`);
}

export function parseTextLine(line, fallbackPixel = { row: 0, col: 0 }) {
  const text = String(line).trim();
  if (!text) return null;

  if (text.startsWith("{")) {
    const value = JSON.parse(text);
    const tdc = Number(value.tdc ?? value.value ?? value.code ?? value.time);
    if (!Number.isFinite(tdc)) throw new Error("JSON 中缺少有效的 tdc 字段");
    return normalizeRecord({
      seq: value.seq,
      row: value.row ?? fallbackPixel.row,
      col: value.col ?? fallbackPixel.col,
      tdc,
      status: value.status ?? 0,
      mode: value.mode ?? 1,
    });
  }

  const fields = text.split(/[\s,;]+/).filter(Boolean).map(Number);
  if (!fields.length || fields.some((item) => !Number.isFinite(item))) {
    throw new Error("文本记录包含非数字字段");
  }

  if (fields.length === 1) {
    return normalizeRecord({
      row: fallbackPixel.row,
      col: fallbackPixel.col,
      tdc: fields[0],
    });
  }

  if (fields.length === 3) {
    return normalizeRecord({
      row: fields[0],
      col: fields[1],
      tdc: fields[2],
    });
  }

  if (fields.length >= 4) {
    return normalizeRecord({
      seq: fields[0],
      row: fields[1],
      col: fields[2],
      tdc: fields[3],
      status: fields[4] ?? 0,
    });
  }

  throw new Error("文本格式应为 row,col,tdc 或 seq,row,col,tdc,status");
}

export function parseBinaryFrame(frame) {
  const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  if (bytes.length !== BINARY_FRAME_SIZE) {
    throw new Error(`二进制帧长度应为 ${BINARY_FRAME_SIZE} 字节`);
  }
  if (bytes[0] !== FRAME_HEADER[0] || bytes[1] !== FRAME_HEADER[1]) {
    throw new Error("二进制帧头错误");
  }

  const expectedCrc = bytes[14] | (bytes[15] << 8);
  const actualCrc = crc16Modbus(bytes.subarray(0, 14));
  if (expectedCrc !== actualCrc) {
    throw new Error("CRC16 校验失败");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return normalizeRecord({
    version: bytes[2],
    mode: bytes[3],
    seq: view.getUint16(4, true),
    row: bytes[6],
    col: bytes[7],
    tdc: view.getUint32(8, true),
    status: bytes[12],
  });
}

export function extractBinaryFrames(existingBuffer, incomingBytes) {
  const first = existingBuffer instanceof Uint8Array
    ? existingBuffer
    : new Uint8Array(existingBuffer ?? 0);
  const second = incomingBytes instanceof Uint8Array
    ? incomingBytes
    : new Uint8Array(incomingBytes);
  const merged = new Uint8Array(first.length + second.length);
  merged.set(first);
  merged.set(second, first.length);

  const frames = [];
  let errors = 0;
  let cursor = 0;

  while (cursor <= merged.length - 2) {
    if (merged[cursor] !== FRAME_HEADER[0] || merged[cursor + 1] !== FRAME_HEADER[1]) {
      cursor += 1;
      errors += 1;
      continue;
    }

    if (merged.length - cursor < BINARY_FRAME_SIZE) break;
    const candidate = merged.slice(cursor, cursor + BINARY_FRAME_SIZE);
    try {
      frames.push(parseBinaryFrame(candidate));
      cursor += BINARY_FRAME_SIZE;
    } catch {
      cursor += 1;
      errors += 1;
    }
  }

  return {
    frames,
    errors,
    remainder: merged.slice(cursor),
  };
}

export function createBinaryFrame(record) {
  const bytes = new Uint8Array(BINARY_FRAME_SIZE);
  const view = new DataView(bytes.buffer);
  bytes[0] = FRAME_HEADER[0];
  bytes[1] = FRAME_HEADER[1];
  bytes[2] = Number(record.version ?? 1) & 0xff;
  bytes[3] = Number(record.mode ?? 1) & 0xff;
  view.setUint16(4, Number(record.seq ?? 0) & 0xffff, true);
  bytes[6] = clampPixel(record.row);
  bytes[7] = clampPixel(record.col);
  view.setUint32(8, Math.max(0, Math.round(Number(record.tdc ?? 0))), true);
  bytes[12] = Number(record.status ?? 0) & 0xff;
  bytes[13] = 0;
  view.setUint16(14, crc16Modbus(bytes.subarray(0, 14)), true);
  return bytes;
}

function normalizeRecord(record) {
  const row = Number(record.row);
  const col = Number(record.col);
  const tdc = Number(record.tdc);
  if (!Number.isInteger(row) || row < 0 || row > 31) {
    throw new Error(`像素行号超出范围: ${record.row}`);
  }
  if (!Number.isInteger(col) || col < 0 || col > 31) {
    throw new Error(`像素列号超出范围: ${record.col}`);
  }
  if (!Number.isFinite(tdc) || tdc < 0) {
    throw new Error(`TDC 数据无效: ${record.tdc}`);
  }

  return {
    version: Number(record.version ?? 1),
    mode: Number(record.mode ?? 1),
    seq: Number.isFinite(Number(record.seq)) ? Number(record.seq) : null,
    row,
    col,
    tdc,
    raw16: Number.isFinite(Number(record.raw16)) ? Number(record.raw16) : null,
    status: Number(record.status ?? 0),
  };
}
