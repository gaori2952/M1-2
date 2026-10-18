# Bundled browser dependencies

- MathJax 3.2.2: npm mathjax/es5/tex-svg.js, Apache-2.0 (MathJax-LICENSE).
- fflate 0.8.2: npm fflate/esm/browser.js, MIT (fflate-LICENSE).

Pinned files are checked in because Vercel builds the frontend/ root independently of the parent package. Both assets are served by the same origin; no runtime CDN fetch is required. Root pnpm-lock.yaml records the source package versions. MathJax uses base/ams only with no automatic extension loading; generated math SVG is further restricted to geometry and safe attributes.

References: https://docs.mathjax.org/en/v3.2/web/typeset.html and https://github.com/101arrowz/fflate
