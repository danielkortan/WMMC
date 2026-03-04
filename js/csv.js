// ============================================================
// CSV Parsing Helpers
// ============================================================

export function parseCSVFile(file, callback) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) { alert('CSV file appears empty.'); return; }

    const headers = parseCSVLine(lines[0]).map(h => h.trim().toLowerCase());
    const nameCol = headers.findIndex(h =>
      h === 'name' || h === 'player' || h === 'player_name' || h === 'playername' || h === 'batter' || h === 'pitcher'
    );

    if (nameCol === -1) {
      const names = [];
      for (let i = 1; i < lines.length; i++) {
        const cols = parseCSVLine(lines[i]);
        if (cols[0] && cols[0].trim()) names.push(cols[0].trim());
      }
      callback(names);
      return;
    }

    const names = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = parseCSVLine(lines[i]);
      if (cols[nameCol] && cols[nameCol].trim()) names.push(cols[nameCol].trim());
    }
    callback(names);
  };
  reader.readAsText(file);
}

export function parseCSVFileWithStats(file, callback) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) { alert('CSV file appears empty.'); return; }

    const headers = parseCSVLine(lines[0]).map(h => h.trim());
    const rows = [];

    for (let i = 1; i < lines.length; i++) {
      const cols = parseCSVLine(lines[i]);
      const row = {};
      headers.forEach((h, j) => {
        row[h] = (cols[j] || '').trim();
      });
      rows.push(row);
    }
    callback(rows);
  };
  reader.readAsText(file);
}

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
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        result.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  result.push(current);
  return result;
}

export function findColumn(row, possibleNames) {
  for (const name of possibleNames) {
    for (const key of Object.keys(row)) {
      if (key.toLowerCase() === name.toLowerCase()) return row[key];
    }
  }
  return null;
}

export function parseNum(val) {
  const n = parseFloat(val);
  return isNaN(n) ? 0 : n;
}
