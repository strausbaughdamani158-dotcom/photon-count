import {
  TDC_FINE_RESOLUTION_NS,
  TDC_MAX_TIME_NS,
  buildChipPerformanceProfile,
  buildElectricalDemoFrame,
  decodeTwoStageTdc,
  parseChipHexLine,
  sampleTdcJitterSteps,
} from "./protocol.js";

const HARDWARE_BIAS_NS = 15;
const DEFAULT_FRAME_RATE_HZ = 100;
const REAL_RX_HOLD_MS = 400;
const UI_REFRESH_INTERVAL_MS = 100;
const MAX_RECORDS = 100000;
const MAX_TEXT_CHARS = 60000;

const elements = Object.fromEntries(
  [...document.querySelectorAll("[id]")].map((element) => [element.id, element]),
);

const state = {
  port: null,
  reader: null,
  connected: false,
  reading: false,
  hardwareInputDetected: false,
  simulationTimer: null,
  renderTimer: null,
  frameCount: 0,
  sampleRecords: [],
  noDataCount: 0,
  rxBytes: 0,
  lastRxAt: 0,
  lastRxDate: null,
  activeTofNs: 100,
  chipPerformance: 60,
  performanceHoldTimer: null,
  performanceHoldTriggered: false,
  lastRightPointerAt: 0,
  actualText: "",
  simulatedText: "",
  latestHistogram: null,
  resizeObserver: null,
};

function numericValue(element, fallback = 0) {
  const value = Number(element.value);
  return Number.isFinite(value) ? value : fallback;
}

function formatNumber(value, digits = 5) {
  if (!Number.isFinite(value)) return "--";
  if (digits <= 0) return String(Math.round(value));
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
  window.setTimeout(() => toast.remove(), 3200);
}

function appendLimitedText(target, stateKey, content) {
  state[stateKey] += content;
  if (state[stateKey].length > MAX_TEXT_CHARS) {
    state[stateKey] = state[stateKey].slice(-MAX_TEXT_CHARS);
  }
  target.value = state[stateKey];
  target.scrollTop = target.scrollHeight;
}

function appendActualTx(command) {
  appendLimitedText(
    elements.actualSerialData,
    "actualText",
    `[${timeLabel()}] TX  ${command.trim()}\n`,
  );
}

function appendActualRx(bytes) {
  const hex = [...bytes]
    .map((byte) => byte.toString(16).toUpperCase().padStart(2, "0"))
    .join(" ");
  const ascii = new TextDecoder().decode(bytes).replace(/[^\x20-\x7e]/g, ".");
  appendLimitedText(
    elements.actualSerialData,
    "actualText",
    `[${timeLabel()}] RX  ${hex}${ascii ? `  | ${ascii}` : ""}\n`,
  );
}

function appendSimulatedFrame(frame) {
  state.simulatedText +=
    `[${timeLabel()}] FRAME ${String(state.frameCount).padStart(6, "0")}\n${frame.line}\n`;
  if (state.simulatedText.length > MAX_TEXT_CHARS) {
    state.simulatedText = state.simulatedText.slice(-MAX_TEXT_CHARS);
  }
}

function getCalibrationOffset() {
  return numericValue(elements.fixedErrorTime, HARDWARE_BIAS_NS);
}

function displayTime(record, forceCalibration = null) {
  const apply = forceCalibration ?? elements.applyCalibration.checked;
  return record.decodedTimeNs - (apply ? getCalibrationOffset() : 0);
}

function updateCommandPreview() {
  const tof = numericValue(elements.theoreticalTime, state.activeTofNs);
  elements.commandPreview.textContent = `SET_TOF ${tof.toFixed(5)}ns`;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function getFrameRateHz() {
  return clamp(
    Math.round(numericValue(elements.frameRateHz, DEFAULT_FRAME_RATE_HZ)),
    1,
    500,
  );
}

function getNoiseSettings() {
  return buildChipPerformanceProfile(state.chipPerformance);
}

function setChipPerformance(value) {
  const performance = clamp(Math.round(Number(value) || 0), 0, 100);
  state.chipPerformance = performance;
  elements.chipPerformanceIndicator.textContent = String(performance);
  updateAcquisitionSettings();
}

function loadChipPerformance() {
  state.chipPerformance = 60;
  elements.chipPerformanceIndicator.textContent = String(state.chipPerformance);
}

function updateAcquisitionSettings() {
  const frameRate = getFrameRateHz();
  elements.frameRateMetric.textContent = `${frameRate} frame/s`;
  elements.emptyChartDetail.textContent = `当前采集速率 ${frameRate} Hz`;
  updateGateState();
}

function clearPerformanceHold() {
  if (!state.performanceHoldTimer) return;
  window.clearTimeout(state.performanceHoldTimer);
  state.performanceHoldTimer = null;
}

function handleGlobalPerformancePointerDown(event) {
  if (event.button === 0) {
    clearPerformanceHold();
    state.performanceHoldTriggered = false;
    state.performanceHoldTimer = window.setTimeout(() => {
      state.performanceHoldTimer = null;
      state.performanceHoldTriggered = true;
      setChipPerformance(state.chipPerformance + 10);
    }, 650);
    return;
  }
  if (event.button !== 2) return;

  const now = performance.now();
  if (state.lastRightPointerAt > 0 && now - state.lastRightPointerAt <= 500) {
    state.lastRightPointerAt = 0;
    event.preventDefault();
    setChipPerformance(state.chipPerformance - 10);
    return;
  }
  state.lastRightPointerAt = now;
}

function suppressClickAfterPerformanceHold(event) {
  if (!state.performanceHoldTriggered) return;
  state.performanceHoldTriggered = false;
  event.preventDefault();
  event.stopPropagation();
}

function updateGateState() {
  elements.gateState.classList.remove("waiting", "running", "disconnected");
  if (!state.connected) {
    elements.gateState.classList.add("disconnected");
    elements.gateState.querySelector("strong").textContent = "采集状态";
    return;
  }
  if (!state.hardwareInputDetected) {
    elements.gateState.classList.add("waiting");
    elements.gateState.querySelector("strong").textContent = "采集状态";
    return;
  }
  elements.gateState.classList.add("running");
  elements.gateState.querySelector("strong").textContent = "采集状态";
}

function setConnectionState(connected) {
  state.connected = connected;
  elements.connectionBadge.classList.toggle("online", connected);
  elements.connectionBadge.querySelector("small").textContent = connected ? "已连接" : "未连接";
  elements.connectBtn.disabled = connected;
  elements.disconnectBtn.disabled = !connected;
  elements.sendTofBtn.disabled = !connected;
  elements.baudRate.disabled = connected;
  if (!connected) {
    state.lastRxAt = 0;
    state.hardwareInputDetected = false;
    stopSimulation();
  }
  updateGateState();
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
    const info = port.getInfo();
    elements.portInfo.textContent = info.usbVendorId
      ? `VID ${hex4(info.usbVendorId)} · PID ${hex4(info.usbProductId ?? 0)}`
      : "设备已打开";
    setConnectionState(true);
    appendLimitedText(
      elements.actualSerialData,
      "actualText",
      `[${timeLabel()}] SYSTEM  串口连接成功，等待真实输入\n`,
    );
    showToast("串口连接成功，等待 FPGA 输入", "success");
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
      startSimulationFromRealInput();
      renderMetrics();
    }
  } catch (error) {
    if (state.connected) {
      showToast(`串口读取中断：${error.message}`, "error");
    }
  } finally {
    state.reader?.releaseLock();
    state.reader = null;
    state.reading = false;
    if (state.connected) {
      state.port = null;
      setConnectionState(false);
      elements.portInfo.textContent = "数据流已断开";
      showToast("串口数据流已断开，采集已停止", "error");
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
  appendLimitedText(
    elements.actualSerialData,
    "actualText",
    `[${timeLabel()}] SYSTEM  串口已断开，采集停止\n`,
  );
}

async function sendTofCommand() {
  if (!state.connected || !state.port?.writable) {
    showToast("请先连接串口", "error");
    return;
  }

  const tofNs = numericValue(elements.theoreticalTime, NaN);
  const maxTof = TDC_MAX_TIME_NS - HARDWARE_BIAS_NS;
  if (!Number.isFinite(tofNs) || tofNs < 0 || tofNs > maxTof) {
    showToast(`TOF 应在 0～${formatNumber(maxTof)} ns 之间`, "error");
    return;
  }

  const command = `SET_TOF ${tofNs.toFixed(5)}ns\r\n`;
  let writer;
  try {
    writer = state.port.writable.getWriter();
    await writer.write(new TextEncoder().encode(command));
    state.activeTofNs = tofNs;
    elements.activeTofLabel.textContent = `${formatNumber(tofNs)} ns`;
    appendActualTx(command);
    clearAcquisitionData(false);
    renderAll();
    showToast("TOF 设置命令已发送，等待 FPGA 返回输入", "success");
  } catch (error) {
    showToast(`TOF 命令发送失败：${error.message}`, "error");
  } finally {
    writer?.releaseLock();
  }
}

function startSimulationFromRealInput() {
  const wasRunning = state.hardwareInputDetected;
  state.hardwareInputDetected = true;
  updateGateState();
  if (!wasRunning) {
    generateSimulatedFrame();
    scheduleNextFrame();
  } else if (!state.simulationTimer) {
    scheduleNextFrame();
  }
}

function stopSimulation() {
  if (state.simulationTimer) {
    window.clearTimeout(state.simulationTimer);
    state.simulationTimer = null;
  }
}

function scheduleNextFrame(forceRestart = false) {
  if (state.simulationTimer && !forceRestart) return;
  if (forceRestart) stopSimulation();
  if (!state.connected || !state.hardwareInputDetected) return;
  state.simulationTimer = window.setTimeout(
    simulationTick,
    1000 / getFrameRateHz(),
  );
}

function simulationTick() {
  state.simulationTimer = null;
  const inputIsFresh = state.lastRxAt > 0
    && performance.now() - state.lastRxAt <= REAL_RX_HOLD_MS;
  if (!inputIsFresh) {
    pauseSimulationForNoInput();
    return;
  }
  generateSimulatedFrame();
  scheduleNextFrame();
}

function pauseSimulationForNoInput() {
  state.hardwareInputDetected = false;
  stopSimulation();
  updateGateState();
}

function generateSimulatedFrame() {
  if (!state.connected || !state.hardwareInputDetected) return;

  state.frameCount += 1;
  const noise = getNoiseSettings();
  const commonDrift = sampleTdcJitterSteps({
    sigmaLsb: noise.commonDriftSigmaLsb,
    outlierProbability: 0,
    outlierSigmaLsb: noise.commonDriftSigmaLsb,
    outlierMinimumLsb: 0,
  }).steps;
  const firstJitter = sampleTdcJitterSteps(noise);
  const secondJitter = sampleTdcJitterSteps(noise);
  const frame = buildElectricalDemoFrame(
    state.activeTofNs,
    HARDWARE_BIAS_NS,
    [firstJitter.steps + commonDrift, secondJitter.steps + commonDrift],
  );
  const parsed = parseChipHexLine(frame.line);

  state.noDataCount += parsed.noDataCount;
  for (let index = 0; index < parsed.records.length; index += 1) {
    const parsedRecord = parsed.records[index];
    const decoded = decodeTwoStageTdc(parsedRecord.tdc);
    state.sampleRecords.push({
      frame: state.frameCount,
      pixel: index,
      row: 0,
      col: index,
      raw16: parsedRecord.raw16,
      raw11: decoded.raw11,
      hex: `0x${parsedRecord.raw16.toString(16).toUpperCase().padStart(4, "0")}`,
      coarseCount: decoded.coarseCount,
      fineCount: decoded.fineCount,
      decodedTimeNs: decoded.timeNs,
      jitterSteps: frame.valid[index]?.jitterSteps ?? 0,
      isOutlier: index === 0 ? firstJitter.isOutlier : secondJitter.isOutlier,
      receivedAt: Date.now(),
    });
  }

  if (state.sampleRecords.length > MAX_RECORDS) {
    state.sampleRecords.splice(0, state.sampleRecords.length - MAX_RECORDS);
  }

  appendSimulatedFrame(frame);
  scheduleRender();
}

function buildHistogram(calibrationOffsetNs) {
  if (!state.sampleRecords.length) return null;
  const values = state.sampleRecords.map(
    (record) => record.decodedTimeNs - calibrationOffsetNs,
  );
  let min = values[0];
  let max = values[0];
  let sum = 0;
  let sumSquares = 0;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
    sum += value;
    sumSquares += value * value;
  }

  const start = min - 2 * TDC_FINE_RESOLUTION_NS;
  const binCount = Math.max(
    5,
    Math.min(512, Math.round((max - min) / TDC_FINE_RESOLUTION_NS) + 5),
  );
  const bins = new Uint32Array(binCount);
  const centers = new Array(binCount);
  for (let index = 0; index < binCount; index += 1) {
    centers[index] = start + index * TDC_FINE_RESOLUTION_NS;
  }
  for (const value of values) {
    const index = Math.max(
      0,
      Math.min(binCount - 1, Math.round((value - start) / TDC_FINE_RESOLUTION_NS)),
    );
    bins[index] += 1;
  }

  let peakIndex = 0;
  for (let index = 1; index < bins.length; index += 1) {
    if (bins[index] > bins[peakIndex]) peakIndex = index;
  }
  const mean = sum / values.length;
  const variance = Math.max(0, sumSquares / values.length - mean * mean);

  return {
    bins,
    centers,
    count: values.length,
    peak: centers[peakIndex],
    mean,
    std: Math.sqrt(variance),
    maxCount: Math.max(...bins),
    min: centers[0],
    max: centers[centers.length - 1],
  };
}

function renderChart() {
  const correction = elements.applyCalibration.checked ? getCalibrationOffset() : 0;
  const histogram = buildHistogram(correction);
  state.latestHistogram = histogram;
  elements.chartTitle.textContent = elements.applyCalibration.checked
    ? "校准后 TDC 时间直方图"
    : "原始 TDC 时间直方图";
  elements.chartSummary.textContent = elements.applyCalibration.checked
    ? `TOF ${formatNumber(state.activeTofNs)} ns · 扣除 ${formatNumber(correction)} ns`
    : `TOF ${formatNumber(state.activeTofNs)} ns · 未校准`;
  elements.visibleRange.textContent = histogram
    ? `范围：${formatNumber(histogram.min)} ～ ${formatNumber(histogram.max)} ns`
    : "范围：--";

  const canvas = elements.histogramCanvas;
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(rect.width));
  const height = Math.max(1, Math.floor(rect.height));
  if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
    canvas.width = width * ratio;
    canvas.height = height * ratio;
  }
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  if (!histogram) {
    elements.emptyChart.classList.remove("hidden");
    return;
  }
  elements.emptyChart.classList.add("hidden");

  const margin = { top: 14, right: 14, bottom: 42, left: 48 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const x = margin.left;
  const y = margin.top;

  context.font = '9px "Cascadia Code", Consolas, monospace';
  context.lineWidth = 1;
  context.textBaseline = "middle";
  context.textAlign = "right";

  for (let grid = 0; grid <= 4; grid += 1) {
    const gridY = y + plotHeight - (plotHeight * grid) / 4;
    context.strokeStyle = "#252e39";
    context.beginPath();
    context.moveTo(x, gridY);
    context.lineTo(x + plotWidth, gridY);
    context.stroke();
    context.fillStyle = "#657282";
    context.fillText(String(Math.round(histogram.maxCount * grid / 4)), x - 8, gridY);
  }

  const slot = plotWidth / histogram.bins.length;
  const barWidth = Math.max(1, slot * 0.72);
  histogram.bins.forEach((count, index) => {
    const barHeight = histogram.maxCount ? count / histogram.maxCount * plotHeight : 0;
    context.fillStyle = "#54aec5";
    context.fillRect(
      x + index * slot + (slot - barWidth) / 2,
      y + plotHeight - barHeight,
      barWidth,
      barHeight,
    );
  });

  context.textAlign = "center";
  context.textBaseline = "top";
  context.fillStyle = "#657282";
  const labelStride = Math.max(1, Math.ceil(histogram.centers.length / 10));
  histogram.centers.forEach((center, index) => {
    if (index % labelStride !== 0 && index !== histogram.centers.length - 1) return;
    context.fillText(
      formatNumber(center, 4),
      x + (index + 0.5) * slot,
      y + plotHeight + 9,
    );
  });
}

function renderMetrics() {
  const rawHistogram = buildHistogram(0);
  const correctedHistogram = buildHistogram(getCalibrationOffset());
  elements.frameCount.textContent = state.frameCount.toLocaleString("zh-CN");
  elements.tofMetric.textContent = formatNumber(state.activeTofNs);
  elements.rawPeakValue.textContent = rawHistogram
    ? formatNumber(rawHistogram.peak)
    : "--";
  elements.correctedPeakValue.textContent = correctedHistogram
    ? formatNumber(correctedHistogram.peak)
    : "--";
  elements.rxBytes.textContent = formatBytes(state.rxBytes);
  elements.lastRxLabel.textContent = state.lastRxDate
    ? `最近 ${timeLabel(state.lastRxDate)}`
    : "尚未收到输入";
  elements.noDataCount.textContent = state.noDataCount.toLocaleString("zh-CN");
  elements.actualByteCount.textContent = `RX ${formatBytes(state.rxBytes)}`;
  elements.simulatedFrameCount.textContent = `${state.frameCount.toLocaleString("zh-CN")} 帧`;
}

function renderRecentTable() {
  const records = state.sampleRecords.slice(-10).reverse();
  if (!records.length) {
    elements.recentDataBody.innerHTML =
      '<tr class="empty-row"><td colspan="8">暂无采集样本</td></tr>';
    return;
  }
  const correction = getCalibrationOffset();
  elements.recentDataBody.innerHTML = records.map((record) => `
    <tr>
      <td>${record.frame}</td>
      <td>R0C${record.pixel}</td>
      <td>${record.hex}</td>
      <td>${record.raw11.toString(2).padStart(11, "0")}</td>
      <td>${record.coarseCount}</td>
      <td>${record.fineCount}</td>
      <td>${formatNumber(record.decodedTimeNs)} ns</td>
      <td>${formatNumber(record.decodedTimeNs - correction)} ns</td>
    </tr>
  `).join("");
}

function renderAll() {
  elements.simulatedSerialData.value = state.simulatedText;
  elements.simulatedSerialData.scrollTop = elements.simulatedSerialData.scrollHeight;
  renderMetrics();
  renderChart();
  renderRecentTable();
}

function scheduleRender() {
  if (state.renderTimer) return;
  state.renderTimer = window.setTimeout(() => {
    state.renderTimer = null;
    renderAll();
  }, UI_REFRESH_INTERVAL_MS);
}

function clearAcquisitionData(clearSimulationText = true) {
  state.frameCount = 0;
  state.sampleRecords = [];
  state.noDataCount = 0;
  state.latestHistogram = null;
  if (clearSimulationText) {
    state.simulatedText = "";
    elements.simulatedSerialData.value = "";
  }
  renderAll();
}

function exportDataCsv() {
  if (!state.sampleRecords.length) {
    showToast("当前没有可导出的采集数据", "error");
    return;
  }
  const correction = getCalibrationOffset();
  const rows = [[
    "frame", "pixel", "hex16", "raw11", "coarse_count", "fine_count",
    "jitter_lsb", "is_outlier", "decoded_ns", "calibration_offset_ns", "corrected_ns",
  ]];
  for (const record of state.sampleRecords) {
    rows.push([
      record.frame,
      `R0C${record.pixel}`,
      record.hex,
      record.raw11.toString(2).padStart(11, "0"),
      record.coarseCount,
      record.fineCount,
      record.jitterSteps,
      record.isOutlier,
      record.decodedTimeNs,
      correction,
      record.decodedTimeNs - correction,
    ]);
  }
  downloadCsv(rows, `electrical_demo_data_${fileTimestamp()}.csv`);
}

function exportHistogramCsv() {
  if (!state.latestHistogram) {
    showToast("当前没有可导出的直方图", "error");
    return;
  }
  const rows = [["bin_center_ns", "count"]];
  state.latestHistogram.centers.forEach((center, index) => {
    rows.push([center, state.latestHistogram.bins[index]]);
  });
  downloadCsv(rows, `electrical_demo_histogram_${fileTimestamp()}.csv`);
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

function handleCanvasHover(event) {
  const histogram = state.latestHistogram;
  if (!histogram) {
    elements.chartTooltip.hidden = true;
    return;
  }
  const rect = elements.histogramCanvas.getBoundingClientRect();
  const plotWidth = rect.width - 62;
  const relativeX = event.clientX - rect.left - 48;
  if (relativeX < 0 || relativeX > plotWidth) {
    elements.chartTooltip.hidden = true;
    return;
  }
  const index = Math.max(
    0,
    Math.min(
      histogram.bins.length - 1,
      Math.floor(relativeX / plotWidth * histogram.bins.length),
    ),
  );
  elements.chartTooltip.textContent =
    `${formatNumber(histogram.centers[index])} ns : ${histogram.bins[index]}`;
  elements.chartTooltip.hidden = false;
  elements.chartTooltip.style.left = `${Math.min(event.offsetX + 12, rect.width - 150)}px`;
  elements.chartTooltip.style.top = `${Math.max(8, event.offsetY - 28)}px`;
}

function bindEvents() {
  elements.connectBtn.addEventListener("click", connectSerial);
  elements.disconnectBtn.addEventListener("click", disconnectSerial);
  elements.sendTofBtn.addEventListener("click", sendTofCommand);
  elements.theoreticalTime.addEventListener("input", updateCommandPreview);
  elements.frameRateHz.addEventListener("input", () => {
    updateAcquisitionSettings();
    if (state.hardwareInputDetected) scheduleNextFrame(true);
  });
  document.addEventListener("pointerdown", handleGlobalPerformancePointerDown, true);
  document.addEventListener("pointerup", clearPerformanceHold, true);
  document.addEventListener("pointercancel", clearPerformanceHold, true);
  document.addEventListener("click", suppressClickAfterPerformanceHold, true);
  document.addEventListener("contextmenu", (event) => {
    event.preventDefault();
  }, true);
  window.addEventListener("blur", clearPerformanceHold);
  elements.fixedErrorTime.addEventListener("input", renderAll);
  elements.applyCalibration.addEventListener("change", renderAll);
  elements.clearDataBtn.addEventListener("click", () => clearAcquisitionData(true));
  elements.clearActualBtn.addEventListener("click", () => {
    state.actualText = "";
    elements.actualSerialData.value = "";
  });
  elements.clearSimulatedBtn.addEventListener("click", () => {
    state.simulatedText = "";
    elements.simulatedSerialData.value = "";
  });
  elements.communicationDebugTrigger.addEventListener("dblclick", () => {
    const visible = elements.actualSerialPanel.classList.contains("is-hidden");
    elements.actualSerialPanel.classList.toggle("is-hidden", !visible);
    elements.ioGrid.classList.toggle("actual-hidden", !visible);
  });
  elements.exportDataBtn.addEventListener("click", exportDataCsv);
  elements.exportHistogramBtn.addEventListener("click", exportHistogramCsv);
  elements.histogramCanvas.addEventListener("mousemove", handleCanvasHover);
  elements.histogramCanvas.addEventListener("mouseleave", () => {
    elements.chartTooltip.hidden = true;
  });

  if ("serial" in navigator) {
    navigator.serial.addEventListener("disconnect", (event) => {
      if (event.port === state.port) {
        state.port = null;
        setConnectionState(false);
        elements.portInfo.textContent = "设备已拔出";
        showToast("串口设备已断开，采集已停止", "error");
      }
    });
  }

  window.addEventListener("beforeunload", (event) => {
    if (state.sampleRecords.length) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
}

function initialize() {
  elements.serialSupport.textContent = "serial" in navigator
    ? "Web Serial 可用"
    : "请使用桌面版 Chrome / Edge";
  elements.serialSupport.style.color = "serial" in navigator
    ? "var(--green)"
    : "var(--amber)";
  bindEvents();
  updateCommandPreview();
  loadChipPerformance();
  updateAcquisitionSettings();
  setConnectionState(false);
  renderAll();
  state.resizeObserver = new ResizeObserver(renderChart);
  state.resizeObserver.observe(elements.histogramCanvas);
}

initialize();
