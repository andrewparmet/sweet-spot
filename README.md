# sweet-spot

Sweet Spot is a mobile match-entry queue for court tennis scores. Every component lives in this repository and is built,
tested, and published through the root scripts.

## Components

- `apps/intake`: public mobile Apps Script application for player submissions
- `apps/admin`: private score-review application
- `packages/shared`: request, response, and queue types shared by every component
- `tools`: TypeScript build and publishing commands

The admin application currently has a local review and demo-submission workflow. Its Apps Script deployment and live RTO
integration will follow the local prototype.

## Commands

```shell
npm install
npm run check
npm run format
npm run seed:local
npm run inspect:local
npm run dev:intake
npm run dev:admin
```

The local intake application is served at <http://127.0.0.1:4173>, and the local admin application is served at
<http://127.0.0.1:4174>. Submissions are written to ignored JSON files under `local-data/`, with one file representing each
weekly Sheet tab. The admin demo directory is cached in browser `sessionStorage` and cleared when the tab closes.

The intake form enforces required match data in the browser and on the server. After submission, the receipt screen can
withdraw the queue row and restore the form for correction. Withdrawn rows remain in the queue for audit purposes and are
excluded from the admin inbox.

## Google deployments

Staging and production use separate Apps Script projects, deployments, and queue spreadsheets:

```shell
npx clasp login
npm run create:intake:staging
npm run publish:intake:staging
npm run create:intake:production
npm run publish:intake:production
```

Run `setupStaging_` once in the staging project and `setupProduction_` once in the production project. Each publish command
runs type checking, tests, and the production build before pushing generated artifacts and updating that environment's
stable deployment.

The setup function creates the private queue spreadsheet and logs its URL. Scores are grouped into ISO-week tabs such as
`2026-W38`. The review application will scan every weekly tab and present one inbox containing every row that is neither
`Submitted` nor `Withdrawn`.

The intake manifest deploys each web app as the project owner with anonymous access. Deployment IDs are stored independently
under `apps/intake/`.

## RTO administrator sessions

The private review application will authenticate directly with RTO. It will discard the password after login and keep the
RTO JWT in browser `sessionStorage` so player matching, handicap validation, duplicate checks, and submissions can share one
session. Closing the tab or choosing logout clears the token. Credentials and tokens will never be written to Sheets, Apps
Script properties, logs, or `localStorage`.
