import { parseO12FirstTwoTdc } from "./protocol.js";

const DEFAULT_DISTANCE_SCALE_MM_PER_NS = 149.896229;
const MAX_TEXT_CHARS = 60000;
const MAX_RECORDS = 20000;

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
  rxBytes: 0,
  lastRxDate: null,
  textDecoder: typeof TextDecoder === "undefined" ? null : new TextDecoder(),
  lineBuffer: "",
  actualText: "",
  parsedText: "",
  latestO12: null,
  latestO12At: null,
  records: [],
  invalidFrameCount: 0,
  parseErrorCount: 0,
};

function numericValue(element, fallback = 0) {
  const value = Number(element.value);
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function formatNumber(value, digits = 5) {
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

function appendLimitedText(target, stateKey, content) {
  state[stateKey] += content;
  if (state[stateKey].length > MAX_TEXT_CHARS) {
    state[stateKey] = state[stateKey].slice(-MAX_TEXT_CHARS);
  }
  target.value = state[stateKey];
  target.scrollTop = target.scrollHeight;
}

function appendActualRx(bytes, decodedText) {
  const hex = [...bytes]
    .map((byte) => byte.toString(16).toUpperCase().padStart(2, "0"))
    .join(" ");
  const ascii = decodedText.replace(/[^\x20-\x7e]/g, ".");
  appendLimitedText(
    elements.actualSerialData,
    "actualText",
    `[${timeLabel()}] RX  ${hex}${ascii ? `  | ${ascii}` : ""}\n`,
  );
}

function appendParsedText(content) {
  appendLimitedText(elements.parsedSerialData, "parsedText", content);
}

function getFixedDelayNs() {
  return numericValue(elements.fixedDelayNs, 0);
}

function getDistanceScaleMmPerNs() {
  return clamp(
    numericValue(elements.distanceScaleMmPerNs, DEFAULT_DISTANCE_SCALE_MM_PER_NS),
    0,
    1000000,
  );
}

function correctedTofNs(record) {
  if (!record) return NaN;
  return record.averageTimeNs - getFixedDelayNs();
}

function distanceMm(record) {
  if (!record) return NaN;
  return Math.max(0, correctedTofNs(record)) * getDistanceScaleMmPerNs();
}

function distanceDisplay(mm) {
  if (!Number.isFinite(mm)) return { value: "--", unit: "m" };
  if (mm >= 1000) return { value: formatNumber(mm / 1000, 4), unit: "m" };
  return { value: formatNumber(mm, 2), unit: "mm" };
}

function pixelTimeLabel(pixel) {
  if (!pixel) return "--";
  return pixel.valid ? `${formatNumber(pixel.timeNs)} ns` : "无效";
}

function pixelWordLabel(pixel) {
  if (!pixel) return "--";
  return pixel.valid ? pixel.hex : `${pixel.hex} / 0x0003`;
}

function isO12Like(line) {
  return /(?:^|\s)(?:O\s*(?:12|1\s*\/\s*2)|CH\s*1)\s*[:=]/i.test(line);
}

function processTextChunk(text) {
  state.lineBuffer += text;
  if (state.lineBuffer.length > MAX_TEXT_CHARS) {
    state.lineBuffer = state.lineBuffer.slice(-MAX_TEXT_CHARS);
  }

  const lines = state.lineBuffer.split(/\r?\n/);
  state.lineBuffer = lines.pop() ?? "";
  for (const line of lines) {
    processTextLine(line);
  }
}

function flushLineBuffer() {
  const line = state.lineBuffer.trim();
  state.lineBuffer = "";
  if (line) processTextLine(line);
}

function processTextLine(line) {
  const text = String(line).trim();
  if (!text) return;

  let measurement;
  try {
    measurement = parseO12FirstTwoTdc(text);
  } catch (error) {
    if (isO12Like(text)) {
      state.parseErrorCount += 1;
      appendParsedText(`[${timeLabel()}] ERROR  ${error.message}\n`);
      renderAll();
    }
    return;
  }

  if (!measurement) return;
  state.latestO12 = measurement;
  state.latestO12At = new Date();

  if (!measurement.valid) {
    state.invalidFrameCount += 1;
    appendParsedText(
      `[${timeLabel()}] INVALID  O12[0] ${pixelWordLabel(measurement.pixels[0])}`
        + `  O12[1] ${pixelWordLabel(measurement.pixels[1])}\n`,
    );
    renderAll();
    return;
  }

  const record = {
    index: state.records.length + 1,
    receivedAt: new Date(),
    pixels: measurement.pixels.map((pixel) => ({ ...pixel })),
    averageTimeNs: measurement.averageTimeNs,
    line: measurement.line,
  };
  state.records.push(record);
  if (state.records.length > MAX_RECORDS) {
    state.records.splice(0, state.records.length - MAX_RECORDS);
  }

  const display = distanceDisplay(distanceMm(record));
  appendParsedText(
    `[${timeLabel(record.receivedAt)}] O12[0] ${pixelTimeLabel(record.pixels[0])}`
      + `  O12[1] ${pixelTimeLabel(record.pixels[1])}`
      + `  AVG ${formatNumber(record.averageTimeNs)} ns`
      + `  DIST ${display.value} ${display.unit}\n`,
  );
  renderAll();
}

function handleSerialBytes(bytes) {
  state.rxBytes += bytes.byteLength;
  state.lastRxDate = new Date();
  const decodedText = state.textDecoder.decode(bytes, { stream: true });
  appendActualRx(bytes, decodedText);
  processTextChunk(decodedText);
  renderMetrics();
}

function updateAcquisitionState() {
  elements.acquisitionState.classList.remove(
    "waiting",
    "running",
    "disconnected",
  );
  if (!state.connected) {
    elements.acquisitionState.classList.add("disconnected");
    elements.sampleStateLabel.textContent = "串口未连接";
    return;
  }
  if (state.latestO12) {
    elements.acquisitionState.classList.add("running");
    elements.sampleStateLabel.textContent = state.latestO12.valid
      ? "O12 有效"
      : "O12 无效";
    return;
  }
  elements.acquisitionState.classList.add("waiting");
  elements.sampleStateLabel.textContent = "等待 O12";
}

function renderMetrics() {
  const latestValid = state.records.at(-1) ?? null;
  const latestO12 = state.latestO12;
  const pixel0 = latestO12?.pixels[0] ?? latestValid?.pixels[0] ?? null;
  const pixel1 = latestO12?.pixels[1] ?? latestValid?.pixels[1] ?? null;

  elements.validSampleCount.textContent =
    state.records.length.toLocaleString("zh-CN");
  elements.averageTofMetric.textContent = latestValid
    ? formatNumber(latestValid.averageTimeNs)
    : "--";
  elements.pixel0Metric.textContent = pixelTimeLabel(pixel0).replace(" ns", "");
  elements.pixel1Metric.textContent = pixelTimeLabel(pixel1).replace(" ns", "");
  elements.pixel0Word.textContent = pixelWordLabel(pixel0);
  elements.pixel1Word.textContent = pixelWordLabel(pixel1);
  elements.invalidFrameCount.textContent =
    state.invalidFrameCount.toLocaleString("zh-CN");
  elements.parseErrorCount.textContent =
    `解析错误 ${state.parseErrorCount.toLocaleString("zh-CN")}`;
  elements.rxBytes.textContent = formatBytes(state.rxBytes);
  elements.actualByteCount.textContent = `RX ${formatBytes(state.rxBytes)}`;
  elements.lastRxLabel.textContent = state.lastRxDate
    ? `最近 ${timeLabel(state.lastRxDate)}`
    : "尚未收到输入";
  elements.parsedFrameCount.textContent =
    `${state.records.length.toLocaleString("zh-CN")} 条有效样本`;
}

function renderRangeReadout() {
  const latestValid = state.records.at(-1) ?? null;
  const latestO12 = state.latestO12;
  const pixel0 = latestO12?.pixels[0] ?? latestValid?.pixels[0] ?? null;
  const pixel1 = latestO12?.pixels[1] ?? latestValid?.pixels[1] ?? null;
  const display = distanceDisplay(distanceMm(latestValid));
  const corrected = correctedTofNs(latestValid);

  elements.distanceValue.textContent = display.value;
  elements.distanceUnit.textContent = display.unit;
  elements.pixel0Tof.textContent = pixelTimeLabel(pixel0);
  elements.pixel1Tof.textContent = pixelTimeLabel(pixel1);
  elements.pixel0Raw.textContent = pixelWordLabel(pixel0);
  elements.pixel1Raw.textContent = pixelWordLabel(pixel1);

  if (!latestO12) {
    elements.measurementStatus.textContent = "等待数据";
    elements.distanceDetail.textContent = "等待 O12 前两个像素的有效 TDC 数据";
    elements.lastLineLabel.textContent = "尚未解析 O12";
  } else if (!latestO12.valid) {
    elements.measurementStatus.textContent = "O12 无效";
    elements.distanceDetail.textContent = latestValid
      ? "最新 O12 含无效像素，距离保持上一条有效样本"
      : "最新 O12 含无效像素，暂无有效距离";
    elements.lastLineLabel.textContent = `最近 ${timeLabel(state.latestO12At)}`;
  } else {
    elements.measurementStatus.textContent = "实时更新";
    elements.distanceDetail.textContent =
      `校正后 TOF ${formatNumber(Math.max(0, corrected))} ns`;
    elements.lastLineLabel.textContent = `最近 ${timeLabel(state.latestO12At)}`;
  }
}

function renderRecentTable() {
  const records = state.records.slice(-12).reverse();
  if (!records.length) {
    elements.recentDataBody.innerHTML =
      '<tr class="empty-row"><td colspan="6">暂无 O12 测距样本</td></tr>';
    return;
  }

  const fixedDelay = getFixedDelayNs();
  elements.recentDataBody.innerHTML = records.map((record) => {
    const display = distanceDisplay(distanceMm(record));
    return `
      <tr>
        <td>${timeLabel(record.receivedAt)}</td>
        <td>${formatNumber(record.pixels[0].timeNs)} ns</td>
        <td>${formatNumber(record.pixels[1].timeNs)} ns</td>
        <td>${formatNumber(record.averageTimeNs)} ns</td>
        <td>${formatNumber(fixedDelay)} ns</td>
        <td>${display.value} ${display.unit}</td>
      </tr>
    `;
  }).join("");
}

function renderAll() {
  renderMetrics();
  renderRangeReadout();
  renderRecentTable();
  updateAcquisitionState();
}

function setConnectionState(connected) {
  state.connected = connected;
  elements.connectionBadge.classList.toggle("online", connected);
  elements.connectionBadge.querySelector("small").textContent =
    connected ? "已连接" : "未连接";
  elements.connectBtn.disabled = connected;
  elements.disconnectBtn.disabled = !connected;
  elements.baudRate.disabled = connected;
  updateAcquisitionState();
}

async function connectSerial() {
  if (!("serial" in navigator)) {
    showToast("当前浏览器不支持 Web Serial，请使用桌面版 Chrome 或 Edge。", "error");
    return;
  }
  try {
    const port = await navigator.serial.requestPort();
    await port.open({
      baudRate: numericValue(elements.baudRate, 115200),
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      flowControl: "none",
    });
    state.port = port;
    state.lastRxDate = null;
    state.lineBuffer = "";
    state.textDecoder = new TextDecoder();
    const info = port.getInfo();
    elements.portInfo.textContent = info.usbVendorId
      ? `VID ${hex4(info.usbVendorId)} · PID ${hex4(info.usbProductId ?? 0)}`
      : "设备已打开";
    setConnectionState(true);
    showToast("串口连接成功，等待 O12 数据", "success");
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
      handleSerialBytes(value);
    }
  } catch (error) {
    if (state.connected) showToast(`串口读取中断：${error.message}`, "error");
  } finally {
    flushLineBuffer();
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
  flushLineBuffer();
  try {
    await state.port?.close();
  } catch {
    // Ignore a device that disappeared before close completed.
  }
  state.port = null;
  elements.portInfo.textContent = "等待设备";
}

function clearData() {
  state.records = [];
  state.latestO12 = null;
  state.latestO12At = null;
  state.invalidFrameCount = 0;
  state.parseErrorCount = 0;
  state.lineBuffer = "";
  state.parsedText = "";
  elements.parsedSerialData.value = "";
  renderAll();
}

function exportDataCsv() {
  if (!state.records.length) {
    showToast("当前没有可导出的测距数据", "error");
    return;
  }

  const fixedDelay = getFixedDelayNs();
  const scale = getDistanceScaleMmPerNs();
  const rows = [[
    "sample", "time", "pixel0_hex", "pixel0_tof_ns", "pixel1_hex",
    "pixel1_tof_ns", "average_tof_ns", "fixed_delay_ns",
    "distance_scale_mm_per_ns", "distance_mm",
  ]];
  for (const record of state.records) {
    rows.push([
      record.index,
      record.receivedAt.toISOString(),
      record.pixels[0].hex,
      record.pixels[0].timeNs,
      record.pixels[1].hex,
      record.pixels[1].timeNs,
      record.averageTimeNs,
      fixedDelay,
      scale,
      distanceMm(record),
    ]);
  }
  downloadCsv(rows, `single_range_${fileTimestamp()}.csv`);
}

function downloadCsv(rows, filename) {
  const csv = `\ufeff${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
  showToast(`已生成 ${filename}`, "success");
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
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
  elements.clearDataBtn.addEventListener("click", clearData);
  elements.clearActualBtn.addEventListener("click", () => {
    state.actualText = "";
    elements.actualSerialData.value = "";
  });
  elements.clearParsedBtn.addEventListener("click", () => {
    state.parsedText = "";
    elements.parsedSerialData.value = "";
  });
  elements.fixedDelayNs.addEventListener("input", renderAll);
  elements.distanceScaleMmPerNs.addEventListener("input", renderAll);
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
      showToast("串口设备已断开", "error");
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
  bindEvents();
  setConnectionState(false);
  renderAll();
}

if (typeof document !== "undefined") initialize();
