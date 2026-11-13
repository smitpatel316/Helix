// A small CSV reader: quoted fields, embedded commas, CRLF or LF endings.
// Prism's data.csv files are plain comma-separated values; row titles can
// contain commas, so a naive split would break. No dependency.

/** Parse CSV text into rows of cell strings. A trailing empty line is dropped;
 *  an empty field is "" (the caller turns "" into null). A leading byte-order
 *  mark is file encoding, not data — it is stripped, so the first cell of
 *  the first row never carries a stray "\uFEFF". */
export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const n = text.length;
  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };
  while (i < n) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          quoted = false;
          i++;
        }
      } else {
        field += c;
        i++;
      }
    } else if (c === '"') {
      quoted = true;
      i++;
    } else if (c === ",") {
      endField();
      i++;
    } else if (c === "\r") {
      // CRLF or lone CR ends the row.
      if (text[i + 1] === "\n") i++;
      endRow();
      i++;
    } else if (c === "\n") {
      endRow();
      i++;
    } else {
      field += c;
      i++;
    }
  }
  // Last row without a trailing newline.
  if (field !== "" || row.length > 0) endRow();
  // No rows are dropped here: a trailing all-empty row is real data (or a
  // file's trailing newline, which the caller trims against content.json's
  // numberOfRows). The parser stays dumb; the converter decides.
  return rows;
}
