import {
  buildPhotonCountFrame,
  decodePhotonCountWord,
  extractPhotonCountFrames,
  gaussianRandom,
  PHOTON_FRAME_HEIGHT,
  PHOTON_FRAME_PAYLOAD_LENGTH,
  PHOTON_FRAME_WIDTH,
  PHOTON_PIXEL_COUNT,
  wrapPhotonCounter,
} from "./protocol.js";

const FRAME_WIDTH = PHOTON_FRAME_WIDTH;
const FRAME_HEIGHT = PHOTON_FRAME_HEIGHT;
const PIXEL_COUNT = PHOTON_PIXEL_COUNT;
const REAL_RX_HOLD_MS = 400;
const UI_REFRESH_INTERVAL_MS = 100;
const MAX_TEXT_CHARS = 50000;

const elements = typeof document === "undefined"
  ? {}
  : Object.fromEntries(
    [...document.querySelectorAll("[id]")].map((element) => [element.id, element]),
  );

const state = {
  port: null,
  reader: null,
  connected: false,
  reading: false,
  hardwareInputDetected: false,
  acquisitionPaused: false,
  rxIdleTimer: null,
  renderTimer: null,
  rxFrameBuffer: new Uint8Array(0),
  rxBytes: 0,
  lastRxAt: 0,
  lastFrameAt: 0,
  lastRxDate: null,
  frameCount: 0,
  activeWindowUs: 10,
  counts: new Uint16Array(PIXEL_COUNT),
  overflowBits: new Uint8Array(PIXEL_COUNT),
  latestDecodedWords: [],
  badPixelMask: new Uint8Array(PIXEL_COUNT),
  badPixelCount: 0,
  badPixelConfigReady: false,
  fixedSpatialField: new Float32Array(PIXEL_COUNT),
  scenePhotonRate: new Float32Array(PIXEL_COUNT),
  dynamicSpatialField: new Float32Array(PIXEL_COUNT),
  sceneRevision: 0,
  nextSpatialUpdateFrame: 0,
  localEvents: [],
  actualText: "",
  simulatedText: "",
  viewMode: "numeric",
  cells: [],
};

function numericValue(element, fallback = 0) {
  const value = Number(element.value);
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function randomRange(minimum, maximum) {
  return minimum + Math.random() * (maximum - minimum);
}

function formatNumber(value, digits = 3) {
  if (!Number.isFinite(value)) return "--";
  return value.toFixed(digits).replace(/\.?0+$/, "");
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
}

function timeLabel(date = new Date()) {
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

function showToast(message, type = "") {
  const toast = document.createElement("div");
  toast.className = `toast ${type}`.trim();
  toast.textContent = message;
  elements.toastContainer.append(toast);
  window.setTimeout(() => toast.remove(), 3000);
}

function appendActualText(content) {
  state.actualText += content;
  if (state.actualText.length > MAX_TEXT_CHARS) {
    state.actualText = state.actualText.slice(-MAX_TEXT_CHARS);
  }
  elements.actualSerialData.value = state.actualText;
  elements.actualSerialData.scrollTop = elements.actualSerialData.scrollHeight;
}

function appendActualRx(bytes) {
  const hex = [...bytes]
    .map((byte) => byte.toString(16).toUpperCase().padStart(2, "0"))
    .join(" ");
  const ascii = new TextDecoder().decode(bytes).replace(/[^\x20-\x7e]/g, ".");
  appendActualText(
    `[${timeLabel()}] RX  ${hex}${ascii ? `  | ${ascii}` : ""}\n`,
  );
}

function scheduleRealInputIdle() {
  if (state.rxIdleTimer) window.clearTimeout(state.rxIdleTimer);
  state.rxIdleTimer = window.setTimeout(() => {
    state.rxIdleTimer = null;
    if (performance.now() - state.lastFrameAt < REAL_RX_HOLD_MS) return;
    state.hardwareInputDetected = false;
    updateAcquisitionState();
  }, REAL_RX_HOLD_MS);
}

function applyPhotonCountFrame(dataBytes) {
  if (state.acquisitionPaused
      || dataBytes.length !== PHOTON_FRAME_PAYLOAD_LENGTH) return false;

  const decodedWords = new Array(PIXEL_COUNT);
  for (let index = 0; index < PIXEL_COUNT; index += 1) {
    const byteIndex = index * 2;
    const word = (dataBytes[byteIndex] << 8) | dataBytes[byteIndex + 1];
    const decoded = decodePhotonCountWord(word);
    decodedWords[index] = decoded;
    state.counts[index] = decoded.count;
    state.overflowBits[index] = decoded.overflowBits;
  }
  state.latestDecodedWords = decodedWords;
  state.frameCount += 1;
  state.lastFrameAt = performance.now();
  state.hardwareInputDetected = true;

  const frame = buildPhotonCountFrame(state.counts);
  state.simulatedText =
    `[${timeLabel()}] FRAME ${String(state.frameCount).padStart(6, "0")}`
    + ` · ${FRAME_WIDTH}×${FRAME_HEIGHT} · ${decodedWords.length} POINTS\n`
    + `${frame.text}\n`;
  updateAcquisitionState();
  scheduleRealInputIdle();
  scheduleRender();
  return true;
}

function processPhotonSerialBytes(bytes) {
  const result = extractPhotonCountFrames(state.rxFrameBuffer, bytes);
  state.rxFrameBuffer = result.remainder;
  let parsedFrames = 0;
  for (const dataBytes of result.frames) {
    if (applyPhotonCountFrame(dataBytes)) parsedFrames += 1;
  }
  return parsedFrames;
}

function appendActualTx(command) {
  appendActualText(`[${timeLabel()}] TX  ${command.trim()}\n`);
}

function updateWindowCommandPreview() {
  const windowUs = numericValue(elements.countWindowUs, state.activeWindowUs);
  elements.windowCommandPreview.textContent =
    `SET_COUNT_WINDOW ${windowUs.toFixed(3)}us`;
}

async function loadBadPixelConfig() {
  const response = await fetch("./bad-pixels.json", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`坏点配置读取失败（HTTP ${response.status}）`);
  }

  const config = await response.json();
  if (config.array?.rows !== 32 || config.array?.columns !== 32) {
    throw new Error("坏点配置的阵列尺寸必须为 32 × 32");
  }
  if (!Array.isArray(config.pixels)
      || config.pixels.length !== config.badPixelCount) {
    throw new Error("坏点配置数量与 badPixelCount 不一致");
  }

  const mask = new Uint8Array(PIXEL_COUNT);
  for (const coordinate of config.pixels) {
    if (!Array.isArray(coordinate) || coordinate.length !== 2) {
      throw new Error("坏点坐标格式必须为 [row, col]");
    }
    const [row, col] = coordinate;
    if (!Number.isInteger(row) || !Number.isInteger(col)
        || row < 0 || row >= 32 || col < 0 || col >= 32) {
      throw new Error(`坏点坐标越界：${JSON.stringify(coordinate)}`);
    }
    const index = row * 32 + col;
    if (mask[index]) {
      throw new Error(`坏点坐标重复：R${row}C${col}`);
    }
    mask[index] = 1;
  }

  const loadedCount = mask.reduce((sum, value) => sum + value, 0);
  if (loadedCount !== 142) {
    throw new Error(`坏点数量必须为 142，当前为 ${loadedCount}`);
  }

  state.badPixelMask.set(mask);
  state.badPixelCount = loadedCount;
  state.badPixelConfigReady = true;
  document.documentElement.dataset.badPixelCount = String(loadedCount);
}

function applyBadPixelMask(counts) {
  for (let index = 0; index < PIXEL_COUNT; index += 1) {
    if (state.badPixelMask[index]) counts[index] = 0;
  }
  return counts;
}

function createMatrix() {
  const fragment = document.createDocumentFragment();
  for (let row = 0; row < 32; row += 1) {
    for (let col = 0; col < 32; col += 1) {
      const cell = document.createElement("div");
      cell.className = "count-cell";
      cell.classList.toggle(
        "bad-pixel",
        Boolean(state.badPixelMask[row * 32 + col]),
      );
      cell.setAttribute("role", "gridcell");
      cell.dataset.row = String(row);
      cell.dataset.col = String(col);
      cell.textContent = "0";
      cell.title = `R${row}C${col}: 0`;
      state.cells.push(cell);
      fragment.append(cell);
    }
  }
  elements.countMatrix.append(fragment);
}

function renderMatrix() {
  for (let index = 0; index < PIXEL_COUNT; index += 1) {
    const count = state.counts[index];
    const cell = state.cells[index];
    const row = Math.floor(index / 32);
    const col = index % 32;
    cell.textContent = String(count);
    cell.title = `R${row}C${col}: ${count}`;
    cell.setAttribute("aria-label", `R${row}C${col} 光子计数 ${count}`);
    const grayscale = count;
    cell.style.backgroundColor = state.viewMode === "image"
      ? `rgb(${grayscale}, ${grayscale}, ${grayscale})`
      : "";
  }
}

function renderMetrics() {
  let total = 0;
  let maximum = 0;
  let maximumIndex = 0;
  for (let index = 0; index < PIXEL_COUNT; index += 1) {
    const value = state.counts[index];
    total += value;
    if (value > maximum) {
      maximum = value;
      maximumIndex = index;
    }
  }
  elements.frameCount.textContent = state.frameCount.toLocaleString("zh-CN");
  elements.windowMetric.textContent = formatNumber(state.activeWindowUs);
  elements.totalCount.textContent = total.toLocaleString("zh-CN");
  elements.maxCount.textContent = String(maximum);
  elements.maxPixel.textContent =
    `R${Math.floor(maximumIndex / 32)}C${maximumIndex % 32}`;
  elements.averageCount.textContent = (total / PIXEL_COUNT).toFixed(2);
  elements.rxBytes.textContent = formatBytes(state.rxBytes);
  elements.actualByteCount.textContent = `RX ${formatBytes(state.rxBytes)}`;
  elements.lastRxLabel.textContent = state.lastRxDate
    ? `最近 ${timeLabel(state.lastRxDate)}`
    : "尚未收到输入";
  elements.simulatedFrameCount.textContent =
    `${state.frameCount.toLocaleString("zh-CN")} 帧`;
}

function renderAll() {
  renderMatrix();
  renderMetrics();
  elements.simulatedSerialData.value = state.simulatedText;
  elements.simulatedSerialData.scrollTop =
    elements.simulatedSerialData.scrollHeight;
}

function scheduleRender() {
  if (state.renderTimer) return;
  state.renderTimer = window.setTimeout(() => {
    state.renderTimer = null;
    renderAll();
  }, UI_REFRESH_INTERVAL_MS);
}

function updateAcquisitionState() {
  elements.acquisitionState.classList.remove(
    "waiting",
    "running",
    "paused",
    "disconnected",
  );
  if (!state.connected) {
    elements.acquisitionState.classList.add("disconnected");
    elements.acquisitionStateLabel.textContent = "未连接";
  } else if (state.acquisitionPaused) {
    elements.acquisitionState.classList.add("paused");
    elements.acquisitionStateLabel.textContent = "采集已暂停";
  } else if (state.hardwareInputDetected) {
    elements.acquisitionState.classList.add("running");
    elements.acquisitionStateLabel.textContent = "正在采集";
  } else {
    elements.acquisitionState.classList.add("waiting");
    elements.acquisitionStateLabel.textContent = "等待串口数据";
  }
  elements.pauseAcquisitionBtn.textContent = state.acquisitionPaused
    ? "继续采集"
    : "暂停采集";
  elements.pauseAcquisitionBtn.classList.toggle(
    "primary",
    state.acquisitionPaused,
  );
}

function normalizeField(field) {
  let sum = 0;
  let sumSquares = 0;
  for (const value of field) {
    sum += value;
    sumSquares += value * value;
  }
  const mean = sum / PIXEL_COUNT;
  const standardDeviation = Math.sqrt(
    Math.max(0.0001, sumSquares / PIXEL_COUNT - mean * mean),
  );
  for (let index = 0; index < PIXEL_COUNT; index += 1) {
    field[index] = (field[index] - mean) / standardDeviation;
  }
  return field;
}

function createCorrelatedField(passes = 4) {
  let current = Float32Array.from(
    { length: PIXEL_COUNT },
    () => gaussianRandom(),
  );

  for (let pass = 0; pass < passes; pass += 1) {
    const next = new Float32Array(PIXEL_COUNT);
    for (let row = 0; row < 32; row += 1) {
      for (let col = 0; col < 32; col += 1) {
        let sum = 0;
        let weightSum = 0;
        for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
          for (let colOffset = -1; colOffset <= 1; colOffset += 1) {
            const sampleRow = clamp(row + rowOffset, 0, 31);
            const sampleCol = clamp(col + colOffset, 0, 31);
            const weight = rowOffset === 0 && colOffset === 0 ? 4
              : rowOffset === 0 || colOffset === 0 ? 2 : 1;
            sum += current[sampleRow * 32 + sampleCol] * weight;
            weightSum += weight;
          }
        }
        next[row * 32 + col] = sum / weightSum;
      }
    }
    current = next;
  }

  return normalizeField(current);
}

function createMultiscaleField() {
  const coarse = createCorrelatedField(Math.round(randomRange(4, 7)));
  const medium = createCorrelatedField(Math.round(randomRange(1, 3)));
  const fine = createCorrelatedField(0);
  const field = new Float32Array(PIXEL_COUNT);
  const coarseWeight = randomRange(0.55, 0.85);
  const mediumWeight = randomRange(0.35, 0.65);
  const fineWeight = randomRange(0.08, 0.2);

  for (let index = 0; index < PIXEL_COUNT; index += 1) {
    field[index] = coarse[index] * coarseWeight
      + medium[index] * mediumWeight
      + fine[index] * fineWeight
      + coarse[index] * medium[index] * 0.12;
  }
  return normalizeField(field);
}

function ellipticalSignal(row, col, options) {
  const cosine = Math.cos(options.angle);
  const sine = Math.sin(options.angle);
  const deltaX = col - options.centerX;
  const deltaY = row - options.centerY;
  const rotatedX = deltaX * cosine + deltaY * sine;
  const rotatedY = -deltaX * sine + deltaY * cosine;
  return options.amplitude * Math.exp(
    -0.5 * (
      (rotatedX / options.sigmaX) ** 2
      + (rotatedY / options.sigmaY) ** 2
    ),
  );
}

export function configurePhotonScene(windowUs) {
  state.activeWindowUs = windowUs;
  const coarse = createMultiscaleField();
  const medium = createCorrelatedField(Math.round(randomRange(1, 3)));
  const fine = createCorrelatedField(0);
  const exposureBand = Math.log2(Math.max(0.1, windowUs) / 10);
  const gradientAngle = randomRange(0, Math.PI * 2);
  const gradientStrength = randomRange(5, 20);
  const structures = Array.from(
    { length: Math.round(randomRange(3, 7)) },
    () => ({
      centerX: randomRange(-3, 35),
      centerY: randomRange(-3, 35),
      sigmaX: randomRange(1.7, 8.5),
      sigmaY: randomRange(1.4, 7.2),
      angle: randomRange(-Math.PI, Math.PI),
      amplitude: randomRange(35, 145),
      polarity: Math.random() < 0.2 ? -1 : 1,
    }),
  );

  for (let row = 0; row < 32; row += 1) {
    for (let col = 0; col < 32; col += 1) {
      const index = row * 32 + col;
      const projection = (
        (col - 15.5) * Math.cos(gradientAngle)
        + (row - 15.5) * Math.sin(gradientAngle)
      ) / 22;
      let structure = 0;
      for (const item of structures) {
        structure += ellipticalSignal(row, col, item)
          * item.polarity
          * clamp(1 + medium[index] * 0.24, 0.35, 1.7);
      }

      const exposureResponse = exposureBand * (
        4.5 * medium[index]
        + 2.5 * coarse[index] * fine[index]
      );
      state.scenePhotonRate[index] = Math.max(
        0.5,
        35
          + coarse[index] * 27
          + medium[index] * 13
          + fine[index] * 3
          + projection * gradientStrength
          + structure
          + exposureResponse,
      );
    }
  }

  state.dynamicSpatialField.set(createMultiscaleField());
  state.localEvents = [];
  state.nextSpatialUpdateFrame = Math.round(randomRange(3, 12));
  state.sceneRevision += 1;
  if (typeof document !== "undefined") {
    document.documentElement.dataset.sceneRevision = String(state.sceneRevision);
  }
}

function updateDynamicSpatialField(frameNumber) {
  if (frameNumber < state.nextSpatialUpdateFrame) return;

  const target = createMultiscaleField();
  const patches = Array.from(
    { length: Math.round(randomRange(1, 4)) },
    () => ({
      row: randomRange(0, 31),
      col: randomRange(0, 31),
      radius: randomRange(4, 13),
      strength: randomRange(0.12, 0.42),
    }),
  );

  for (let row = 0; row < 32; row += 1) {
    for (let col = 0; col < 32; col += 1) {
      const index = row * 32 + col;
      let localBlend = randomRange(0.003, 0.012);
      for (const patch of patches) {
        const distanceSquared = (row - patch.row) ** 2 + (col - patch.col) ** 2;
        localBlend += patch.strength * Math.exp(
          -distanceSquared / (2 * patch.radius ** 2),
        );
      }
      const blend = clamp(localBlend, 0, 0.55);
      state.dynamicSpatialField[index] =
        state.dynamicSpatialField[index] * (1 - blend)
        + target[index] * blend;
    }
  }
  normalizeField(state.dynamicSpatialField);
  state.nextSpatialUpdateFrame =
    frameNumber + Math.round(randomRange(3, 15));
}

function updateLocalEvents() {
  state.localEvents = state.localEvents.filter((event) => {
    event.age += 1;
    event.centerX += event.velocityX;
    event.centerY += event.velocityY;
    event.velocityX = event.velocityX * 0.78 + gaussianRandom() * 0.035;
    event.velocityY = event.velocityY * 0.78 + gaussianRandom() * 0.035;
    return event.age < event.life;
  });

  if (Math.random() < 0.2 && state.localEvents.length < 8) {
    state.localEvents.push({
      centerX: randomRange(0, 31),
      centerY: randomRange(0, 31),
      sigmaX: randomRange(0.8, 4.8),
      sigmaY: randomRange(0.8, 4.8),
      angle: randomRange(-Math.PI, Math.PI),
      amplitude: randomRange(-38, 72),
      age: 0,
      life: Math.round(randomRange(3, 24)),
      velocityX: gaussianRandom() * 0.09,
      velocityY: gaussianRandom() * 0.09,
    });
  }
}

function localEventSignal(row, col) {
  let signal = 0;
  for (const event of state.localEvents) {
    const progress = event.age / event.life;
    const envelope = Math.sin(Math.PI * progress) ** 0.7;
    signal += ellipticalSignal(row, col, event) * envelope;
  }
  return signal;
}

function samplePhotonCounter(expectedCount) {
  if (expectedCount < 24) {
    const limit = Math.exp(-expectedCount);
    let product = 1;
    let count = 0;
    do {
      count += 1;
      product *= Math.random();
    } while (product > limit);
    return Math.max(0, count - 1);
  }
  return Math.max(
    0,
    Math.round(expectedCount + gaussianRandom() * Math.sqrt(expectedCount)),
  );
}

export function generatePhotonCounts(frameNumber) {
  const counts = new Uint16Array(PIXEL_COUNT);
  const exposureScale = state.activeWindowUs / 10;
  updateDynamicSpatialField(frameNumber);
  updateLocalEvents();
  const rowNoise = Float32Array.from(
    { length: 32 },
    () => gaussianRandom() * randomRange(0.6, 2.3),
  );
  const columnNoise = Float32Array.from(
    { length: 32 },
    () => gaussianRandom() * randomRange(0.4, 1.7),
  );
  const frameGain = clamp(1 + gaussianRandom() * 0.012, 0.96, 1.04);
  const instantaneousField = createCorrelatedField(
    Math.random() < 0.62 ? 1 : 2,
  );

  for (let row = 0; row < 32; row += 1) {
    for (let col = 0; col < 32; col += 1) {
      const index = row * 32 + col;
      const fixedField = state.fixedSpatialField[index];
      const dynamicField = state.dynamicSpatialField[index];
      const expectedCount = Math.max(
        0,
        (
          state.scenePhotonRate[index]
          * clamp(1 + fixedField * 0.11, 0.5, 1.55)
          + dynamicField * (4 + Math.sqrt(state.scenePhotonRate[index]) * 0.7)
          + instantaneousField[index]
            * (7 + Math.sqrt(state.scenePhotonRate[index]) * 1.35)
          + localEventSignal(row, col)
          + rowNoise[row]
          + columnNoise[col]
        ) * exposureScale * frameGain,
      );
      counts[index] = wrapPhotonCounter(
        samplePhotonCounter(expectedCount)
          + (Math.random() < 0.0009 ? randomRange(30, 120) : 0),
      );
    }
  }
  return applyBadPixelMask(counts);
}

function setConnectionState(connected) {
  state.connected = connected;
  elements.connectionBadge.classList.toggle("online", connected);
  elements.connectionBadge.querySelector("small").textContent =
    connected ? "已连接" : "未连接";
  elements.connectBtn.disabled = connected || !state.badPixelConfigReady;
  elements.disconnectBtn.disabled = !connected;
  elements.sendWindowBtn.disabled = !connected;
  elements.pauseAcquisitionBtn.disabled = !connected;
  elements.baudRate.disabled = connected;
  if (!connected) {
    state.lastRxAt = 0;
    state.lastFrameAt = 0;
    state.hardwareInputDetected = false;
    state.acquisitionPaused = false;
    state.rxFrameBuffer = new Uint8Array(0);
    if (state.rxIdleTimer) {
      window.clearTimeout(state.rxIdleTimer);
      state.rxIdleTimer = null;
    }
  }
  updateAcquisitionState();
}

function toggleAcquisitionPause() {
  if (!state.connected) return;

  state.acquisitionPaused = !state.acquisitionPaused;
  if (state.acquisitionPaused) {
    updateAcquisitionState();
    showToast("采集已暂停");
    return;
  }

  const inputIsFresh = state.lastFrameAt > 0
    && performance.now() - state.lastFrameAt <= REAL_RX_HOLD_MS;
  state.hardwareInputDetected = false;
  updateAcquisitionState();
  showToast(inputIsFresh ? "采集已继续" : "已继续，等待串口数据", "success");
}

async function sendCountWindowCommand() {
  if (!state.connected || !state.port?.writable) {
    showToast("请先连接串口", "error");
    return;
  }

  const windowUs = numericValue(elements.countWindowUs, NaN);
  if (!Number.isFinite(windowUs) || windowUs < 0.1 || windowUs > 1000000) {
    showToast("计数窗口应在 0.1～1000000 μs 之间", "error");
    return;
  }

  const command = `SET_COUNT_WINDOW ${windowUs.toFixed(3)}us\r\n`;
  let writer;
  try {
    writer = state.port.writable.getWriter();
    await writer.write(new TextEncoder().encode(command));
    state.activeWindowUs = windowUs;
    elements.activeWindowLabel.textContent = `${formatNumber(windowUs)} μs`;
    appendActualTx(command);
    renderMetrics();
    showToast("计数窗口命令已发送", "success");
  } catch (error) {
    showToast(`计数窗口命令发送失败：${error.message}`, "error");
  } finally {
    writer?.releaseLock();
  }
}

async function connectSerial() {
  if (!("serial" in navigator)) {
    showToast("当前浏览器不支持 Web Serial，请使用桌面版 Chrome 或 Edge。", "error");
    return;
  }
  try {
    const port = await navigator.serial.requestPort();
    await port.open({
      baudRate: numericValue(elements.baudRate, 921600),
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      flowControl: "none",
    });
    state.port = port;
    state.lastRxDate = null;
    const info = port.getInfo();
    elements.portInfo.textContent = info.usbVendorId
      ? `VID ${hex4(info.usbVendorId)} · PID ${hex4(info.usbProductId ?? 0)}`
      : "设备已打开";
    setConnectionState(true);
    showToast("串口连接成功", "success");
    readSerialLoop();
  } catch (error) {
    if (error.name !== "NotFoundError") {
      showToast(`串口连接失败：${error.message}`, "error");
    }
  }
}

async function readSerialLoop() {
  if (!state.port?.readable || state.reading) return;
  state.reading = true;
  state.reader = state.port.readable.getReader();
  try {
    while (state.connected) {
      const { value, done } = await state.reader.read();
      if (done) break;
      if (!value?.length) continue;
      state.rxBytes += value.byteLength;
      state.lastRxAt = performance.now();
      state.lastRxDate = new Date();
      appendActualRx(value);
      processPhotonSerialBytes(value);
      renderMetrics();
    }
  } catch (error) {
    if (state.connected) showToast(`串口读取中断：${error.message}`, "error");
  } finally {
    state.reader?.releaseLock();
    state.reader = null;
    state.reading = false;
    if (state.connected) {
      state.port = null;
      setConnectionState(false);
      elements.portInfo.textContent = "数据流已断开";
    }
  }
}

async function disconnectSerial() {
  setConnectionState(false);
  try {
    await state.reader?.cancel();
  } catch {
    // The stream can already be closed by the device.
  }
  try {
    await state.port?.close();
  } catch {
    // Ignore a device that disappeared before close completed.
  }
  state.port = null;
  elements.portInfo.textContent = "等待设备";
}

function setViewMode(mode) {
  state.viewMode = mode;
  const image = mode === "image";
  elements.numericViewBtn.classList.toggle("active", !image);
  elements.imageViewBtn.classList.toggle("active", image);
  elements.countMatrix.classList.toggle("numeric", !image);
  elements.countMatrix.classList.toggle("image", image);
  elements.matrixTitle.textContent = image
    ? "32 × 32 灰度成像"
    : "32 × 32 光子计数";
  elements.viewModeTag.textContent = image ? "灰度成像" : "计数数字";
  renderMatrix();
}

function clearData() {
  state.counts.fill(0);
  state.overflowBits.fill(0);
  state.latestDecodedWords = [];
  state.frameCount = 0;
  state.simulatedText = "";
  elements.simulatedSerialData.value = "";
  renderAll();
}

function exportDataCsv() {
  const rows = [["row", "col", "count"]];
  for (let row = 0; row < 32; row += 1) {
    for (let col = 0; col < 32; col += 1) {
      rows.push([row, col, state.counts[row * 32 + col]]);
    }
  }
  const csv = `\ufeff${rows.map((row) => row.join(",")).join("\r\n")}`;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `photon_count_${fileTimestamp()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function fileTimestamp() {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "_",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
}

function hex4(value) {
  return `0x${Number(value).toString(16).toUpperCase().padStart(4, "0")}`;
}

function bindEvents() {
  elements.connectBtn.addEventListener("click", connectSerial);
  elements.disconnectBtn.addEventListener("click", disconnectSerial);
  elements.countWindowUs.addEventListener("input", updateWindowCommandPreview);
  elements.sendWindowBtn.addEventListener("click", sendCountWindowCommand);
  elements.numericViewBtn.addEventListener("click", () => setViewMode("numeric"));
  elements.imageViewBtn.addEventListener("click", () => setViewMode("image"));
  elements.pauseAcquisitionBtn.addEventListener(
    "click",
    toggleAcquisitionPause,
  );
  elements.clearDataBtn.addEventListener("click", clearData);
  elements.clearActualBtn.addEventListener("click", () => {
    state.actualText = "";
    elements.actualSerialData.value = "";
  });
  elements.clearSimulatedBtn.addEventListener("click", () => {
    state.simulatedText = "";
    elements.simulatedSerialData.value = "";
  });
  elements.exportDataBtn.addEventListener("click", exportDataCsv);
  elements.communicationDebugTrigger.addEventListener("dblclick", () => {
    elements.actualSerialPanel.classList.toggle("is-hidden");
  });

  if ("serial" in navigator) {
    navigator.serial.addEventListener("disconnect", (event) => {
      if (event.port !== state.port) return;
      state.port = null;
      setConnectionState(false);
      elements.portInfo.textContent = "设备已拔出";
    });
  }
}

async function initialize() {
  elements.serialSupport.textContent = "serial" in navigator
    ? "Web Serial 可用"
    : "请使用桌面版 Chrome / Edge";
  elements.serialSupport.style.color = "serial" in navigator
    ? "var(--green)"
    : "var(--amber)";
  try {
    await loadBadPixelConfig();
  } catch (error) {
    elements.serialSupport.textContent = "坏点配置读取失败";
    elements.serialSupport.style.color = "var(--red)";
    elements.connectBtn.disabled = true;
    showToast(error.message, "error");
  }
  createMatrix();
  bindEvents();
  updateWindowCommandPreview();
  setConnectionState(false);
  renderAll();
}

if (typeof document !== "undefined") initialize();
