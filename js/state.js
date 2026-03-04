// ============================================================
// Centralized State Management
// ============================================================

const state = {
  data: null,              // Data for the currently viewed season (historical)
  currentYear: new Date().getFullYear(),
  selectedSeason: null,
  commissionerEmail: null,
  rosterEmail: null,
  loggedInEmail: null,
  rosterViewingManager: null,
};

// Google Sign-In Client ID — set this to enable Google login
export const GOOGLE_CLIENT_ID = '';

// Scoring rubric (constant)
export const SCORING = {
  batting: { '1B': 3, '2B': 5, '3B': 8, 'HR': 10, 'R': 2, 'RBI': 2, 'SB': 5, 'BB': 2 },
  pitching: { 'W': 4, 'QS': 4, 'CG': 2.5, 'CGSO': 2.5, 'NH': 5, 'IP': 2.25, 'H': -0.6, 'ER': -2, 'BB': -0.6, 'K': 2 }
};

// The schedule structure for a season (16 weeks total)
export const SEASON_SCHEDULE = [
  { round: 'PP1', week: 'Week 1', label: 'Pool Play 1 - Week 1' },
  { round: 'PP1', week: 'Week 2', label: 'Pool Play 1 - Week 2' },
  { round: 'PP1', week: 'Week 3', label: 'Pool Play 1 - Week 3' },
  { round: 'PP1', week: 'Week 4', label: 'Pool Play 1 - Week 4' },
  { round: 'PP1', week: 'Week 5', label: 'Pool Play 1 - Week 5' },
  { round: 'PP2', week: 'Week 1', label: 'Pool Play 2 - Week 1' },
  { round: 'PP2', week: 'Week 2', label: 'Pool Play 2 - Week 2' },
  { round: 'PP2', week: 'Week 3', label: 'Pool Play 2 - Week 3' },
  { round: 'PP2', week: 'Week 4', label: 'Pool Play 2 - Week 4' },
  { round: 'PP2', week: 'Week 5', label: 'Pool Play 2 - Week 5' },
  { round: 'QF', week: 'Week 1', label: 'Quarterfinals - Week 1' },
  { round: 'QF', week: 'Week 2', label: 'Quarterfinals - Week 2' },
  { round: 'SF', week: 'Week 1', label: 'Semifinals - Week 1' },
  { round: 'SF', week: 'Week 2', label: 'Semifinals - Week 2' },
  { round: 'Finals', week: 'Week 1', label: 'Finals / 3rd Place - Week 1' },
  { round: 'Finals', week: 'Week 2', label: 'Finals / 3rd Place - Week 2' },
];

export default state;
