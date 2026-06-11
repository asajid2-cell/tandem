# Media Manifest

Every kept visual: what it proves, its source, privacy status, and where it's referenced.
All captures are from real tandem sessions on this machine; local paths/usernames/emails are
sanitized at the DOM level during capture (the rendered image is clean — the underlying work is not altered).

| asset | proves | source (real session) | privacy | README ref |
|---|---|---|---|---|
| `hero.png` | the split-view watcher (Claude driver · Codex partner · live timeline) | VENPOD renderer-perf tandem (claude `8ebdf4fc` · codex `019eb49b`) | paths → `~/project`; no username/email/secrets | ## See it work (hero) |
| `why-second-brain.png` | the full tandem payoff (merit shot): a reproducible divergence resolved by ground-truth — two source analyses missed the real cost, only measurement caught it; "Codex is now a genuine co-engineer" | VENPOD session, Claude column (`8ebdf4fc`) | sanitized (paths + Claude temp dir → generic); leak-checked clean; quote verbatim | ## See it work |
| `real-result.png` | the measurable outcome: before/after fps table (median 40→50→90, cell-cross hitch 74ms→13ms), coverage-safe verification, "the tandem made the difference" | same VENPOD session, Claude column | sanitized; leak-checked clean; metrics verbatim | ## See it work |

Only the three referenced PNGs are kept in the repo. Unlinked captures (two `.mp4` session
recordings and a context-free RE screenshot) were removed — binaries that nothing references don't
belong in git history. If a video is ever wanted publicly, attach it to a GitHub Release, not the repo.

The driver's verdict on the partner ("co-engineer, not a rubber stamp") is featured as a quote, not a
screenshot — the words carry the context a raw capture can't.

Captured with the `public-repo-prep` capture harness (`scripts/capture/capture-web.mjs` + a
DOM-sanitizing Playwright flow, pair pinned via the watcher's `?claude=&codex=` deeplink).
