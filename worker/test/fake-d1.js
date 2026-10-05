// In-memory stand-in for the D1 binding, backed by a plain array of rows.
//
// It implements the slice of the D1 API that src/index.js uses
// (prepare().bind().first()/all()/run()) and understands exactly the SQL
// statements the Worker sends, matched by shape. Anything else throws, so a
// changed query fails the tests loudly instead of passing by accident.
// Like real D1 it rejects `undefined` bindings, a wrong number of bindings and
// NULLs in NOT NULL columns.

const LOBBY_COLUMNS = ['id', 't', 'who', 'result', 'verdict', 'view',
  'share', 'global_share', 'am_share', 'lb_updated_at'];
const NOT_NULL = ['t', 'who', 'result', 'verdict', 'view'];

export function createFakeD1() {
  const rows = [];
  let lastId = 0;

  const statements = [
    {
      pattern: /^INSERT INTO lobbies \(t, who, result, verdict, view, share, global_share, am_share, lb_updated_at\) SELECT \?1, \?2, \?3, \?4, \?5, \?6, \?7, \?8, \?9 WHERE NOT EXISTS \(SELECT 1 FROM lobbies WHERE who = \?2 AND t > \?10\) RETURNING id$/,
      exec([t, who, result, verdict, view, share, globalShare, amShare, lbUpdatedAt, after]) {
        if (rows.some((row) => row.who === who && row.t > after)) return { results: [], changes: 0 };
        const row = { id: ++lastId, t, who, result, verdict, view, share,
          global_share: globalShare, am_share: amShare, lb_updated_at: lbUpdatedAt };
        for (const column of NOT_NULL) {
          if (row[column] == null) throw new Error(`NOT NULL constraint failed: lobbies.${column}`);
        }
        rows.push(row);
        return { results: [{ id: row.id }], changes: 1 };
      },
    },
    {
      pattern: /^SELECT MAX\(t\) AS t FROM lobbies WHERE who = \?$/,
      exec([who]) {
        const times = rows.filter((row) => row.who === who).map((row) => row.t);
        return { results: [{ t: times.length ? Math.max(...times) : null }], changes: 0 };
      },
    },
    {
      pattern: /^DELETE FROM lobbies WHERE id = \?$/,
      exec([id]) {
        const index = rows.findIndex((row) => row.id === id);
        if (index === -1) return { results: [], changes: 0 };
        rows.splice(index, 1);
        return { results: [], changes: 1 };
      },
    },
    {
      pattern: /^SELECT (.+) FROM lobbies WHERE t >= \? ORDER BY t, id$/,
      exec([since], [, columnList]) {
        const columns = columnList.split(', ');
        for (const column of columns) {
          if (!LOBBY_COLUMNS.includes(column)) throw new Error(`no such column: ${column}`);
        }
        const results = rows
          .filter((row) => row.t >= since)
          .sort((a, b) => a.t - b.t || a.id - b.id)
          .map((row) => Object.fromEntries(columns.map((column) => [column, row[column]])));
        return { results, changes: 0 };
      },
    },
  ];

  function execute(sql, params) {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    for (const statement of statements) {
      const match = normalized.match(statement.pattern);
      if (!match) continue;
      const expected = countParameters(normalized);
      if (params.length !== expected) {
        throw new Error(`Wrong number of parameter bindings: expected ${expected}, got ${params.length}`);
      }
      return statement.exec(params, match);
    }
    throw new Error(`fake D1 does not understand: ${normalized}`);
  }

  class Statement {
    constructor(sql, params = []) {
      this.sql = sql;
      this.params = params;
    }

    bind(...params) {
      for (const value of params) {
        if (value === undefined) throw new TypeError("D1_TYPE_ERROR: Type 'undefined' not supported");
      }
      return new Statement(this.sql, params);
    }

    async first(column) {
      const row = execute(this.sql, this.params).results[0] ?? null;
      return column === undefined ? row : (row?.[column] ?? null);
    }

    async all() {
      const { results, changes } = execute(this.sql, this.params);
      return { success: true, results, meta: { changes, last_row_id: lastId } };
    }

    async run() {
      return this.all();
    }
  }

  return {
    rows,
    prepare: (sql) => new Statement(sql),
  };
}

// Highest ?NNN wins; otherwise count anonymous ? placeholders.
function countParameters(sql) {
  const numbered = [...sql.matchAll(/\?(\d+)/g)].map((match) => Number(match[1]));
  return numbered.length ? Math.max(...numbered) : (sql.match(/\?/g) ?? []).length;
}
