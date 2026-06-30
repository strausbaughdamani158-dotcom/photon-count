import { rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import process from "node:process";

const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const appPort = 8124;
const debugPort = 9400 + (process.pid % 200);
const profilePath = `D:\\tmp\\arrayscope-electrical-smoke-${process.pid}`;
const appUrl = `http://127.0.0.1:${appPort}/`;

const server = spawn(process.execPath, ["server.mjs"], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(appPort) },
  stdio: "ignore",
  windowsHide: true,
});

let browser;
let connection;
const exceptions = [];

try {
  await waitForHttp(appUrl, 5000);
  browser = spawn(chromePath, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${profilePath}`,
    `--remote-debugging-port=${debugPort}`,
    "about:blank",
  ], {
    stdio: "ignore",
    windowsHide: true,
  });

  const target = await waitForTarget(debugPort, 8000);
  connection = await connectCdp(target.webSocketDebuggerUrl, exceptions);
  await connection.send("Runtime.enable");
  await connection.send("Page.enable");
  await connection.send("Page.addScriptToEvaluateOnNewDocument", {
    source: serialMockSource(),
  });
  await connection.send("Page.navigate", { url: appUrl });
  await waitForCondition(connection, "document.readyState === 'complete'", 5000);
  await waitForCondition(connection, "document.getElementById('connectBtn') !== null", 5000);

  await evaluate(connection, "document.getElementById('connectBtn').click(); true");
  await waitForCondition(
    connection,
    "document.getElementById('connectionBadge').classList.contains('online')",
    3000,
  );
  const defaultFrameRate = await evaluate(
    connection,
    "document.getElementById('frameRateHz').value",
  );
  const defaultChipPerformance = await evaluate(
    connection,
    "document.getElementById('chipPerformanceIndicator').textContent",
  );
  const performanceHiddenInitially = await evaluate(
    connection,
    "!document.body.innerText.includes('芯片性能')",
  );
  await evaluate(connection, `
    document.body.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0 })
    );
    true;
  `);
  await delay(1400);
  const performanceDuringLongHold = await evaluate(
    connection,
    "document.getElementById('chipPerformanceIndicator').textContent",
  );
  await evaluate(connection, `
    document.body.dispatchEvent(
      new PointerEvent('pointerup', { bubbles: true, button: 0 })
    );
    document.body.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      button: 0,
    }));
    for (let pair = 0; pair < 3; pair += 1) {
      document.body.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 2 })
      );
      document.body.dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, button: 2 })
      );
      document.body.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 2 })
      );
      document.body.dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, button: 2 })
      );
    }
    true;
  `);

  await delay(500);
  const framesBeforeInput = Number(await evaluate(
    connection,
    "document.getElementById('frameCount').textContent",
  ));

  await evaluate(connection, `
    document.getElementById('theoreticalTime').value = '100';
    document.getElementById('theoreticalTime').dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('sendTofBtn').click();
    true;
  `);
  await waitForCondition(connection, "window.__serialWrites.length === 1", 3000);
  await delay(500);
  const framesAfterTxOnly = Number(await evaluate(
    connection,
    "document.getElementById('frameCount').textContent",
  ));
  const gateWaitingIsYellow = await evaluate(connection, `
    document.getElementById('gateState').classList.contains('waiting')
      && getComputedStyle(document.querySelector('#gateState > i')).backgroundColor
        === 'rgb(208, 164, 95)'
  `);

  await evaluate(connection, `
    window.__rxFeed = setInterval(() => window.__pushSerial([0x41, 0x43, 0x4B]), 50);
    true;
  `);
  await waitForCondition(
    connection,
    "Number(document.getElementById('frameCount').textContent.replaceAll(',', '')) >= 30",
    3000,
  );
  await delay(450);
  await evaluate(connection, "clearInterval(window.__rxFeed); true");
  await delay(550);
  const framesAtPause = Number(await evaluate(
    connection,
    "document.getElementById('frameCount').textContent.replaceAll(',', '')",
  ));
  const gatePaused = await evaluate(
    connection,
    "!document.getElementById('gateState').classList.contains('running')",
  );
  await delay(250);
  const framesAfterPause = Number(await evaluate(
    connection,
    "document.getElementById('frameCount').textContent.replaceAll(',', '')",
  ));

  await evaluate(connection, `
    document.getElementById('frameRateHz').value = '50';
    document.getElementById('frameRateHz').dispatchEvent(new Event('input', { bubbles: true }));
    window.__rxFeed = setInterval(() => window.__pushSerial([0x44]), 50);
    true;
  `);
  await waitForCondition(
    connection,
    `Number(document.getElementById('frameCount').textContent.replaceAll(',', '')) > ${framesAtPause + 15}`,
    3000,
  );
  const detailsInitiallyCollapsed = await evaluate(connection, `({
    samples: !document.querySelector('.table-panel').open,
    formula: !document.querySelector('.formula-panel').open,
  })`);
  await evaluate(
    connection,
    "document.getElementById('communicationDebugTrigger').click(); true",
  );
  const actualPanelHiddenAfterClick = await evaluate(
    connection,
    "document.getElementById('actualSerialPanel').classList.contains('is-hidden')",
  );
  await evaluate(connection, `
    document.getElementById('communicationDebugTrigger').dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true })
    );
    true;
  `);

  const result = await evaluate(connection, `({
    title: document.title,
    frameCount: Number(document.getElementById('frameCount').textContent.replaceAll(',', '')),
    sampleCount: Number(document.getElementById('simulatedFrameCount').textContent.replaceAll(',', '').replace('帧', '')) * 2,
    tofMetric: document.getElementById('tofMetric').textContent,
    noDataCount: Number(document.getElementById('noDataCount').textContent.replaceAll(',', '')),
    correctedPeak: Number(document.getElementById('correctedPeakValue').textContent),
    gateRunning: document.getElementById('gateState').classList.contains('running'),
    gateRunningIsGreen: getComputedStyle(
      document.querySelector('#gateState > i')
    ).backgroundColor === 'rgb(89, 183, 143)',
    hasExposedRxStatusText: [
      '真实串口持续输入',
      '真实串口数据已暂停',
      '等待真实串口输入',
      '真实 RX 字节',
    ].some((text) => document.body.innerText.includes(text)),
    actualPanelVisible: !document.getElementById('actualSerialPanel').classList.contains('is-hidden'),
    hasDemoGateText: document.body.innerText.includes('演示门控')
      || document.body.innerText.includes('仅前两个像素有效')
      || document.body.innerText.includes('检测到真实 RX 后按设定帧率连续采集'),
    frameRate: document.getElementById('frameRateHz').value,
    frameRateMetric: document.getElementById('frameRateMetric').textContent,
    chipPerformance: document.getElementById('chipPerformanceIndicator').textContent,
    storedChipPerformance: Object.keys(localStorage).find(
      (key) => key.startsWith('arrayscope-chip-performance')
    ) ?? null,
    performanceInputCount: document.querySelectorAll('#actualSerialPanel input').length,
    legacyPerformanceInputs: [
      'chipPerformance',
      'noiseSigmaLsb',
      'outlierRate',
      'outlierSigmaLsb',
    ].filter((id) => document.getElementById(id)).length,
    performanceIndicatorVisible: document.getElementById(
      'chipPerformanceIndicator'
    ).offsetParent !== null,
    debugPanelHasPerformanceText: document.getElementById(
      'actualSerialPanel'
    ).innerText.includes('芯片性能'),
    simulatedText: document.getElementById('simulatedSerialData').value,
    writes: window.__serialWrites,
  })`);
  await evaluate(connection, "clearInterval(window.__rxFeed); true");

  const frameLines = result.simulatedText.split("\n").filter((line) => line.startsWith("O12:"));
  const lastFrameWords = frameLines.at(-1)?.match(/0x[0-9A-F]{4}/g) ?? [];
  const validTicks = frameLines.flatMap((line) => {
    const words = line.match(/0x[0-9A-F]{4}/g) ?? [];
    return words.slice(0, 2).map((word) => {
      const raw11 = Number.parseInt(word.slice(2), 16) & 0x07ff;
      const coarseCount = (~((raw11 >>> 3) & 0xff)) & 0xff;
      return coarseCount * 8 + (raw11 & 0x07);
    });
  });
  const uniqueTicks = new Set(validTicks).size;
  const centerTick = Math.round(115 / 0.15625);
  const maximumDeviationLsb = Math.max(
    0,
    ...validTicks.map((tick) => Math.abs(tick - centerTick)),
  );

  await evaluate(connection, "document.getElementById('disconnectBtn').click(); true");
  await waitForCondition(
    connection,
    "!document.getElementById('connectionBadge').classList.contains('online')",
    3000,
  );
  await delay(150);
  const framesBeforeDisconnect = Number(await evaluate(
    connection,
    "document.getElementById('frameCount').textContent.replaceAll(',', '')",
  ));
  await delay(550);
  const framesAfterDisconnect = Number(await evaluate(
    connection,
    "document.getElementById('frameCount').textContent.replaceAll(',', '')",
  ));
  await evaluate(connection, "document.getElementById('clearDataBtn').click(); true");
  await connection.send("Page.reload", { ignoreCache: true });
  await waitForCondition(connection, "document.readyState === 'complete'", 5000);
  await waitForCondition(
    connection,
    "document.getElementById('chipPerformanceIndicator') !== null",
    3000,
  );
  const performanceAfterReload = await evaluate(
    connection,
    "document.getElementById('chipPerformanceIndicator').textContent",
  );

  const summary = {
    framesBeforeInput,
    framesAfterTxOnly,
    defaultFrameRate,
    defaultChipPerformance,
    performanceHiddenInitially,
    performanceDuringLongHold,
    framesAtPause,
    framesAfterPause,
    gatePaused,
    frameCount: result.frameCount,
    framesBeforeDisconnect,
    framesAfterDisconnect,
    performanceAfterReload,
    sampleCount: result.sampleCount,
    tofMetric: result.tofMetric,
    noDataCount: result.noDataCount,
    correctedPeak: result.correctedPeak,
    gateRunning: result.gateRunning,
    gateWaitingIsYellow,
    gateRunningIsGreen: result.gateRunningIsGreen,
    hasExposedRxStatusText: result.hasExposedRxStatusText,
    actualPanelVisible: result.actualPanelVisible,
    actualPanelHiddenAfterClick,
    detailsInitiallyCollapsed,
    hasDemoGateText: result.hasDemoGateText,
    frameRate: result.frameRate,
    frameRateMetric: result.frameRateMetric,
    chipPerformance: result.chipPerformance,
    storedChipPerformance: result.storedChipPerformance,
    performanceInputCount: result.performanceInputCount,
    legacyPerformanceInputs: result.legacyPerformanceInputs,
    performanceIndicatorVisible: result.performanceIndicatorVisible,
    debugPanelHasPerformanceText: result.debugPanelHasPerformanceText,
    uniqueTicks,
    maximumDeviationLsb,
    wordsInLastFrame: lastFrameWords.length,
    validWords: lastFrameWords.slice(0, 2),
    emptyWordCount: lastFrameWords.slice(2).filter((word) => word === "0x0003").length,
    sentCommand: new TextDecoder().decode(Uint8Array.from(result.writes[0] ?? [])),
    runtimeExceptions: exceptions.length,
  };

  if (framesBeforeInput !== 0 || framesAfterTxOnly !== 0) {
    throw new Error("未收到真实串口输入时错误生成了采集帧");
  }
  if (summary.framesAtPause < 40 || summary.framesAfterPause !== summary.framesAtPause
      || !summary.gatePaused) {
    throw new Error("真实 RX 停止后采集帧仍在增长");
  }
  if (summary.frameCount <= summary.framesAtPause
      || summary.sampleCount !== summary.frameCount * 2) {
    throw new Error("恢复真实 RX 后采集帧数量异常");
  }
  if (summary.tofMetric !== "100") {
    throw new Error("顶部 TOF 指标未显示当前生效值");
  }
  if (summary.framesAfterDisconnect !== summary.framesBeforeDisconnect) {
    throw new Error("串口断开后采集帧仍在增长");
  }
  if (summary.noDataCount !== summary.frameCount * 62) {
    throw new Error("空像素数量异常");
  }
  if (summary.wordsInLastFrame !== 64 || summary.emptyWordCount !== 62) {
    throw new Error("O12 采集帧格式异常");
  }
  if (summary.validWords.some((word) => word === "0x0003")) {
    throw new Error("前两个有效像素错误输出为空数据");
  }
  if (Math.abs(summary.correctedPeak - 100) > 1) {
    throw new Error(`校准后峰值异常: ${summary.correctedPeak}`);
  }
  if (summary.defaultFrameRate !== "100" || summary.defaultChipPerformance !== "60"
      || summary.frameRate !== "50"
      || summary.frameRateMetric !== "50 frame/s" || summary.uniqueTicks < 7
      || summary.maximumDeviationLsb < 8) {
    throw new Error("可配置帧率或高斯长尾采集模型未生效");
  }
  if (summary.performanceDuringLongHold !== "70"
      || summary.chipPerformance !== "40"
      || summary.performanceAfterReload !== "60"
      || summary.storedChipPerformance !== null
      || !summary.performanceHiddenInitially
      || !summary.performanceIndicatorVisible
      || summary.debugPanelHasPerformanceText
      || summary.performanceInputCount !== 0
      || summary.legacyPerformanceInputs !== 0) {
    throw new Error("芯片性能参数未应用到采集模型");
  }
  if (!summary.actualPanelHiddenAfterClick || !summary.actualPanelVisible) {
    throw new Error("通信调试未按单击隐藏、双击开启的方式工作");
  }
  if (!summary.detailsInitiallyCollapsed.samples
      || !summary.detailsInitiallyCollapsed.formula
      || summary.hasDemoGateText) {
    throw new Error("技术详情折叠状态或界面文案不符合要求");
  }
  if (!summary.gateWaitingIsYellow || !summary.gateRunningIsGreen
      || summary.hasExposedRxStatusText) {
    throw new Error("采集状态颜色或公开状态文案不符合要求");
  }
  if (!summary.gateRunning || !summary.actualPanelVisible || summary.runtimeExceptions) {
    throw new Error("采集门控或浏览器运行状态异常");
  }

  await connection.send("Page.navigate", { url: `${appUrl}photon-count.html` });
  await waitForCondition(connection, "document.readyState === 'complete'", 5000);
  await waitForCondition(
    connection,
    "document.querySelectorAll('.count-cell').length === 1024",
    5000,
  );
  await evaluate(connection, "document.getElementById('connectBtn').click(); true");
  await waitForCondition(
    connection,
    "document.getElementById('connectionBadge').classList.contains('online')",
    3000,
  );
  const defaultCountWindow = await evaluate(
    connection,
    "document.getElementById('countWindowUs').value",
  );
  await evaluate(connection, `
    document.getElementById('countWindowUs').value = '20';
    document.getElementById('countWindowUs').dispatchEvent(
      new Event('input', { bubbles: true })
    );
    document.getElementById('sendWindowBtn').click();
    true;
  `);
  await waitForCondition(connection, "window.__serialWrites.length === 1", 3000);
  await delay(500);
  const photonFramesBeforeInput = Number(await evaluate(
    connection,
    "document.getElementById('frameCount').textContent",
  ));
  await evaluate(connection, `
    window.__photonFrame = [0xAA, 0x55];
    const photonWords = [0x000A, 0x000B, 0x00FF, 0x0100];
    while (photonWords.length < 1024) photonWords.push(photonWords.length & 0xFF);
    for (const word of photonWords) {
      window.__photonFrame.push((word >>> 8) & 0xFF, word & 0xFF);
    }
    window.__photonFrame.push(0x5A);
    window.__photonRxFeed = setInterval(
      () => {
        window.__pushSerial(window.__photonFrame.slice(0, 37));
        window.__pushSerial(window.__photonFrame.slice(37));
      },
      50
    );
    true;
  `);
  await waitForCondition(
    connection,
    "Number(document.getElementById('frameCount').textContent.replaceAll(',', '')) >= 30",
    3000,
  );
  const photonStateGreen = await evaluate(
    connection,
    "document.getElementById('acquisitionState').classList.contains('running')",
  );
  await evaluate(connection, "document.getElementById('imageViewBtn').click(); true");
  await delay(250);
  const photonSummary = await evaluate(connection, `({
    title: document.title,
    cellCount: document.querySelectorAll('.count-cell').length,
    frameCount: Number(document.getElementById('frameCount').textContent.replaceAll(',', '')),
    laneProgress: document.getElementById('laneProgress').textContent,
    windowMetric: document.getElementById('windowMetric').textContent,
    activeWindowLabel: document.getElementById('activeWindowLabel').textContent,
    row0col0: Number(document.querySelector('[data-row="0"][data-col="0"]').textContent),
    row0col1: Number(document.querySelector('[data-row="0"][data-col="1"]').textContent),
    row0col2: Number(document.querySelector('[data-row="0"][data-col="2"]').textContent),
    row0col3: Number(document.querySelector('[data-row="0"][data-col="3"]').textContent),
    row1col31: Number(document.querySelector('[data-row="1"][data-col="31"]').textContent),
    row2col0: Number(document.querySelector('[data-row="2"][data-col="0"]').textContent),
    row0col0Gray: getComputedStyle(
      document.querySelector('[data-row="0"][data-col="0"]')
    ).backgroundColor,
    imageMode: document.getElementById('countMatrix').classList.contains('image'),
    modeTag: document.getElementById('viewModeTag').textContent,
    stateGreen: document.getElementById('acquisitionState').classList.contains('running'),
    simulatedText: document.getElementById('simulatedSerialData').value,
    actualRxBytes: document.getElementById('rxBytes').textContent,
    sentWindowCommand: new TextDecoder().decode(
      Uint8Array.from(window.__serialWrites[0] ?? [])
    ),
    spatialStats: (() => {
      const values = [...document.querySelectorAll('.count-cell')]
        .map((cell) => Number(cell.textContent));
      let neighborDifference = 0;
      let farDifference = 0;
      let neighborPairs = 0;
      for (let row = 0; row < 32; row += 1) {
        for (let col = 0; col < 32; col += 1) {
          const index = row * 32 + col;
          if (col < 31) {
            neighborDifference += Math.abs(values[index] - values[index + 1]);
            neighborPairs += 1;
          }
          if (row < 31) {
            neighborDifference += Math.abs(values[index] - values[index + 32]);
            neighborPairs += 1;
          }
          farDifference += Math.abs(values[index] - values[(index + 511) % 1024]);
        }
      }
      return {
        unique: new Set(values).size,
        neighborDifference: neighborDifference / neighborPairs,
        farDifference: farDifference / values.length,
        lowPixels: values.filter((value) => value < 20).length,
        highPixels: values.filter((value) => value > 220).length,
      };
    })(),
    badPixelStats: (() => {
      const lines = document.getElementById('simulatedSerialData').value
        .split('\\n')
        .filter((line) => /^O\\d+:/.test(line))
        .map((line) => line.match(/0x[0-9A-F]{4}/g) ?? []);
      const cells = [...document.querySelectorAll('.bad-pixel')];
      return {
        configured: Number(document.documentElement.dataset.badPixelCount),
        rendered: cells.length,
        rightSide: cells.filter((cell) => Number(cell.dataset.col) >= 24).length,
        allNumericZero: cells.every((cell) => cell.textContent === '0'),
        allImageBlack: cells.every(
          (cell) => getComputedStyle(cell).backgroundColor === 'rgb(0, 0, 0)'
        ),
        allFrameWordsZero: cells.every((cell) => {
          const row = Number(cell.dataset.row);
          const col = Number(cell.dataset.col);
          const laneIndex = Math.floor(row / 2);
          const wordIndex = row % 2 === 0 ? col : 63 - col;
          return lines[laneIndex]?.[wordIndex] === '0x0000';
        }),
      };
    })(),
    runtimeExceptions: ${exceptions.length},
  })`);

  const photonLines = photonSummary.simulatedText
    .split("\n")
    .filter((line) => /^O\d+:/.test(line));
  const countsBeforeWindowChange = await evaluate(connection, `
    [...document.querySelectorAll('.count-cell')]
      .map((cell) => Number(cell.textContent))
  `);

  await evaluate(connection, `
    document.getElementById('countWindowUs').value = '35';
    document.getElementById('countWindowUs').dispatchEvent(
      new Event('input', { bubbles: true })
    );
    document.getElementById('sendWindowBtn').click();
    true;
  `);
  await waitForCondition(connection, "window.__serialWrites.length === 2", 3000);
  await delay(150);
  const countsAfterWindowChange = await evaluate(connection, `
    [...document.querySelectorAll('.count-cell')]
      .map((cell) => Number(cell.textContent))
  `);
  const secondWindowCommand = await evaluate(connection, `
    new TextDecoder().decode(Uint8Array.from(window.__serialWrites[1] ?? []))
  `);
  const photonFirstWords = photonLines[0]?.match(/0x[0-9A-F]{4}/g) ?? [];
  const photonLastWords = photonLines.at(-1)?.match(/0x[0-9A-F]{4}/g) ?? [];
  const photonFirstCount = photonFirstWords.length
    ? Number.parseInt(photonFirstWords[0].slice(2), 16) & 0xff
    : -1;
  const photonSecondRowLastCount = photonFirstWords.length
    ? Number.parseInt(photonFirstWords[32].slice(2), 16) & 0xff
    : -1;
  const photonFirstGray = photonFirstCount;

  await evaluate(connection, "clearInterval(window.__photonRxFeed); true");
  await delay(550);
  const photonFramesAtPause = Number(await evaluate(
    connection,
    "document.getElementById('frameCount').textContent.replaceAll(',', '')",
  ));
  const photonStateWaiting = await evaluate(
    connection,
    "document.getElementById('acquisitionState').classList.contains('waiting')",
  );
  await delay(250);
  const photonFramesAfterPause = Number(await evaluate(
    connection,
    "document.getElementById('frameCount').textContent.replaceAll(',', '')",
  ));
  await evaluate(connection, "document.getElementById('disconnectBtn').click(); true");
  await waitForCondition(
    connection,
    "!document.getElementById('connectionBadge').classList.contains('online')",
    3000,
  );
  await delay(150);
  const photonFramesBeforeDisconnect = Number(await evaluate(
    connection,
    "document.getElementById('frameCount').textContent.replaceAll(',', '')",
  ));
  await delay(450);
  const photonFramesAfterDisconnect = Number(await evaluate(
    connection,
    "document.getElementById('frameCount').textContent.replaceAll(',', '')",
  ));

  if (defaultCountWindow !== "10" || photonFramesBeforeInput !== 0
      || photonSummary.windowMetric !== "20"
      || photonSummary.activeWindowLabel !== "20 μs"
      || photonSummary.sentWindowCommand !== "SET_COUNT_WINDOW 20.000us\r\n"
      || photonSummary.cellCount !== 1024
      || photonSummary.frameCount < 30 || photonSummary.laneProgress !== "1024 点/帧") {
    throw new Error("计数窗口命令、触发门控或完整帧计数异常");
  }
  if (photonLines.length !== 16
      || !photonLines[0].startsWith("O12:")
      || !photonLines[15].startsWith("O3132:")
      || photonLines.some(
        (line) => (line.match(/0x[0-9A-F]{4}/g) ?? []).length !== 64
      )) {
    throw new Error("芯片采集接收帧未包含完整16路数据");
  }
  if (photonSummary.row0col0 !== photonFirstCount
      || photonSummary.row1col31 !== photonSecondRowLastCount
      || photonSummary.row0col0 !== 10
      || photonSummary.row0col1 !== 11
      || photonSummary.row0col2 !== 255
      || photonSummary.row0col3 !== 0
      || photonSummary.row2col0 !== 64) {
    throw new Error("真实光子计数固定帧解析、8-bit 解码或 1024 点矩阵填充异常");
  }
  if (!photonSummary.imageMode || photonSummary.modeTag !== "灰度成像"
      || photonSummary.row0col0Gray
        !== `rgb(${photonFirstGray}, ${photonFirstGray}, ${photonFirstGray})`) {
    throw new Error("光子计数灰度成像切换异常");
  }
  if (photonSummary.badPixelStats.configured !== 142
      || photonSummary.badPixelStats.rendered !== 142
      || photonSummary.badPixelStats.rightSide !== 57) {
    throw new Error("坏点配置样式加载异常");
  }
  if (JSON.stringify(countsAfterWindowChange)
        !== JSON.stringify(countsBeforeWindowChange)
      || secondWindowCommand !== "SET_COUNT_WINDOW 35.000us\r\n") {
    throw new Error("SET_COUNT_WINDOW 不应改变真实矩阵计数值");
  }
  if (!photonStateGreen || !photonSummary.stateGreen || !photonStateWaiting
      || photonFramesAtPause !== photonFramesAfterPause
      || photonFramesBeforeDisconnect !== photonFramesAfterDisconnect
      || exceptions.length) {
    throw new Error("光子计数串口采集或浏览器运行状态异常");
  }

  console.log(JSON.stringify({
    electrical: summary,
    photon: {
      ...photonSummary,
      photonFramesBeforeInput,
      photonFramesAtPause,
      photonFramesAfterPause,
      photonFramesBeforeDisconnect,
      photonFramesAfterDisconnect,
      outputLines: photonLines.length,
      firstLaneWords: photonFirstWords.length,
      lastLaneWords: photonLastWords.length,
      stateWaiting: photonStateWaiting,
    },
  }));
} finally {
  try {
    await connection?.send("Browser.close");
  } catch {
    browser?.kill();
  }
  server.kill();
  await delay(400);
  await rm(profilePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    .catch(() => {});
}

function serialMockSource() {
  return `
    (() => {
      const queue = [];
      let pendingRead = null;
      window.__serialWrites = [];
      window.__pushSerial = (bytes) => {
        const value = Uint8Array.from(bytes);
        if (pendingRead) {
          const resolve = pendingRead;
          pendingRead = null;
          resolve({ value, done: false });
        } else {
          queue.push(value);
        }
      };
      const reader = {
        read() {
          if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
          return new Promise((resolve) => { pendingRead = resolve; });
        },
        cancel() {
          if (pendingRead) {
            const resolve = pendingRead;
            pendingRead = null;
            resolve({ value: undefined, done: true });
          }
          return Promise.resolve();
        },
        releaseLock() {},
      };
      const writer = {
        write(bytes) {
          window.__serialWrites.push(Array.from(bytes));
          return Promise.resolve();
        },
        releaseLock() {},
      };
      const port = {
        open: async () => {},
        close: async () => {},
        getInfo: () => ({ usbVendorId: 0x1234, usbProductId: 0x5678 }),
        readable: { getReader: () => reader },
        writable: { getWriter: () => writer },
      };
      const serial = new EventTarget();
      serial.requestPort = async () => port;
      Object.defineProperty(navigator, 'serial', { configurable: true, value: serial });
    })();
  `;
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Server is still starting.
    }
    await delay(100);
  }
  throw new Error("本地服务器启动超时");
}

async function waitForTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = targets.find((target) => target.type === "page");
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      // Browser is still starting.
    }
    await delay(100);
  }
  throw new Error("Chrome 调试端口启动超时");
}

async function connectCdp(url, exceptions) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("CDP 连接超时")), 5000);
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("CDP 连接失败"));
    }, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method === "Runtime.exceptionThrown") {
      exceptions.push(message.params.exceptionDetails);
    }
    if (!message.id || !pending.has(message.id)) return;
    const promise = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) promise.reject(new Error(message.error.message));
    else promise.resolve(message.result);
  });

  return {
    socket,
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
  };
}

async function evaluate(connection, expression) {
  const response = await connection.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.text ?? "页面表达式执行失败");
  }
  return response.result.value;
}

async function waitForCondition(connection, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(connection, expression)) return;
    await delay(100);
  }
  throw new Error(`等待页面状态超时: ${expression}`);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function arrayCorrelation(first, second) {
  const length = Math.min(first.length, second.length);
  const firstMean = first.slice(0, length)
    .reduce((sum, value) => sum + value, 0) / length;
  const secondMean = second.slice(0, length)
    .reduce((sum, value) => sum + value, 0) / length;
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
