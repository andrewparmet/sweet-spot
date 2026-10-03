import { readFile } from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { appsScriptComponents } from './components.ts';
import { randomUUID } from 'node:crypto';
import { appendLocalRecord, deleteLocalRecord, demoSubmitLocalRecord, readLocalTabs } from './local-queue.ts';
import { isoWeekTabName, newQueueRecord } from '../packages/shared/src/queue-sheet.ts';
import { requiredText, validateMatchDate, validateMatchFields } from '../packages/shared/src/submission.ts';
import { normalizeScore } from '../packages/shared/src/match.ts';
import { loadQueuePage, withHistoryTab, type QueueIndex } from '../apps/admin/src/queue-index.ts';

const PORT = 4174;
const MAX_REQUEST_BYTES = 20_000;
const LOCAL_TOKEN = 'local-admin-session';
const htmlPath = path.join(appsScriptComponents.admin.distDirectory, 'Index.html');
let queueIndex: QueueIndex | undefined;
const directory = [
  { id: '10001', name: 'Charlie Brown', handicap: 42.1, isBoston: true },
  { id: '10002', name: 'Lucy van Pelt', handicap: 48.4, isBoston: true },
  { id: '10003', name: 'Linus van Pelt', handicap: 43.6, isBoston: true },
  { id: '10004', name: 'Franklin Armstrong', handicap: 44.5, isBoston: true },
  { id: '10005', name: 'Patricia Reichardt', handicap: 36.3, isBoston: true },
  { id: '10006', name: 'Marcie Carlin', handicap: 46.9, isBoston: true },
  { id: '10007', name: 'Sally Brown', handicap: 51.2, isBoston: false },
  { id: '10008', name: 'Violet Gray', handicap: 45.1, isBoston: false },
  { id: '10009', name: 'Shermy Miller', handicap: 39.8, isBoston: false },
  { id: '10010', name: 'Frieda Smith', handicap: 54.2, isBoston: false },
  { id: '10011', name: 'Rerun van Pelt', handicap: 49.7, isBoston: false },
  { id: '10012', name: 'Charles Browning', handicap: 37.3, isBoston: false }
];

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/') {
      send(response, 200, 'text/html; charset=utf-8', await readFile(htmlPath, 'utf8'));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/login') {
      const payload = JSON.parse(await readBody(request)) as {
        readonly identifier?: string;
        readonly password?: string;
      };
      if (!payload.identifier?.trim() || !payload.password) {
        send(response, 400, 'application/json', JSON.stringify({ message: 'Enter both login fields.' }));
        return;
      }
      send(response, 200, 'application/json', JSON.stringify({ token: LOCAL_TOKEN }));
      return;
    }
    if (request.url?.startsWith('/api/') && request.headers.authorization !== `Bearer ${LOCAL_TOKEN}`) {
      send(response, 401, 'application/json', JSON.stringify({ message: 'Sign in again.' }));
      return;
    }
    if (request.method === 'GET' && request.url?.startsWith('/api/queue')) {
      const requestUrl = new URL(request.url, `http://${request.headers.host ?? '127.0.0.1'}`);
      const view = requestUrl.searchParams.get('view') === 'history' ? 'history' : 'review';
      const requestedPage = Number(requestUrl.searchParams.get('page') ?? '0');
      const page = Number.isSafeInteger(requestedPage) && requestedPage >= 0 ? requestedPage : 0;
      const tabs = await readLocalTabs();
      const result = loadQueuePage(
        { names: [...tabs.keys()], read: tabName => tabs.get(tabName) ?? [] },
        queueIndex,
        view,
        page,
        Date.now()
      );
      queueIndex = result.index;
      send(response, 200, 'application/json', JSON.stringify(result.page));
      return;
    }
    if (request.method === 'GET' && request.url === '/api/directory') {
      send(response, 200, 'application/json', JSON.stringify({ players: directory }));
      return;
    }
    if (request.method === 'GET' && request.url === '/api/sanctioned-matches') {
      const matches = [
        { id: '501', description: '2026 Boston Open' },
        { id: '502', description: '2026 US Amateur Doubles' }
      ];
      send(response, 200, 'application/json', JSON.stringify({ matches }));
      return;
    }
    if (request.method === 'GET' && request.url === '/api/boston-directory') {
      send(response, 200, 'application/json', JSON.stringify({ players: directory.filter(player => player.isBoston) }));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/submissions/demo') {
      const payload = JSON.parse(await readBody(request)) as {
        readonly submissionId?: string;
        readonly tabName?: string;
        readonly players?: { readonly id?: string }[];
        readonly score?: string;
      };
      if (!payload.submissionId || !payload.tabName || !payload.players?.length || !payload.score) {
        throw new Error('The demo submission is incomplete.');
      }
      const now = new Date();
      await demoSubmitLocalRecord(
        payload.submissionId,
        payload.players.map(player => String(player.id ?? '')),
        normalizeScore(payload.score),
        now.toISOString(),
        `demo-${now.getTime()}`
      );
      if (queueIndex) {
        queueIndex = withHistoryTab(queueIndex, payload.tabName);
      }
      send(response, 200, 'application/json', JSON.stringify({ submitted: true }));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/entries') {
      const payload = JSON.parse(await readBody(request)) as Record<string, unknown>;
      const now = new Date();
      const today = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const record = newQueueRecord(validateMatchFields(payload), {
        submissionId: randomUUID(),
        requestId: requiredText(payload.requestId, 'Request ID', 64),
        timestamp: now.toISOString(),
        matchDate: validateMatchDate(payload.matchDate, today),
        sanctioned: payload.sanctioned === true
      });
      const stored = await appendLocalRecord(isoWeekTabName(today), record);
      send(response, 200, 'application/json', JSON.stringify({ submissionId: stored.submissionId }));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/submissions/delete') {
      const payload = JSON.parse(await readBody(request)) as { readonly submissionId?: string };
      if (!payload.submissionId) {
        throw new Error('The deletion request is incomplete.');
      }
      await deleteLocalRecord(payload.submissionId);
      send(response, 200, 'application/json', JSON.stringify({ deleted: true }));
      return;
    }
    send(response, 404, 'text/plain; charset=utf-8', 'Not found');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Request failed.';
    send(response, 500, 'application/json', JSON.stringify({ message }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Sweet Spot admin is available at http://127.0.0.1:${PORT}`);
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
