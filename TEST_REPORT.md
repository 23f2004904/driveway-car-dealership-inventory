# Test report

Verification completed on 2026-10-25.

## Backend API

Command: `python -m pytest -q`

| Result | Count |
| --- | ---: |
| Passed | 6 |
| Failed | 0 |

Coverage includes registration and login, token-protected inventory access, duplicate registration and password validation, vehicle search and updates, purchase stock decrement and out-of-stock rejection, and admin-only restock/delete behavior.

Result: **6 passed**.

## Frontend

Command: `npm run build --prefix frontend`

Result: **passed** (`tsc -b` and Vite production bundle, 0.62 s).

## Dependency audit

Command: `npm audit --prefix frontend`

Result: **0 vulnerabilities**.

## Browser smoke test

Started the API and SPA locally, signed in as the configured administrator, added a Honda Civic through the UI, and verified the new vehicle, category filter option, stock count, price, and admin controls appeared in the catalogue.
