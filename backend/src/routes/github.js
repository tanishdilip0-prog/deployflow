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

export default router;