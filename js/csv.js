// ============================================================
// WMMC — CSV parsing helpers
// ============================================================

// Parse a single line of CSV into an array of fields, respecting quoted
// fields and escaped quotes ("").
export function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

// Look up a value in a row object by trying multiple column-name variants
// (case-insensitive). Returns the first match or null.
export function findColumn(row, possibleNames) {
  for (const name of possibleNames) {
    for (const key of Object.keys(row)) {
      if (key.toLowerCase() === name.toLowerCase()) return row[key];
    }
  }
  return null;
}
