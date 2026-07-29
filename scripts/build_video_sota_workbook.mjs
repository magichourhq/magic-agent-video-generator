import fs from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const outDir = path.resolve(process.argv[2] ?? "benchmark_artifacts/video_sota_20260508");
const workbookPath = path.join(outDir, "ai_video_sota_benchmark_2026-05-08.xlsx");

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') {
        value += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        value += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(value);
      value = "";
    } else if (char === "\n") {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else if (char !== "\r") {
      value += char;
    }
  }
  if (value.length || row.length) {
    row.push(value);
    rows.push(row);
  }
  return rows;
}

function coerceRows(rows) {
  return rows.map((row, rowIndex) =>
    row.map((value) => {
      if (rowIndex === 0) return value;
      if (value === "") return "";
      if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
      return value;
    }),
  );
}

function styleHeader(range, fill = "#172554") {
  range.format.fill.color = fill;
  range.format.font.bold = true;
  range.format.font.color = "#FFFFFF";
  range.format.wrapText = true;
}

function setWidths(sheet, widths) {
  widths.forEach((width, index) => {
    sheet.getRangeByIndexes(0, index, 1, 1).format.columnWidthPx = width;
  });
}

async function readCsv(name) {
  return coerceRows(parseCsv(await fs.readFile(path.join(outDir, name), "utf8")));
}

const [platformRows, scenarioRows, detailRows] = await Promise.all([
  readCsv("platform_summary.csv"),
  readCsv("scenario_winners.csv"),
  readCsv("video_inference_scores.csv"),
]);

const workbook = Workbook.create();
const dashboard = workbook.worksheets.add("Dashboard");
const platform = workbook.worksheets.add("Platform Summary");
const scenarios = workbook.worksheets.add("Scenario Winners");
const details = workbook.worksheets.add("Video Scores");

platform.getRangeByIndexes(0, 0, platformRows.length, platformRows[0].length).values = platformRows;
scenarios.getRangeByIndexes(0, 0, scenarioRows.length, scenarioRows[0].length).values = scenarioRows;
details.getRangeByIndexes(0, 0, detailRows.length, detailRows[0].length).values = detailRows;

const generatedAt = new Date().toISOString();
const topPlatform = platformRows[1]?.[0] ?? "";
const topBenchmark = platformRows[1]?.[4] ?? "";
const totalVideos = detailRows.length - 1;
const generationTimeIndex = detailRows[0].indexOf("generation_time_minutes");
const generationKnown = detailRows.slice(1).filter((row) => generationTimeIndex >= 0 && row[generationTimeIndex] !== "").length;

dashboard.getRange("A1:F1").merge();
dashboard.getRange("A2:F3").merge();
dashboard.getRange("A1").values = [["AI Video SOTA Benchmark"]];
dashboard.getRange("A2").values = [[`Generated ${generatedAt}; evaluated ${totalVideos} exported videos with sampled-frame vision inference, ffprobe metadata, and audio transcription where available.`]];
dashboard.getRange("A4:B8").values = [
  ["Top platform", topPlatform],
  ["Top avg benchmark score", topBenchmark],
  ["Videos evaluated", totalVideos],
  ["Rows with known generation time", generationKnown],
  ["Timing caveat", "External exported MP4s do not contain generation start/end timestamps; timing is scored only where run metadata exists."],
];
dashboard.getRange("A10:F10").values = [["Rank", "Platform", "Avg benchmark", "Avg quality", "Format fit", "Known timing rows"]];
const dashboardRows = platformRows.slice(1).map((row) => [row.at(-1), row[0], row[4], row[3], row[5], row[11]]);
dashboard.getRangeByIndexes(10, 0, dashboardRows.length, 6).values = dashboardRows;

dashboard.getRange("H10:I10").values = [["Platform", "Avg benchmark"]];
dashboard.getRangeByIndexes(10, 7, dashboardRows.length, 2).values = dashboardRows.map((row) => [row[1], row[2]]);
const chart = dashboard.charts.add("bar", dashboard.getRangeByIndexes(9, 7, dashboardRows.length + 1, 2));
chart.title = "Average Benchmark Score by Platform";
chart.hasLegend = false;
chart.xAxis = { axisType: "textAxis" };
chart.yAxis = { numberFormatCode: "0.0" };
chart.setPosition("H2", "N16");

dashboard.getRange("A1:H1").format.fill.color = "#111827";
dashboard.getRange("A1:H1").format.font.color = "#FFFFFF";
dashboard.getRange("A1:H1").format.font.bold = true;
dashboard.getRange("A1:H2").format.wrapText = true;
styleHeader(dashboard.getRange("A10:F10"), "#1F2937");
styleHeader(platform.getRangeByIndexes(0, 0, 1, platformRows[0].length));
styleHeader(scenarios.getRangeByIndexes(0, 0, 1, scenarioRows[0].length));
styleHeader(details.getRangeByIndexes(0, 0, 1, detailRows[0].length));

dashboard.freezePanes.freezeRows(10);
platform.freezePanes.freezeRows(1);
scenarios.freezePanes.freezeRows(1);
details.freezePanes.freezeRows(1);
details.freezePanes.freezeColumns(4);

setWidths(dashboard, [180, 180, 120, 120, 110, 160, 28, 180, 120]);
setWidths(platform, [140, 90, 90, 120, 130, 120, 120, 120, 130, 220, 120, 130, 120, 120, 120, 560, 100]);
setWidths(scenarios, [130, 220, 90, 140, 260, 120, 140, 700]);
setWidths(details, [
  260, 110, 130, 220, 260, 520, 170, 720, 90, 90, 90, 80, 80, 110, 100, 90, 90, 90,
  100, 90, 90, 100, 90, 360, 90, 90, 90, 90, 90, 90, 90, 90, 110, 110, 120, 130, 100,
  260, 420, 700, 700, 520, 360, 100, 140,
]);

for (const sheet of [dashboard, platform, scenarios, details]) {
  const usedRows = sheet === dashboard ? 20 : Math.max(2, sheet === platform ? platformRows.length : sheet === scenarios ? scenarioRows.length : detailRows.length);
  const usedCols = sheet === dashboard ? 14 : sheet === platform ? platformRows[0].length : sheet === scenarios ? scenarioRows[0].length : detailRows[0].length;
  sheet.getRangeByIndexes(0, 0, usedRows, usedCols).format.wrapText = true;
}

const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 100 },
  summary: "final formula error scan",
});
console.log(errors.ndjson);

const dashboardCheck = await workbook.inspect({
  kind: "table",
  range: "Dashboard!A1:F16",
  include: "values,formulas",
  tableMaxRows: 20,
  tableMaxCols: 8,
  maxChars: 3000,
});
console.log(dashboardCheck.ndjson);

for (const [sheetName, range] of [
  ["Dashboard", "A1:N18"],
  ["Platform Summary", "A1:Q8"],
  ["Scenario Winners", "A1:H16"],
  ["Video Scores", "A1:AS20"],
]) {
  const preview = await workbook.render({ sheetName, range, scale: 1, format: "png" });
  const safeName = sheetName.toLowerCase().replaceAll(" ", "_");
  await fs.writeFile(path.join(outDir, `${safeName}_preview.png`), new Uint8Array(await preview.arrayBuffer()));
}

const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(workbookPath);
console.log(workbookPath);
