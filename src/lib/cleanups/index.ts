import * as worktrees from "./worktrees.js";
import * as branches from "./branches.js";
import * as orphans from "./orphans.js";
import * as transcripts from "./transcripts.js";
import * as caches from "./caches.js";
import * as browsers from "./browsers.js";
import * as stores from "./stores.js";
import * as toolchains from "./toolchains.js";
import type { Ctx, CollectResult } from "../../types.js";

// Adding a cleanup: one file exporting cats and collect(ctx), one line here.
// ctx = { repos, days, home, now, onProgress }; collect returns { items, kept? }.
export interface Cleanup {
  cats: Record<string, string>;
  collect: (ctx: Partial<Ctx>) => CollectResult;
}

export const CLEANUPS: Cleanup[] = [worktrees, branches, orphans, transcripts, caches, browsers, stores, toolchains];

// the picker and the table read their labels from here, so a new cleanup names its
// own categories and no ui file has to be touched
export const CATS: Record<string, string> = Object.assign({}, ...CLEANUPS.map((c) => c.cats));
