# website — billion-context site

Static landing page + docs. No build step, no dependencies — plain HTML/CSS/JS.
Deployed to [GitHub Pages](https://ranxianglei.github.io/billion-context/) by
`.github/workflows/pages.yml` — manual `workflow_dispatch` only for now: the repo
has no GitHub Pages site yet, so auto-deploy on push is suspended (#4598).

## Local preview

```bash
cd website
python3 -m http.server 8090
# → http://127.0.0.1:8090/
```

All asset references are **relative** so the pages work under any mount path
(`https://<user>.github.io/<repo>/`, subfolder, nginx root, custom domain).

## Files

| file            | purpose                                                          |
| --------------- | ---------------------------------------------------------------- |
| `index.html`    | landing page; EN strings are the default                         |
| `styles.css`    | design system, light/dark via `prefers-color-scheme`             |
| `main.js`       | EN/中文 toggle (persisted in localStorage), copy buttons, scroll reveal |
| `docs/index.html` | bilingual /docs/ page                                           |

## TODO before launch

- [ ] Add `og.png` (1200×630 social card); already referenced from both pages.
- [ ] Custom domain: once confirmed, add a `CNAME` file here (e.g. `billion-context.com`),
      enable HTTPS in GitHub Pages settings, and update the `canonical`/`og:url`
      placeholders in `index.html` + `docs/index.html`. Relative links keep working — nothing else changes.
