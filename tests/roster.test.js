import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getWeekRoster, getAllRosteredPlayers, buildPlayerToManagerMap, findManagerForPlayerWeek, repairManagerAssignments, migrateRostersToWeekly } from '../js/roster.js';

describe('getWeekRoster', () => {
  it('returns empty roster when no data exists', () => {
    const result = getWeekRoster({}, 'Alice', 'PP1', 'Week 1');
    assert.deepEqual(result, { batters: [], pitchers: [] });
  });

  it('returns correct roster for a specific week', () => {
    const seasonData = {
      rosters: {
        'Alice': {
          'PP1|Week 1': { batters: ['Player A', 'Player B'], pitchers: ['Pitcher X'] },
          'PP1|Week 2': { batters: ['Player C'], pitchers: ['Pitcher Y'] },
        }
      }
    };
    const result = getWeekRoster(seasonData, 'Alice', 'PP1', 'Week 1');
    assert.deepEqual(result, { batters: ['Player A', 'Player B'], pitchers: ['Pitcher X'] });
  });

  it('returns empty roster for non-existent week', () => {
    const seasonData = {
      rosters: {
        'Alice': {
          'PP1|Week 1': { batters: ['Player A'], pitchers: [] },
        }
      }
    };
    const result = getWeekRoster(seasonData, 'Alice', 'PP2', 'Week 1');
    assert.deepEqual(result, { batters: [], pitchers: [] });
  });
});

describe('getAllRosteredPlayers', () => {
  it('returns union of all players across weeks', () => {
    const seasonData = {
      rosters: {
        'Alice': {
          'PP1|Week 1': { batters: ['A', 'B'], pitchers: ['X'] },
          'PP1|Week 2': { batters: ['B', 'C'], pitchers: ['X', 'Y'] },
        }
      }
    };
    const result = getAllRosteredPlayers(seasonData, 'Alice');
    assert.deepEqual(result.batters.sort(), ['A', 'B', 'C']);
    assert.deepEqual(result.pitchers.sort(), ['X', 'Y']);
  });
});

describe('buildPlayerToManagerMap', () => {
  it('maps players to their manager', () => {
    const seasonData = {
      rosters: {
        'Alice': {
          'PP1|Week 1': { batters: ['Player A'], pitchers: ['Pitcher X'] },
        },
        'Bob': {
          'PP1|Week 1': { batters: ['Player B'], pitchers: ['Pitcher Y'] },
        }
      }
    };
    const map = buildPlayerToManagerMap(seasonData);
    assert.equal(map['Player A'], 'Alice');
    assert.equal(map['Pitcher X'], 'Alice');
    assert.equal(map['Player B'], 'Bob');
    assert.equal(map['Pitcher Y'], 'Bob');
  });
});

describe('findManagerForPlayerWeek', () => {
  const seasonData = {
    rosters: {
      'Alice': {
        'PP1|Week 1': { batters: ['Player A'], pitchers: ['Pitcher X'] },
        'PP1|Week 2': { batters: ['Player B'], pitchers: ['Pitcher X'] },
      },
      'Bob': {
        'PP1|Week 1': { batters: ['Player B'], pitchers: ['Pitcher Y'] },
      }
    }
  };

  it('finds correct manager for a batter in a specific week', () => {
    assert.equal(findManagerForPlayerWeek(seasonData, 'Player A', 'batting', 'PP1', 'Week 1'), 'Alice');
    assert.equal(findManagerForPlayerWeek(seasonData, 'Player B', 'batting', 'PP1', 'Week 1'), 'Bob');
  });

  it('finds correct manager for a pitcher', () => {
    assert.equal(findManagerForPlayerWeek(seasonData, 'Pitcher X', 'pitching', 'PP1', 'Week 1'), 'Alice');
    assert.equal(findManagerForPlayerWeek(seasonData, 'Pitcher Y', 'pitching', 'PP1', 'Week 1'), 'Bob');
  });

  it('returns null for unrostered player', () => {
    assert.equal(findManagerForPlayerWeek(seasonData, 'Unknown Player', 'batting', 'PP1', 'Week 1'), null);
  });
});

describe('repairManagerAssignments', () => {
  it('repairs null manager assignments from roster data', () => {
    const seasonData = {
      rosters: {
        'Alice': {
          'PP1|Week 1': { batters: ['Player A'], pitchers: ['Pitcher X'] },
        }
      },
      weekly_batting: [
        { batter: 'Player A', manager: null, round: 'PP1', week: 'Week 1' },
      ],
      weekly_pitching: [
        { pitcher: 'Pitcher X', manager: null, round: 'PP1', week: 'Week 1' },
      ]
    };

    const result = repairManagerAssignments(seasonData);
    assert.equal(result, true);
    assert.equal(seasonData.weekly_batting[0].manager, 'Alice');
    assert.equal(seasonData.weekly_pitching[0].manager, 'Alice');
  });

  it('does not overwrite existing manager assignments', () => {
    const seasonData = {
      rosters: {
        'Alice': {
          'PP1|Week 1': { batters: ['Player A'], pitchers: [] },
        }
      },
      weekly_batting: [
        { batter: 'Player A', manager: 'Bob', round: 'PP1', week: 'Week 1' },
      ],
      weekly_pitching: []
    };

    const result = repairManagerAssignments(seasonData);
    assert.equal(result, false);
    assert.equal(seasonData.weekly_batting[0].manager, 'Bob');
  });

  it('skips completed seasons', () => {
    const seasonData = {
      status: 'completed',
      rosters: {},
      weekly_batting: [],
      weekly_pitching: []
    };
    assert.equal(repairManagerAssignments(seasonData), false);
  });
});

describe('migrateRostersToWeekly', () => {
  it('converts flat roster format to per-week format', () => {
    const seasonData = {
      rosters: {
        'Alice': {
          batters: ['Player A', 'Player B'],
          pitchers: ['Pitcher X']
        }
      },
      weekly_batting: [
        { manager: 'Alice', round: 'PP1', week: 'Week 1' }
      ],
      weekly_pitching: []
    };

    migrateRostersToWeekly(seasonData);
    assert.ok(!Array.isArray(seasonData.rosters['Alice'].batters));
    const weekRoster = seasonData.rosters['Alice']['PP1|Week 1'];
    assert.deepEqual(weekRoster.batters, ['Player A', 'Player B']);
    assert.deepEqual(weekRoster.pitchers, ['Pitcher X']);
  });

  it('does nothing for already-migrated rosters', () => {
    const seasonData = {
      rosters: {
        'Alice': {
          'PP1|Week 1': { batters: ['Player A'], pitchers: ['Pitcher X'] }
        }
      }
    };

    migrateRostersToWeekly(seasonData);
    assert.deepEqual(seasonData.rosters['Alice']['PP1|Week 1'], { batters: ['Player A'], pitchers: ['Pitcher X'] });
  });
});
