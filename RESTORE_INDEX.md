# Action required once

`index.js` on this branch was briefly corrupted during Phase 1 integration.

Restore from main (local):

```bash
git fetch origin
git checkout origin/main -- index.js
git add index.js
git commit -m "restore index.js from main"
git push
```

Then deploy with `main = entry.js` (already set in wrangler.toml on this branch).

`entry.js` wraps the original worker without modifying it.
