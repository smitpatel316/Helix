# Third-party software

Titer is free software under the GNU General Public License, version 3 or later
(see [LICENSE](LICENSE)). It is built on the open-source work below. Each keeps its own
license; the full texts come with each package's source.

## Shipped inside the app

| Software | Version | License | Used for |
| --- | --- | --- | --- |
| [R](https://www.r-project.org) | 4.6.0 | GPL-2 or GPL-3 | Every statistical test |
| [webR](https://github.com/r-wasm/webr) | 0.6.0 | Binaries: GPL-3; JavaScript: MIT | Runs R inside the app (R compiled to WebAssembly) |
| jszip | 3.10.1 | MIT OR GPL-3.0-or-later |
| [survival](https://github.com/therneau/survival) (R package) | 3.8-12 | LGPL-2 or later | Survival analysis and Cox regression |
| [Matrix](https://cran.r-project.org/package=Matrix) (R package, needed by survival) | 1.7-6 | GPL-2 or later | — |
| [lattice](https://cran.r-project.org/package=lattice) (R package, needed by Matrix) | 0.23-1 | GPL-2 or later | — |

## Vendored R packages (webR repo)

The app ships the following 45 R packages inside `dist/webr-repo` (webR 0.6.0, R 4.6.0; manifest built 2026-11-10, 59,808,134 bytes total). Source: `dist/webr-repo/MANIFEST.json`; license strings copied verbatim from the manifest. License counts: 24 GPL family, 16 MIT, 3 LGPL, 1 Apache-2.0, 1 Unlimited.

| Package | Version | License |
| --- | --- | --- |
| MASS | 7.3-66 | GPL-2 | GPL-3 |
| Matrix | 1.7-6 | GPL (>= 2) | file LICENCE |
| MethComp | 1.30.2 | GPL (>= 2) |
| R6 | 2.6.1 | MIT + file LICENSE |
| RColorBrewer | 1.1-3 | Apache License 2.0 |
| Rcpp | 1.1.2 | GPL (>= 2) |
| RcppEigen | 0.3.4.0.2 | GPL (>= 2) | file LICENSE |
| Rdpack | 2.6.6 | GPL (>= 2) |
| S7 | 0.2.2 | MIT + file LICENSE |
| TH.data | 1.1-5 | GPL-3 |
| boot | 1.3-32 | Unlimited |
| cli | 3.6.6 | MIT + file LICENSE |
| coda | 0.19-4.1 | GPL (>= 2) |
| codetools | 0.2-20 | GPL |
| cpp11 | 0.5.5 | MIT + file LICENSE |
| deming | 1.4-1 | LGPL (>= 2) |
| farver | 2.1.2 | MIT + file LICENSE |
| ggplot2 | 4.0.3 | MIT + file LICENSE |
| glue | 1.8.1 | MIT + file LICENSE |
| gtable | 0.3.6 | MIT + file LICENSE |
| isoband | 0.3.0 | MIT + file LICENSE |
| labeling | 0.4.3 | MIT + file LICENSE | Unlimited |
| lattice | 0.23-1 | GPL (>= 2) |
| lifecycle | 1.0.5 | MIT + file LICENSE |
| lme4 | 2.0-6 | GPL (>= 2) |
| lmerTest | 3.2-1 | GPL (>= 2) |
| minqa | 1.2.8 | GPL-2 |
| multcomp | 1.4-32 | GPL-2 |
| mvtnorm | 1.2-4 | GPL-2 |
| nlme | 3.1-171 | GPL (>= 2) |
| nloptr | 2.2.1.9000 | LGPL (>= 3) |
| nortest | 1.0-4 | GPL (>= 2) |
| numDeriv | 2016.8-1.1 | GPL-2 |
| outliers | 0.15 | GPL (>= 2) |
| pROC | 1.19.1 | GPL (>= 3) |
| rbibutils | 2.4.1 | GPL-2 |
| reformulas | 0.4.4 | GPL-3 |
| rlang | 1.3.0 | MIT + file LICENSE |
| sandwich | 3.1-3 | GPL-2 | GPL-3 |
| scales | 1.4.0 | MIT + file LICENSE |
| survival | 3.8-12 | LGPL (>= 2) |
| vctrs | 0.7.3 | MIT + file LICENSE |
| viridisLite | 0.4.3 | MIT + file LICENSE |
| withr | 3.0.3 | MIT + file LICENSE |
| zoo | 1.9-1 | GPL-2 | GPL-3 |
| [Plotly.js](https://github.com/plotly/plotly.js) | 4.1.2 | MIT | Drawing the graphs |
| [React](https://react.dev) and React DOM | 19.3.0 | MIT | The interface |
| [Tauri](https://tauri.app) (with its dialog, window-state and updater plugins) | 2.12 | MIT or Apache-2.0 | The native macOS app around the interface |
| [objc2](https://github.com/madsmtm/objc2) | 0.6.4 | MIT | Talking to macOS from the native side |
| [percent-encoding](https://github.com/servo/rust-url) | 2.3.2 | MIT or Apache-2.0 | Passing file paths to the native side |
| [serde](https://serde.rs) | 1.0.229 | MIT or Apache-2.0 | Passing data between the windows and the native side |
| [Phosphor Icons](https://phosphoricons.com) | 2.1.10 | MIT | Icons |
| [Tailwind CSS](https://tailwindcss.com) | 4.3.3 | MIT | Styles (compiled into the app's stylesheet) |

### Build-time only (not shipped in the app)

- lightningcss — MPL-2.0 (CSS tool used by Tailwind at build time)
- caniuse-lite — CC-BY-4.0 (browserslist data)

The webR binaries bundle further open-source software, each under its own license
(listed in webR's `LICENSE.md`): PCRE2 (BSD), XZ Utils (public domain), libgfortran
(GPL), LLVM Flang (Apache-2.0).

The Rust and JavaScript libraries these depend on are listed with their versions in
`src-tauri/Cargo.lock` and `package-lock.json`; all are under open-source licenses.

## Color palettes

A graph's palettes (`src/lib/palettes.ts`) are the authors' colors, in their order:

| Palettes | Authors | Source | License |
| --- | --- | --- | --- |
| Okabe-Ito | Masataka Okabe and Kei Ito | [Color Universal Design](https://jfly.uni-koeln.de/color/) (2008) | Free to use |
| Tol Bright, Tol Muted | Paul Tol, SRON | [Colour schemes](https://personal.sron.nl/~pault/) (2021) | BSD 3-Clause, © 2022 Paul Tol |
| Tableau 10 | Tableau Software | [d3-scale-chromatic](https://github.com/d3/d3-scale-chromatic) | ISC, © 2010-2024 Mike Bostock |
| Viridis, Magma, Cividis | Stéfan van der Walt and Nathaniel Smith; Jamie Nuñez et al. (Cividis) | [Matplotlib](https://matplotlib.org) | CC0 (Viridis, Magma); Matplotlib license (Cividis) |
| Batlow, Vik | Fabio Crameri | [Scientific colour maps 8.0.1](https://doi.org/10.5281/zenodo.1243862) | MIT, © Fabio Crameri |
| Coolwarm, Fast | Kenneth Moreland | [Color advice](https://www.kennethmoreland.com/color-advice/) | CC0 |
| vlag | Michael Waskom | [Seaborn](https://seaborn.pydata.org) | BSD 3-Clause, © 2012-2023 Michael L. Waskom |
| RdBu | Cynthia Brewer, Mark Harrower, The Pennsylvania State University | [ColorBrewer](https://colorbrewer2.org) | Apache 2.0, © 2002 |

## Test data

The `.pzfx` files in `tests/testdata/` (used only by the test suite, not shipped in
the app) come from [pypzfx](https://github.com/yuejiang-nj/pypzfx) (MIT, © 2024
Yue Jiang). The Prism importer itself (`src/lib/pzfx.ts`) was written from the
`.pzfx` format as documented by pypzfx; it shares no code with it.

## Source code

Helix's source code is the mickaphd/Helix repository on GitHub. The source code of R is at
<https://cran.r-project.org/sources.html>, and that of webR (including how its binaries are
built) at <https://github.com/r-wasm/webr>.
