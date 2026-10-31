import { createHash } from "node:crypto";
import type { Store } from "./store.js";

export class SearchInputError extends Error {}

type Cursor = { version: 1; offset: number; limit: number; scope: string };

export function searchPage(store: Pick<Store, "searchRuns">, query: string, o: { project?: string; limit?: number; cursor?: string }) {
  query = query.trim();
  if (!query || query.length > 500) throw new SearchInputError("search needs a query of 1-500 characters");
  const scope = createHash("sha256").update(JSON.stringify([query.toLowerCase(), o.project ?? null])).digest("hex");
  let offset = 0;
  let limit = o.limit ?? 20;
  if (o.cursor !== undefined) {
    let cursor: Cursor;
    try {
      if (!o.cursor || o.cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(o.cursor)) throw new SearchInputError();
      cursor = JSON.parse(Buffer.from(o.cursor, "base64url").toString("utf8")) as Cursor;
      if (!cursor || cursor.version !== 1 || cursor.scope !== scope || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0
        || !Number.isInteger(cursor.limit) || cursor.limit < 1 || cursor.limit > 50) throw new SearchInputError();
    } catch { throw new SearchInputError("invalid search cursor or cursor belongs to another query/project"); }
    if (o.limit !== undefined && o.limit !== cursor.limit) throw new SearchInputError("keep the same search limit when continuing a cursor");
    offset = cursor.offset;
    limit = cursor.limit;
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new SearchInputError("search limit must be 1-50");
  const found = store.searchRuns(query, { limit: limit + 1, pageSize: limit, offset, ...(o.project ? { project: o.project } : {}) });
  const matches = found.slice(0, limit);
  const nextCursor = found.length > limit ? Buffer.from(JSON.stringify({ version: 1, offset: offset + limit, limit, scope } satisfies Cursor)).toString("base64url") : null;
  return { untrusted: true, matches, nextCursor, limit };
}
