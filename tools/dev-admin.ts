import { readFile } from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { appsScriptComponents } from './components.ts';
import { demoSubmitLocalRecord, readLocalTabs } from './local-queue.ts';

const PORT = 4174;
const MAX_REQUEST_BYTES = 20_000;
const htmlPath = path.join(appsScriptComponents.admin.distDirectory, 'Index.html');
const directory = [
  { id: '10001', name: 'Charlie Brown', handicap: 42.1 },
  { id: '10002', name: 'Lucy van Pelt', handicap: 48.4 },
  { id: '10003', name: 'Snoopy', handicap: 31.7 },
  { id: '10004', name: 'Woodstock', handicap: 54.2 },
  { id: '10005', name: 'Schroeder', handicap: 39.8 },
  { id: '10006', name: 'Franklin Armstrong', handicap: 44.5 },
  { id: '10007', name: 'Peppermint Patty', handicap: 36.3 },
  { id: '10008', name: 'Marcie', handicap: 46.9 },
  { id: '10009', name: 'Linus van Pelt', handicap: 43.6 },
  { id: '10010', name: 'Sally Brown', handicap: 51.2 },
  { id: '10011', name: 'Pig-Pen', handicap: 49.7 },
  { id: '10012', name: 'Violet Gray', handicap: 45.1 }
];

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/') {
      send(response, 200, 'text/html; charset=utf-8', await readFile(htmlPath, 'utf8'));
      return;
    }
    if (request.method === 'GET' && request.url === '/api/queue') {
      const tabs = await readLocalTabs();
      const items = Array.from(tabs.entries())
        .flatMap(([tabName, records]) => records.map(record => ({ tabName, record })))
        .sort((left, right) => right.record.submittedAt.localeCompare(left.record.submittedAt));
      send(response, 200, 'application/json', JSON.stringify({ items }));
      return;
    }
    if (request.method === 'GET' && request.url === '/api/directory') {
      send(response, 200, 'application/json', JSON.stringify({ players: directory }));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/submissions/demo') {
      const payload = JSON.parse(await readBody(request)) as {
        readonly submissionId?: string;
        readonly playerIds?: string[];
      };
      if (!payload.submissionId || !payload.playerIds?.length) {
        throw new Error('The demo submission is incomplete.');
      }
      const now = new Date();
      await demoSubmitLocalRecord(payload.submissionId, payload.playerIds, now.toISOString(), `demo-${now.getTime()}`);
      send(response, 200, 'application/json', JSON.stringify({ submitted: true }));
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
