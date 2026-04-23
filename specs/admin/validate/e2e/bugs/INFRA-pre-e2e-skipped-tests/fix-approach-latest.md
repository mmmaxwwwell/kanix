Two-part fix for the skipped test "Reservation expiry race -- re-reserved (FR-E008)":

1. **Split test file**: Moved the second describe block ("re-reserved" scenario) from `reservation-expiry-race.integration.test.ts` into a new file `reservation-expiry-rereserve.integration.test.ts`. The original file had two describe blocks that each created their own TestServer/DB connection; the second describe's `beforeAll` was failing intermittently due to resource contention from incomplete cleanup of the first describe's server. Splitting into separate files gives each test its own vitest worker, eliminating the contention.

2. **Fix test reporter false-skip logic**: Changed `test-reporter.ts` to check `task.mode` (explicit skip/todo) BEFORE checking result state. Previously, tests with no result (e.g., due to beforeAll failure) defaulted to "skipped" status. Now they correctly report as "failed", preventing false zero-skips violations and making setup failures visible instead of hidden.
