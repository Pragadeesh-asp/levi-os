# Third-party code

## sakuga-vfx (vendored)

LEVI OS's look and its anime-style reactions come from [sakuga-vfx](https://github.com/finktheartist/sakuga-vfx) by Justin Finkelman, MIT licensed. The license travels with the files in `public/sakuga-vfx/LICENSE`.

Two files are vendored **unchanged** from commit `c3dabb173928a3ad2372183103caf2e6f50953d0`:

| File | Upstream path | SHA-256 |
| --- | --- | --- |
| `public/sakuga-vfx/button.js` | `button/button.js` | `2d6f452b4d9c9489a4da9b6a1f0fb2ef52d88b5a28331eb3b1c5076742e0ddb8` |
| `public/sakuga-vfx/toast.js` | `toast/toast.js` | `8b47d9e6bca4fad1bfae2aeefd4df45fdb81999dec1a02bbd941eb65ed93394c` |

**Reviewed before vendoring:** no network calls (`fetch`, XHR, WebSocket, beacons), no `eval` or `new Function`, no cookie or storage access, no external URLs. Each file's single `innerHTML` writes only the component's own static template, and `toast.show(text)` sets `textContent`, so achievement names from the database cannot inject HTML.

**How LEVI OS uses them:** `src/components/Sakuga.tsx` loads both scripts in the signed-in shell and renders `<sakuga-button>` for **Complete** (missions) and **Log today** (habits) through `ActionForm`'s `effect="impact"`. The reward is played by `reward()` in `src/lib/reward.ts`, from inside the action and only when the server reports success: it calls `done()` on the pressed button, holds a 450 ms beat so the check lands before the card changes (a completed mission swaps Complete for Reopen in the same commit, so an effect would never fire), and shows unlocked achievements in one `<sakuga-toast>`. While saving, the button is disabled but marked `data-saving`, so the impact is not dimmed. Until a script loads, an ordinary button renders. `prefers-reduced-motion` turns the effects and the beat off. The palette and type stack in `src/app/globals.css` follow the same design and feed the components through `--sk-*` variables.

**Updating:** download the files from a newer upstream commit, review the diff against this list, replace them byte-for-byte, and update the commit and hashes above. Don't edit the vendored files; ESLint ignores `public/sakuga-vfx/` for that reason.
