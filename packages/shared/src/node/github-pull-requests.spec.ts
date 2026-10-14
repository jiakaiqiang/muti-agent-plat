import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHubPullRequests } from './github-pull-requests.js';

const sha = 'a'.repeat(40);
const repository = 'https://github.com/example/project';
const pull = (state: 'open' | 'closed', mergedAt: string | null = null) => ({
  number: 12, html_url: 'https://github.com/example/project/pull/12', state,
  merged_at: mergedAt, head: { sha }, base: { ref: 'main' }, mergeable: true
});

test('finds, reopens and reuses the same PR without a duplicate create', async () => {
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  const api = new GitHubPullRequests(async (url, init) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url: String(url), body: init?.body?.toString() });
    if (String(url).includes('/pulls?')) return Response.json([pull('closed')]);
    return Response.json(pull('open'));
  });
  const result = await api.createOrReopen('token', repository, 'agent-cluster/session/1',
    'main', 'Assisted delivery');
  assert.equal(result.number, 12);
  assert.equal(calls.some((call) => call.method === 'PATCH'), true);
  assert.equal(calls.some((call) => call.method === 'POST'), false);
  assert.equal(calls.every((call) => !call.url.includes('token')), true);
});

test('CI uses both checks and commit statuses; merge pins the reviewed SHA', async () => {
  let mergeBody: Record<string, unknown> | undefined;
  const api = new GitHubPullRequests(async (url, init) => {
    if (String(url).includes('/check-runs')) return Response.json({
      check_runs: [{ status: 'completed', conclusion: 'success' }]
    });
    if (String(url).endsWith('/status')) return Response.json({ state: 'pending', statuses: [] });
    mergeBody = JSON.parse(String(init?.body));
    return Response.json({ merged: true, sha: 'b'.repeat(40) });
  });
  assert.equal(await api.ciStatus('token', repository, sha), 'passed');
  assert.equal(await api.squashMerge('token', repository, 12, sha), 'b'.repeat(40));
  assert.deepEqual(mergeBody, { merge_method: 'squash', sha });
});

test('an empty CI set is distinct from pending and failed checks', async () => {
  for (const [conclusion, expected] of [
    [undefined, 'not_configured'], ['pending', 'pending'], ['failure', 'failed']
  ] as const) {
    const api = new GitHubPullRequests(async (url) => Response.json(
      String(url).includes('/check-runs')
        ? { check_runs: conclusion ? [{ status: conclusion === 'pending' ? 'queued' : 'completed',
            conclusion }] : [] }
        : { state: 'pending', statuses: [] }
    ));
    assert.equal(await api.ciStatus('token', repository, sha), expected);
  }
});

test('CI uses the latest combined status instead of an older failure in the same context', async () => {
  for (const [state, expected] of [
    ['success', 'passed'], ['pending', 'pending'], ['failure', 'failed']
  ] as const) {
    const api = new GitHubPullRequests(async (url) => Response.json(
      String(url).includes('/check-runs')
        ? { total_count: 0, check_runs: [] }
        : { state, statuses: [
            { context: 'ci/build', state: 'success' },
            { context: 'ci/build', state: 'failure' }
          ] }
    ));
    assert.equal(await api.ciStatus('token', repository, sha), expected);
  }
});

test('CI fails closed when the combined status response is incomplete', async () => {
  const api = new GitHubPullRequests(async (url) => Response.json(
    String(url).includes('/check-runs')
      ? { total_count: 0, check_runs: [] }
      : { statuses: [{ context: 'ci/build', state: 'success' }] }
  ));
  await assert.rejects(api.ciStatus('token', repository, sha), /GITHUB_CI_RESPONSE_INVALID/);
});

test('CI remains pending when the first check-run page is incomplete', async () => {
  const api = new GitHubPullRequests(async (url) => Response.json(
    String(url).includes('/check-runs')
      ? { total_count: 101, check_runs: [{ status: 'completed', conclusion: 'success' }] }
      : { state: 'success', statuses: [{ context: 'ci/build', state: 'success' }] }
  ));
  assert.equal(await api.ciStatus('token', repository, sha), 'pending');
});

test('PR diff rejects files fetched while the reviewed head changes', async () => {
  let headReads = 0;
  const api = new GitHubPullRequests(async (url) => {
    if (String(url).includes('/pulls/12/files?')) {
      return Response.json([{ filename: 'src/index.ts', status: 'modified', additions: 1, deletions: 0 }]);
    }
    headReads += 1;
    return Response.json(headReads === 1 ? pull('open') : {
      ...pull('open'), head: { sha: 'b'.repeat(40) }
    });
  });

  await assert.rejects(api.diff('token', repository, {
    kind: 'pull_request', number: 12, sha, page: 1
  }), /GITHUB_PULL_HEAD_CHANGED/);
  assert.equal(headReads, 2);
});

test('PR diff never marks a full final page as a complete review', async () => {
  const api = new GitHubPullRequests(async (url) => Response.json(
    String(url).includes('/pulls/12/files?')
      ? Array.from({ length: 100 }, (_, index) => ({
          filename: `file-${index}.txt`, status: 'modified', additions: 1, deletions: 0
        }))
      : pull('open')
  ));

  await assert.rejects(api.diff('token', repository, {
    kind: 'pull_request', number: 12, sha, page: 30
  }), /GITHUB_DIFF_FILE_LIMIT_EXCEEDED/);
});
