import { Router } from 'express';
import { fail } from '../util.js';

const router = Router();

router.get('/repos', async (req, res) => {
  const gh = req.get('x-github-token');
  if (!gh || gh.length > 500) return fail(res, 400, 'GitHub token required');
  try {
    const r = await fetch(
      'https://api.github.com/user/repos?per_page=50&sort=updated&affiliation=owner',
      { headers: { Authorization: 'Bearer ' + gh, Accept: 'application/vnd.github+json', 'User-Agent': 'deployflow' } }
    );
    if (r.status === 401) return fail(res, 401, 'GitHub access expired, sign in with GitHub again');
    if (!r.ok) return fail(res, 502, 'GitHub request failed');
    const list = await r.json();
    res.json({
      ok: true,
      data: list.map((x) => ({ full_name: x.full_name, default_branch: x.default_branch, private: x.private })),
    });
  } catch (e) {
    console.error('github repos:', e.message);
    fail(res, 502, 'Could not reach GitHub');
  }
});

router.get('/repos/:owner/:repo/branches', async (req, res) => {
  const gh = req.get('x-github-token');
  const { owner, repo } = req.params;
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo)) {
    return fail(res, 400, 'Invalid owner or repo');
  }
  try {
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'deployflow' };
    if (gh && gh.length <= 500) headers.Authorization = 'Bearer ' + gh;
    const r = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=50`,
      { headers }
    );
    if (r.status === 401) return fail(res, 401, 'GitHub access expired, sign in with GitHub again');
    if (!r.ok) return fail(res, r.status, 'GitHub request failed');
    const list = await r.json();
    res.json({
      ok: true,
      data: list.map((b) => ({ name: b.name, commit_sha: b.commit?.sha })),
    });
  } catch (e) {
    console.error('github branches:', e.message);
    fail(res, 502, 'Could not reach GitHub');
  }
});

export default router;
