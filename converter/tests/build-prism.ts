// Builds minimal Prism 10 `.prism` files in memory, for the abstract-layer
// unit tests (tests/unit.ts). No real files: every part of the input model
// is a field on a spec — table format, data format, subcolumn source,
// row titles, title shapes, X shapes, analyses — so a test pins behaviour
// by constructing the exact input it cares about and feeding the buffer
// straight to `convertPrism`.
//
// A `.prism` file is a ZIP of:
//   document.json                        — sheets + sheetAttributesMap
//   data/sheets/<sheetUid>/sheet.json   — title + table descriptor
//   data/tables/<tableUid>/content.json — numberOfColumns / numberOfRows
//   data/tables/<tableUid>/data.csv     — the values
//   data/sets/<setUid>.json             — title, format, replicates /
//                                          "replicate ranges", date conversion
//   analyses/<uid>/sheet.json          — title, analysisClass, inputs
//   analyses/<uid>/parameters.json     — analysis parameters
//
// UIDs are deterministic per build (SHEET-01, TABLE-01, SET-01, …) so tests
// can reference them. Fields left `undefined` are omitted from the JSON,
// exactly as a file that doesn't carry them would read.

import JSZip from "jszip";

export interface DataSetSpec {
  uid?: string;
  /** Plain string, rich-text object { string, version, formatting }, or
   *  any other JSON value — the converter must cope with all of them. */
  title?: unknown;
  format?: string;
  /** `replicates` array: its length is the subcolumn count. */
  replicates?: unknown[];
  /** "replicate ranges" as Prism writes them: "0~2" = three, "0" = one. */
  replicateRanges?: string[];
  dateTimeConversion?: { units?: string; zeroDate?: string };
  /** Omit the dataset JSON entirely (the file references a missing set). */
  missing?: boolean;
}

export interface TableSpec {
  sheetUid?: string;
  tableUid?: string;
  /** Plain string, rich-text object, or any other JSON value. */
  sheetTitle?: unknown;
  /** Title as it appears in document.json's sheetAttributesMap (the
   *  fallback when the sheet has no title of its own). */
  mapTitle?: unknown;
  mapTitlePresent?: boolean;
  format?: string;
  dataFormat?: string;
  replicatesCount?: number;
  /** The X dataset. `missing: true` writes the reference but no JSON. */
  x?: DataSetSpec;
  /** A row-titles dataset exists (table.rowTitlesDataSet is set). The
   *  CSV's first column is then row titles. */
  rowTitles?: boolean;
  sets: DataSetSpec[];
  /** Raw CSV rows; `null` is an empty cell. */
  csv: (string | null)[][];
  /** CRLF line endings instead of LF. */
  crlf?: boolean;
  /** content.json overrides; default is the CSV's own shape. */
  rows?: number;
  cols?: number;
  contentMissing?: boolean;
  csvMissing?: boolean;
  sheetMissing?: boolean;
}

export interface AnalysisSpec {
  uid?: string;
  title?: unknown;
  analysisClass?: string;
  /** Input table sheet uid; defaults to the first table. `null` means no
   *  inputSheets at all; a bogus uid means an input that isn't in the file. */
  inputSheetUid?: string | null;
  inputDataSets?: { uid?: string; title?: unknown }[];
  /** parameters.json content; `undefined` means no parameters file. */
  params?: unknown;
  sheetMissing?: boolean;
}

export interface ProjectSpec {
  version?: string;
  formatVersion?: string;
  tables: TableSpec[];
  analyses?: AnalysisSpec[];
  graphs?: string[];
  layouts?: string[];
  info?: string[];
  /** Sheets present in the ZIP but NOT listed in document.json. */
  orphanSheets?: TableSpec[];
  /** Table dirs present in the ZIP with no sheet pointing at them. */
  extraTables?: { uid: string; csv: (string | null)[][]; rows?: number; cols?: number }[];
  /** Omit document.json entirely. */
  noDocument?: boolean;
  /** document.json content as a raw string (for invalid-JSON tests). */
  documentRaw?: string;
}

/** Encode rows as CSV text: quote fields holding a comma, quote, CR or LF. */
export function csvEncode(rows: (string | null)[][], crlf = false): string {
  const eol = crlf ? "\r\n" : "\n";
  return (
    rows
      .map((row) =>
        row
          .map((cell) => {
            const v = cell ?? "";
            return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
          })
          .join(","),
      )
      .join(eol) + (rows.length ? eol : "")
  );
}

function setJson(zip: JSZip, path: string, value: unknown): void {
  zip.file(path, JSON.stringify(value, null, 2));
}

/** 7 hex digits: UIDs stay UUID-shaped ([0-9A-F-]+) for the converter's
 *  orphan scan. */
const hex = (v: number): string => v.toString(16).toUpperCase().padStart(7, "0");

function writeTable(zip: JSZip, spec: TableSpec, n: number): { sheetUid: string; tableUid: string } {
  // UIDs are hex-only (A–F, 0–9): the converter's orphan scan matches
  // UUID-shaped UIDs ([0-9A-F-]+), and a test UID with other letters
  // would silently never be counted as an orphan.
  const sheetUid = spec.sheetUid ?? `A${hex(n)}`;
  const tableUid = spec.tableUid ?? `B${hex(n)}`;
  const setUids: string[] = [];
  spec.sets.forEach((set, i) => {
    const uid = set.uid ?? `C${hex(n * 8 + i + 1)}`;
    setUids.push(uid);
    if (!set.missing) {
      setJson(zip, `data/sets/${uid}.json`, {
        title: set.title,
        format: set.format,
        replicates: set.replicates,
        "replicate ranges": set.replicateRanges?.map((range) => ({ range })),
        dateTimeConversion: set.dateTimeConversion,
      });
    }
  });
  let xUid: string | undefined;
  if (spec.x) {
    xUid = spec.x.uid ?? `D${hex(n)}`;
    if (!spec.x.missing) {
      setJson(zip, `data/sets/${xUid}.json`, {
        title: spec.x.title,
        format: spec.x.format,
        replicates: spec.x.replicates,
        "replicate ranges": spec.x.replicateRanges?.map((range) => ({ range })),
        dateTimeConversion: spec.x.dateTimeConversion,
      });
    }
  }
  let rowTitlesUid: string | undefined;
  if (spec.rowTitles) {
    rowTitlesUid = `E${hex(n)}`;
    setJson(zip, `data/sets/${rowTitlesUid}.json`, { title: "Row titles", replicates: [] });
  }
  if (!spec.sheetMissing) {
    setJson(zip, `data/sheets/${sheetUid}/sheet.json`, {
      title: spec.sheetTitle,
      table: {
        uid: tableUid,
        format: spec.format,
        dataFormat: spec.dataFormat,
        replicatesCount: spec.replicatesCount,
        dataSets: setUids,
        xDataSet: xUid,
        rowTitlesDataSet: rowTitlesUid,
      },
    });
  }
  if (!spec.contentMissing) {
    setJson(zip, `data/tables/${tableUid}/content.json`, {
      numberOfColumns: spec.cols ?? spec.csv[0]?.length ?? 0,
      numberOfRows: spec.rows ?? spec.csv.length,
    });
  }
  if (!spec.csvMissing) {
    zip.file(`data/tables/${tableUid}/data.csv`, csvEncode(spec.csv, spec.crlf ?? false));
  }
  return { sheetUid, tableUid };
}

export async function buildPrism(spec: ProjectSpec): Promise<Buffer> {
  const zip = new JSZip();
  const dataUids: string[] = [];
  const sheetAttributesMap: Record<string, { title?: unknown }> = {};
  spec.tables.forEach((table, i) => {
    const { sheetUid } = writeTable(zip, table, i + 1);
    dataUids.push(sheetUid);
    if (table.mapTitlePresent) sheetAttributesMap[sheetUid] = { title: table.mapTitle };
  });
  (spec.orphanSheets ?? []).forEach((table, i) => {
    writeTable(zip, table, 100 + i);
  });
  for (const extra of spec.extraTables ?? []) {
    setJson(zip, `data/tables/${extra.uid}/content.json`, {
      numberOfColumns: extra.cols ?? extra.csv[0]?.length ?? 0,
      numberOfRows: extra.rows ?? extra.csv.length,
    });
    zip.file(`data/tables/${extra.uid}/data.csv`, csvEncode(extra.csv));
  }
  const analysisUids: string[] = [];
  (spec.analyses ?? []).forEach((analysis, i) => {
    const uid = analysis.uid ?? `F${hex(i + 1)}`;
    analysisUids.push(uid);
    if (!analysis.sheetMissing) {
      const inputUid =
        analysis.inputSheetUid === null
          ? undefined
          : (analysis.inputSheetUid ?? dataUids[0]);
      setJson(zip, `analyses/${uid}/sheet.json`, {
        title: analysis.title,
        analysisClass: analysis.analysisClass,
        inputSheets: inputUid === undefined ? undefined : [{ uid: inputUid }],
        inputDataSets: analysis.inputDataSets,
      });
    }
    if (analysis.params !== undefined) {
      setJson(zip, `analyses/${uid}/parameters.json`, analysis.params);
    }
  });
  if (!spec.noDocument) {
    const doc = {
      createdBy: { version: spec.version ?? "10.0.0" },
      formatVersion: spec.formatVersion ?? "10",
      sheets: {
        graphs: spec.graphs ?? [],
        layouts: spec.layouts ?? [],
        analyses: analysisUids,
        info: spec.info ?? [],
        data: dataUids,
      },
      sheetAttributesMap,
    };
    zip.file("document.json", spec.documentRaw ?? JSON.stringify(doc, null, 2));
  }
  return zip.generateAsync({ type: "nodebuffer" });
}
