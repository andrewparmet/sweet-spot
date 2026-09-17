import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import type {
  MatchSubmissionResponse,
  UndoSubmissionRequest,
  UndoSubmissionResponse
} from '../packages/shared/src/match.ts';
import { INITIAL_QUEUE_STATUS, type QueueRecord } from '../packages/shared/src/queue.ts';
import { isoWeekTabName, normalizeScore, validateSubmission } from '../apps/intake/src/server.ts';
import { appsScriptComponents } from './components.ts';
import { appendLocalRecord, withdrawLocalRecord } from './local-queue.ts';

const PORT = 4173;
const MAX_REQUEST_BYTES = 20_000;
const htmlPath = path.join(appsScriptComponents.intake.distDirectory, 'Index.html');
const mockAppsScript = `<script>
  (() => {
    class LocalRunner {
      withSuccessHandler(handler) { this.successHandler = handler; return this; }
      withFailureHandler(handler) { this.failureHandler = handler; return this; }
      async submitMatch(payload) {
        try {
          const response = await fetch('/api/submissions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          const body = await response.json();
          if (!response.ok) throw new Error(body.message || 'Submission failed.');
          this.successHandler?.(body);
        } catch (error) {
          this.failureHandler?.(error);
        }
      }
      async undoSubmission(payload) {
        try {
          const response = await fetch('/api/submissions/undo', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          const body = await response.json();
          if (!response.ok) throw new Error(body.message || 'Undo failed.');
          this.successHandler?.(body);
        } catch (error) {
          this.failureHandler?.(error);
        }
      }
    }
    window.google = { script: { run: new LocalRunner() } };
  })();
</script>`;

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/') {
      const html = (await readFile(htmlPath, 'utf8')).replace('</head>', `${mockAppsScript}</head>`);
      send(response, 200, 'text/html; charset=utf-8', html);
      return;
    }
    if (request.method === 'POST' && request.url === '/api/submissions') {
      const payload = JSON.parse(await readBody(request));
      const submission = validateSubmission(payload);
      const now = new Date();
      const matchDate = bostonDate(now);
      const timestamp = now.toISOString();
      const record: QueueRecord = {
        submissionId: randomUUID(),
        requestId: submission.requestId,
        submittedAt: timestamp,
        matchDate,
        courtId: 36,
        matchType: submission.matchType,
        side1Player1: submission.side1Player1,
        side1Player2: submission.side1Player2,
        side2Player1: submission.side2Player1,
        side2Player2: submission.side2Player2,
        scoreOriginal: submission.score,
        handicapEntryType: submission.handicapType,
        handicapOriginal: submission.handicap,
        tournament: submission.tournament,
        status: INITIAL_QUEUE_STATUS,
        scoreNormalized: normalizeScore(submission.score),
        rtoPlayerIds: '',
        rtoHandicapDifference: '',
        rtoMatchId: '',
        lastError: '',
        updatedAt: timestamp
      };
      const stored = await appendLocalRecord(isoWeekTabName(matchDate), record);
      const result: MatchSubmissionResponse = {
        submissionId: stored.submissionId,
        accepted: true
      };
      send(response, 200, 'application/json', JSON.stringify(result));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/submissions/undo') {
      const payload = JSON.parse(await readBody(request)) as Partial<UndoSubmissionRequest>;
      if (!payload.submissionId || !payload.requestId) {
        throw new Error('The undo request is incomplete.');
      }
      await withdrawLocalRecord(payload.submissionId, payload.requestId, new Date().toISOString());
      const result: UndoSubmissionResponse = { withdrawn: true };
      send(response, 200, 'application/json', JSON.stringify(result));
      return;
    }
    send(response, 404, 'text/plain; charset=utf-8', 'Not found');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Request failed.';
    send(response, 400, 'application/json', JSON.stringify({ message }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Sweet Spot intake is available at http://127.0.0.1:${PORT}`);
  console.log('Local submissions are written to local-data/<ISO week>.json.');
});

function send(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': contentType
  });
  response.end(body);
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of request) {
    body += String(chunk);
    if (body.length > MAX_REQUEST_BYTES) {
      throw new Error('Request is too large.');
    }
  }
  return body;
}

function bostonDate(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'America/New_York',
    year: 'numeric'
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find(value => value.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}
