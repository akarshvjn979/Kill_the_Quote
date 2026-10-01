# RFQ Desk: Kill the Quote Spreadsheet

AI co-pilot for a procurement buyer: draft an RFQ, send it, read vendor replies in any format,
compare them in one view, ask questions in plain language, and award line by line.

## What's in this repo
| File | Purpose |
|---|---|
| `index.html` | The whole app (UI, file parsing, in-page OCR, SQLite, charts). |
| `api/claude.js` | Vercel Edge Function. Holds your Anthropic API key and forwards AI calls. |
| `vercel.json` | Small Vercel config (keeps the site out of search engines). |

## Deploy on Vercel
1. **Anthropic API key**: console.anthropic.com → API Keys → Create key. Add credit under Billing.
2. **GitHub**: create a repo (private is fine) → "uploading an existing file" → drag in `index.html`, the `api` folder, `vercel.json`, `README.md` → Commit.
3. **Vercel**: vercel.com → Add New → Project → import the repo → Framework preset **Other** → leave build settings empty.
4. **Environment variables** (Project → Settings → Environment Variables):
   - `ANTHROPIC_API_KEY` = your key
   - `APP_PASSCODE` = any passcode you choose (people need it to use the AI)
   - optional: `MODEL_DEFAULT` (default `claude-sonnet-5-5`), `MODEL_QUICK` (default `claude-haiku-4-5-20251001`)
5. **Deploy**. If you added variables after the first deploy: Deployments → ⋯ → Redeploy.
6. Open the URL, enter the passcode once (stored in that browser), and test.

## Notes
- The same `index.html` also works inside Claude: there it uses Claude's runtime instead of `/api/claude`.
- Data is saved in each visitor's browser (local storage). Use **Reset** in the header to start fresh.
- Every AI action uses your API credits. Change `APP_PASSCODE` anytime to cut off access.
- Opening `index.html` directly from disk will not run the AI; it needs the `/api/claude` function.
