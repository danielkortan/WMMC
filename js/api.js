// ============================================================
// Server API calls
// ============================================================

import state from './state.js';

function userEmailHeader() {
  const headers = { 'Content-Type': 'application/json' };
  if (state.loggedInEmail) {
    headers['X-User-Email'] = state.loggedInEmail;
  }
  return headers;
}

// ---- Data helpers (localStorage cache + server persistence) ----

export function getSeasons() {
  return JSON.parse(localStorage.getItem('wmmc_seasons') || '{}');
}

export function saveSeason(year, data) {
  const seasons = getSeasons();
  seasons[year] = data;
  localStorage.setItem('wmmc_seasons', JSON.stringify(seasons));
  fetch('/api/seasons/' + year, {
    method: 'POST',
    headers: userEmailHeader(),
    body: JSON.stringify(data)
  }).catch(() => {});
}

export function getManagers() {
  return JSON.parse(localStorage.getItem('wmmc_managers') || '[]');
}

export function saveManagers(managers) {
  localStorage.setItem('wmmc_managers', JSON.stringify(managers));
  fetch('/api/managers', {
    method: 'POST',
    headers: userEmailHeader(),
    body: JSON.stringify(managers)
  }).catch(() => {});
}

export async function fetchSeasons() {
  const resp = await fetch('/api/seasons');
  if (resp.ok) return resp.json();
  return null;
}

export async function fetchManagers() {
  const resp = await fetch('/api/managers');
  if (resp.ok) return resp.json();
  return null;
}

export async function sendHeartbeat(email, name) {
  return fetch('/api/heartbeat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, name })
  }).catch(() => {});
}

export async function fetchOnlineUsers() {
  const resp = await fetch('/api/online-users');
  if (resp.ok) return resp.json();
  return {};
}

export async function fetchVersion() {
  const resp = await fetch('/version.json');
  if (resp.ok) return resp.json();
  return null;
}

export async function fetchLoginPassword() {
  const resp = await fetch('/api/login-password');
  if (resp.ok) {
    const data = await resp.json();
    return data.password;
  }
  return '123';
}

// ---- Google Sheets API ----

export async function getGSheetsConfig() {
  const resp = await fetch('/api/google-sheets/config');
  if (resp.ok) return resp.json();
  return {};
}

export async function saveGSheetsConfigToServer(config) {
  return fetch('/api/google-sheets/config', {
    method: 'POST',
    headers: userEmailHeader(),
    body: JSON.stringify(config)
  });
}

export async function triggerGSheetsSyncAPI(season) {
  return fetch('/api/google-sheets/sync', {
    method: 'POST',
    headers: userEmailHeader(),
    body: JSON.stringify({ season })
  });
}

export async function getGSheetsSyncStatus() {
  const resp = await fetch('/api/google-sheets/sync-status');
  if (resp.ok) return resp.json();
  return {};
}
