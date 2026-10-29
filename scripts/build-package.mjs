import { cpSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const out = resolve(process.argv[2] ?? "/tmp/pi-subagents-package");
mkdirSync(out);
cpSync("packages/pi", out, { recursive: true });
execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "--ignoreConfig", "--target", "ES2023", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--strict", "--skipLibCheck", "--rewriteRelativeImportExtensions", "--outDir", `${out}/dist`, ...["main", "manager", "mcp", "faux", "pi-runtime"].map((name) => `src/${name}.ts`)], { stdio: "inherit" });
for (const file of ["panel.html", "codex-avatars.js", "codex-icons.js", "fonts"]) cpSync(`src/${file}`, `${out}/dist/${file}`, { recursive: true });
mkdirSync(`${out}/docs`, { recursive: true });
cpSync("docs/panel-deepseek.png", `${out}/docs/panel-deepseek.png`);
cpSync("codex-plugin", `${out}/codex-plugin`, { recursive: true });
cpSync("LICENSE", `${out}/LICENSE`);
