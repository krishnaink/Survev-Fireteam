# Fireteam leaderboard update

Based on `main` at `d6be04d`.

The main-page board shows the saved squad-creation name, falling back to the existing generated player-name label. Click or keyboard-activate a row for the ranked run's kills, downs, revives and roster. API ranking is preserved, including difficulty as a tiebreaker.

The stats page shows combat counters alongside rounds, difficulty and elapsed time. Expand a row for operator contributions, server, version and submission date. On phones, secondary columns move into expanded details.

Counters describe the run that earned the displayed score. Named-team counters sum only that run's team, identified by game and team ID. Individual entries use that run's player ID. Downs means times downed; revives counts teammates revived. Older rows retain their kills and show `—` for counters that were not recorded. A team's counter stays unknown when any member's counter is missing.

## Database upgrade

- SQLite: `downs` and `revives` are added automatically when the store opens.
- MariaDB: the startup schema bootstrap adds both nullable columns to existing tables.
- PostgreSQL: apply the normal migration before starting the updated server:

  ```sh
  bun run --cwd server db:migrate
  ```

- MongoDB: no schema migration is needed. New match documents include the counters.

Restart the API and game processes together. Missing counters are intentionally nullable; historical downs and revives cannot be reconstructed.

## Verification

Run `bun run --cwd tests test --run src/leaderboard.test.ts src/scoreboard.test.ts` with Bun available in PATH. The leaderboard tests exercise the actual SQLite store in isolated temporary databases, including an old-table upgrade. They also execute the parameterized PostgreSQL and MariaDB ranking queries against fixture data in SQLite and check each driver's result envelope. These checks do not replace testing against live PostgreSQL, MariaDB or MongoDB services.

Browser checks cover both real pages with seeded local API results, keyboard expansion, mode filters, a separate private mobile session and horizontal overflow. No fixture scores are included in the patch.

The layout follows the approved preview. Access to the live survev.io and surviv.io reference pages was blocked in the development environment.
