// Publish a folder to a GitHub repo branch as one commit, via the gh CLI (Git Data API). No git needed.
// node gh-publish.mjs <dir> <owner/repo> <branch> <message> <authorName> <authorEmail>
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [dir, repo, branch, message, name, email] = process.argv.slice(2);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ghpub-'));
let n = 0;
function gh(method, endpoint, body) {
  const args = ['api', '-X', method, endpoint];
  if (body !== undefined) {
    const f = path.join(tmp, `b${n++}.json`);
    fs.writeFileSync(f, JSON.stringify(body));
    args.push('--input', f);
  }
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`gh api ${method} ${endpoint} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout ? JSON.parse(r.stdout) : null;
}

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else files.push(p);
  }
})(dir);

const tree = [];
for (const f of files) {
  const rel = path.relative(dir, f).split(path.sep).join('/');
  const blob = gh('POST', `repos/${repo}/git/blobs`, { content: fs.readFileSync(f).toString('base64'), encoding: 'base64' });
  tree.push({ path: rel, mode: '100644', type: 'blob', sha: blob.sha });
  console.log(`blob ${blob.sha.slice(0, 7)} ${rel}`);
}
const t = gh('POST', `repos/${repo}/git/trees`, { tree });
const parent = gh('GET', `repos/${repo}/git/ref/heads/${branch}`).object.sha;
const who = { name, email, date: new Date().toISOString() };
const commit = gh('POST', `repos/${repo}/git/commits`, { message, tree: t.sha, parents: [parent], author: who, committer: who });
gh('PATCH', `repos/${repo}/git/refs/heads/${branch}`, { sha: commit.sha, force: false });
console.log(`commit ${commit.sha} on ${branch} (${files.length} files, parent ${parent.slice(0, 7)})`);
fs.rmSync(tmp, { recursive: true, force: true });
