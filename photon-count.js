import {
  FRAME_HEADER,
  PHOTON_FRAME_BYTE_LENGTH,
  PHOTON_FRAME_PAYLOAD_LENGTH,
  PHOTON_FRAME_TAIL,
  PHOTON_FRAME_HEIGHT,
  PHOTON_FRAME_WIDTH,
  PHOTON_PIXEL_COUNT,
} from "./protocol.js";

const FRAME_WIDTH = PHOTON_FRAME_WIDTH;
const FRAME_HEIGHT = PHOTON_FRAME_HEIGHT;
const PIXEL_COUNT = PHOTON_PIXEL_COUNT;
const DEFAULT_AVERAGE_FRAME_COUNT = 10;

export const DEFAULT_NOISE_MASK_VALUES = Object.freeze([
  1, 2, 3, 4, 6, 8, 11, 12, 15, 16, 20, 24, 32, 48, 64, 96, 128, 192,
]);

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
  // rxBuffer is append-only for the lifetime of the page. Parsing advances
  // rxParseOffset; it never removes or rewrites received bytes.
  rxBuffer: new Uint8Array(0),
  rxParseOffset: 0,
  rxBytes: 0,
  lastRxDate: null,
  activeWindowUs: 10,
  rawCounts: new Uint16Array(PIXEL_COUNT),
  avgSum: new Uint32Array(PIXEL_COUNT),
  avgFrameCounter: 0,
  averageFrameCount: DEFAULT_AVERAGE_FRAME_COUNT,
  displayCounts: new Uint16Array(PIXEL_COUNT),
  noiseMaskEnabled: true,
  noiseMaskValues: new Set(DEFAULT_NOISE_MASK_VALUES),
  displayedFrameCount: 0,
  receivedFrameCount: 0,
  cells: [],
};

function numericValue(element, fallback = 0) {
  const value = Number(element.value);
  return Number.isFinite(value) ? value : fallback;
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

export function parseNoiseMaskValues(value) {
  const text = String(value ?? "").trim();
  if (!text) return new Set();

  const values = text.split(/[\s,，;；]+/).filter(Boolean).map(Number);
  if (values.some(
    (item) => !Number.isInteger(item) || item < 0 || item > 255,
  )) {
    throw new TypeError("噪声值必须是 0～255 之间的整数");
  }
  return new Set(values);
}

export function applyNoiseMask(counts, enabled, noiseValues) {
  const result = new Uint16Array(counts.length);
  const mask = noiseValues instanceof Set
    ? noiseValues
    : new Set(noiseValues ?? []);
  for (let index = 0; index < counts.length; index += 1) {
    const value = counts[index];
    result[index] = enabled && mask.has(value) ? 0 : value;
  }
  return result;
}

export function accumulateCountFrame(sum, counts) {
  if (sum.length !== counts.length) {
    throw new RangeError("累计数组长度必须与计数帧一致");
  }
  for (let index = 0; index < counts.length; index += 1) {
    sum[index] += counts[index];
  }
  return sum;
}

export function calculateAveragedCounts(sum, frameCount) {
  if (!Number.isInteger(frameCount) || frameCount <= 0) {
    throw new RangeError("平均帧数必须是正整数");
  }
  const result = new Uint16Array(sum.length);
  for (let index = 0; index < sum.length; index += 1) {
    result[index] = Math.round(sum[index] / frameCount);
  }
  return result;
}

export function decodePhotonPayload(payload) {
  if (!(payload instanceof Uint8Array)
      || payload.length !== PHOTON_FRAME_PAYLOAD_LENGTH) {
    throw new RangeError("光子计数 payload 必须恰好为 2048 字节");
  }

  const counts = new Uint16Array(PIXEL_COUNT);
  for (let pixelIndex = 0; pixelIndex < PIXEL_COUNT; pixelIndex += 1) {
    const byteIndex = pixelIndex * 2;
    const word = (payload[byteIndex] << 8) | payload[byteIndex + 1];
    counts[pixelIndex] = word & 0xff;
  }
  return counts;
}

export function appendRxBytes(rxBuffer, incomingBytes) {
  const existing = rxBuffer instanceof Uint8Array
    ? rxBuffer
    : new Uint8Array(rxBuffer ?? 0);
  const incoming = incomingBytes instanceof Uint8Array
    ? incomingBytes
    : new Uint8Array(incomingBytes ?? 0);
  const combined = new Uint8Array(existing.length + incoming.length);
  combined.set(existing);
  combined.set(incoming, existing.length);
  return combined;
}

export function scanPhotonCountFrames(rxBuffer, startOffset = 0) {
  if (!(rxBuffer instanceof Uint8Array)) {
    throw new TypeError("rxBuffer 必须是 Uint8Array");
  }

  const frames = [];
  let cursor = Math.max(0, Math.min(rxBuffer.length, startOffset));

  while (cursor + 1 < rxBuffer.length) {
    let headerOffset = -1;
    for (let index = cursor; index + 1 < rxBuffer.length; index += 1) {
      if (rxBuffer[index] === FRAME_HEADER[0]
          && rxBuffer[index + 1] === FRAME_HEADER[1]) {
        headerOffset = index;
        break;
      }
    }

    if (headerOffset < 0) {
      cursor = rxBuffer.at(-1) === FRAME_HEADER[0]
        ? rxBuffer.length - 1
        : rxBuffer.length;
      break;
    }

    if (rxBuffer.length - headerOffset < PHOTON_FRAME_BYTE_LENGTH) {
      cursor = headerOffset;
      break;
    }

    const tailOffset = headerOffset + PHOTON_FRAME_BYTE_LENGTH - 1;
    if (rxBuffer[tailOffset] !== PHOTON_FRAME_TAIL) {
      cursor = headerOffset + 1;
      continue;
    }

    frames.push(
      rxBuffer.slice(
        headerOffset + FRAME_HEADER.length,
        headerOffset + FRAME_HEADER.length + PHOTON_FRAME_PAYLOAD_LENGTH,
      ),
    );
    cursor = headerOffset + PHOTON_FRAME_BYTE_LENGTH;
  }

  return { frames, nextOffset: cursor };
}

function updateAverageProgress() {
  elements.averageProgress.textContent =
    `平均进度：${state.avgFrameCounter}/${state.averageFrameCount}`;
}

function applyCompletePayload(payload) {
  state.rawCounts = decodePhotonPayload(payload);
  state.receivedFrameCount += 1;
  accumulateCountFrame(state.avgSum, state.rawCounts);
  state.avgFrameCounter += 1;

  if (state.avgFrameCounter < state.averageFrameCount) {
    updateAverageProgress();
    renderMetrics();
    return;
  }

  const averaged = calculateAveragedCounts(
    state.avgSum,
    state.averageFrameCount,
  );
  state.displayCounts = applyNoiseMask(
    averaged,
    state.noiseMaskEnabled,
    state.noiseMaskValues,
  );
  state.avgSum.fill(0);
  state.avgFrameCounter = 0;
  state.displayedFrameCount += 1;
  updateAverageProgress();
  renderAll();
}

function processPhotonSerialBytes(bytes) {
  state.rxBuffer = appendRxBytes(state.rxBuffer, bytes);
  const result = scanPhotonCountFrames(state.rxBuffer, state.rxParseOffset);
  state.rxParseOffset = result.nextOffset;
  for (const payload of result.frames) applyCompletePayload(payload);
  return result.frames.length;
}

function createMatrix() {
  const fragment = document.createDocumentFragment();
  for (let row = 0; row < FRAME_HEIGHT; row += 1) {
    for (let col = 0; col < FRAME_WIDTH; col += 1) {
      const pixelIndex = row * FRAME_WIDTH + col;
      const cell = document.createElement("div");
      cell.className = "count-cell";
      cell.setAttribute("role", "gridcell");
      cell.dataset.pixelIndex = String(pixelIndex);
      cell.dataset.row = String(row);
      cell.dataset.col = String(col);
      cell.textContent = "0";
      cell.title = `R${row}C${col}: 0`;
      state.cells[pixelIndex] = cell;
      fragment.append(cell);
    }
  }
  elements.countMatrix.append(fragment);
}

function renderMatrix() {
  for (let pixelIndex = 0; pixelIndex < PIXEL_COUNT; pixelIndex += 1) {
    const count = state.displayCounts[pixelIndex];
    const row = Math.floor(pixelIndex / FRAME_WIDTH);
    const col = pixelIndex % FRAME_WIDTH;
    const cell = state.cells[pixelIndex];
    cell.textContent = String(count);
    cell.title = `R${row}C${col}: ${count}`;
    cell.setAttribute("aria-label", `R${row}C${col} 光子计数 ${count}`);
  }
}

function renderMetrics() {
  let total = 0;
  let maximum = 0;
  let maximumIndex = 0;
  for (let index = 0; index < PIXEL_COUNT; index += 1) {
    const value = state.displayCounts[index];
    total += value;
    if (value > maximum) {
      maximum = value;
      maximumIndex = index;
    }
  }

  elements.frameCount.textContent =
    state.displayedFrameCount.toLocaleString("zh-CN");
  elements.frameCountDetail.textContent =
    `已解析 ${state.receivedFrameCount.toLocaleString("zh-CN")} 个固定帧`;
  elements.windowMetric.textContent = formatNumber(state.activeWindowUs);
  elements.totalCount.textContent = total.toLocaleString("zh-CN");
  elements.maxCount.textContent = String(maximum);
  elements.maxPixel.textContent =
    `R${Math.floor(maximumIndex / FRAME_WIDTH)}C${maximumIndex % FRAME_WIDTH}`;
  elements.averageCount.textContent = (total / PIXEL_COUNT).toFixed(2);
  elements.rxBytes.textContent = formatBytes(state.rxBytes);
  elements.lastRxLabel.textContent = state.lastRxDate
    ? `最近 ${timeLabel(state.lastRxDate)}`
    : "尚未收到输入";
}

function renderAll() {
  renderMatrix();
  renderMetrics();
}

function updateWindowCommandPreview() {
  const windowUs = numericValue(elements.countWindowUs, state.activeWindowUs);
  elements.windowCommandPreview.textContent =
    `SET_COUNT_WINDOW ${windowUs.toFixed(3)}us`;
}

function updateAverageFrameCount(showConfirmation = false) {
  const frameCount = numericValue(elements.averageFrameCount, NaN);
  if (!Number.isInteger(frameCount) || frameCount < 1 || frameCount > 100) {
    elements.averageFrameCount.value = String(state.averageFrameCount);
    showToast("显示平均帧数必须是 1～100 之间的整数", "error");
    return;
  }

  state.averageFrameCount = frameCount;
  state.avgSum.fill(0);
  state.avgFrameCounter = 0;
  updateAverageProgress();
  if (showConfirmation) {
    showToast(`显示平均帧数已设为 ${frameCount}`, "success");
  }
}

function updateNoiseMask(showConfirmation = false) {
  let values;
  try {
    values = parseNoiseMaskValues(elements.noiseMaskValues.value);
  } catch (error) {
    showToast(error.message, "error");
    return false;
  }

  state.noiseMaskEnabled = elements.noiseMaskEnabled.checked;
  state.noiseMaskValues = values;
  if (showConfirmation) {
    showToast(
      state.noiseMaskEnabled ? "噪声值屏蔽设置已更新" : "噪声值屏蔽已关闭",
      "success",
    );
  }
  return true;
}

function setConnectionState(connected) {
  state.connected = connected;
  elements.connectionBadge.classList.toggle("online", connected);
  elements.connectionBadge.querySelector("small").textContent =
    connected ? "已连接" : "未连接";
  elements.connectBtn.disabled = connected;
  elements.disconnectBtn.disabled = !connected;
  elements.sendWindowBtn.disabled = !connected;
  elements.baudRate.disabled = connected;
  if (!connected) {
    // Do not join an incomplete frame from an old serial session to bytes
    // received after reconnecting. The raw buffer itself remains untouched.
    state.rxParseOffset = state.rxBuffer.length;
  }
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
    renderMetrics();
    showToast("计数窗口命令已发送", "success");
  } catch (error) {
    showToast(`计数窗口命令发送失败：${error.message}`, "error");
  } finally {
    writer?.releaseLock();
  }
}

function hex4(value) {
  return `0x${Number(value).toString(16).toUpperCase().padStart(4, "0")}`;
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
      state.lastRxDate = new Date();
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
  const port = state.port;
  setConnectionState(false);
  try {
    await state.reader?.cancel();
  } catch {
    // The stream may already be closed by the device.
  }
  try {
    await port?.close();
  } catch {
    // The device may disappear before close completes.
  }
  state.port = null;
  elements.portInfo.textContent = "等待设备";
}

function clearData() {
  // Keep every raw RX byte, but start count processing at the next new frame.
  state.rxParseOffset = state.rxBuffer.length;
  state.rawCounts.fill(0);
  state.avgSum.fill(0);
  state.avgFrameCounter = 0;
  state.displayCounts.fill(0);
  state.displayedFrameCount = 0;
  state.receivedFrameCount = 0;
  state.rxBytes = 0;
  state.lastRxDate = null;
  updateAverageProgress();
  renderAll();
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

function exportDataCsv() {
  const rows = [["row", "col", "count"]];
  for (let row = 0; row < FRAME_HEIGHT; row += 1) {
    for (let col = 0; col < FRAME_WIDTH; col += 1) {
      rows.push([row, col, state.displayCounts[row * FRAME_WIDTH + col]]);
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

function bindEvents() {
  elements.connectBtn.addEventListener("click", connectSerial);
  elements.disconnectBtn.addEventListener("click", disconnectSerial);
  elements.countWindowUs.addEventListener("input", updateWindowCommandPreview);
  elements.sendWindowBtn.addEventListener("click", sendCountWindowCommand);
  elements.averageFrameCount.addEventListener(
    "change",
    () => updateAverageFrameCount(true),
  );
  elements.noiseMaskEnabled.addEventListener(
    "change",
    () => updateNoiseMask(true),
  );
  elements.noiseMaskValues.addEventListener(
    "change",
    () => updateNoiseMask(true),
  );
  elements.clearDataBtn.addEventListener("click", clearData);
  elements.exportDataBtn.addEventListener("click", exportDataCsv);

  if ("serial" in navigator) {
    navigator.serial.addEventListener("disconnect", (event) => {
      if (event.port !== state.port) return;
      state.port = null;
      setConnectionState(false);
      elements.portInfo.textContent = "设备已拔出";
    });
  }
}

function initialize() {
  elements.serialSupport.textContent = "serial" in navigator
    ? "Web Serial 可用"
    : "请使用桌面版 Chrome / Edge";
  elements.serialSupport.style.color = "serial" in navigator
    ? "var(--green)"
    : "var(--amber)";
  createMatrix();
  bindEvents();
  updateWindowCommandPreview();
  updateAverageFrameCount();
  updateNoiseMask();
  setConnectionState(false);
  renderAll();
}

if (typeof document !== "undefined" && elements.countMatrix) initialize();
