# Vendored: omp stats dashboard client

Source: `can1357/oh-my-pi` (omp), MIT License - Copyright (c) 2025 Mario Zechner,
2025-2026 Can Boeluek, 2026 Stencil Labs, Inc.

These four files are omp's built stats dashboard UI, extracted from the
`packages/stats/src/embedded-client.ts` blob inside the released binary: that blob
is base64 -> gzip -> tar, and `index.html` / `index.js` / `styles.css` / `index.css`
are its members.

Why vendored rather than rebuilt: the UI is the deliverable, and reimplementing it
would be a second dashboard to keep in sync. The gateway serves these files at
`/stats/` and implements the API they call (`stats-api.mjs`), so the same client
renders our proxy's data.

Extraction (rerun after an omp upgrade to refresh the UI):

    node -e 'const fs=require("fs"),z=require("zlib");
      const b=fs.readFileSync("<work>/mod101-embedded-client.generated.txt","utf8").trim();
      fs.writeFileSync("out.tar",z.gunzipSync(Buffer.from(b,"base64")))'
    tar -xf out.tar -C vendor/omp-stats

`stats-api.mjs` maps our JSONL usage rows onto this client's API contract; the
contract is what the client reads, not what the bundle happens to contain, so
verify any refresh against a live dashboard rather than by reading index.js.
