/**
 * Tiny PostgREST query-string parser + SQLite query builder.
 *
 * NT8's AddOns build PostgREST-style URLs (eg
 * `?status=eq.pending&order=created_at.asc&limit=1`) when talking to
 * Supabase. In local mode we rewrite them to /api/nt8/* and need to
 * translate the same syntax into SQLite WHERE clauses + ORDER BY.
 *
 * Allow-list approach: only the operators NT8 actually uses are
 * recognized. Anything else returns an error response so we don't
 * silently mishandle a query.
 */

export type PostgRESTOp =
  | "eq"
  | "neq"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "in"
  | "ilike"
  | "is"
  | "not.is";

export interface ParsedFilter {
  column: string;
  op: PostgRESTOp;
  value: string;
}

export interface ParsedQuery {
  filters: ParsedFilter[];
  order?: { column: string; ascending: boolean };
  limit?: number;
  /** PostgREST `select=col1,col2`. We don't enforce projection — repos
   *  always return full rows — but we keep it for completeness. */
  select?: string[];
}

const ALLOWED_OPS: Set<string> = new Set([
  "eq",
  "neq",
  "lt",
  "lte",
  "gt",
  "gte",
  "in",
  "ilike",
  "is",
  "not.is",
]);

const RESERVED_KEYS = new Set(["select", "order", "limit", "offset"]);

/** Parse `?status=eq.pending&order=created_at.asc&limit=1` into a struct.
 *  Throws Error on unknown operators (caller should respond 400). */
export function parsePostgRESTQuery(searchParams: URLSearchParams): ParsedQuery {
  const filters: ParsedFilter[] = [];
  let order: ParsedQuery["order"];
  let limit: number | undefined;
  let select: string[] | undefined;

  for (const [key, raw] of searchParams.entries()) {
    if (key === "select") {
      select = raw.split(",").map((s) => s.trim()).filter(Boolean);
      continue;
    }
    if (key === "order") {
      // "col.asc" or "col.desc"
      const [col, dir] = raw.split(".");
      order = { column: col, ascending: (dir ?? "asc") === "asc" };
      continue;
    }
    if (key === "limit") {
      const n = Number(raw);
      if (Number.isFinite(n)) limit = n;
      continue;
    }
    if (RESERVED_KEYS.has(key)) continue;

    // Filter: value is "<op>.<value>" or "not.<op>.<value>"
    let op = "";
    let value = "";
    if (raw.startsWith("not.is.")) {
      op = "not.is";
      value = raw.slice("not.is.".length);
    } else {
      const dot = raw.indexOf(".");
      if (dot < 0) throw new Error(`Malformed filter: ${key}=${raw}`);
      op = raw.slice(0, dot);
      value = raw.slice(dot + 1);
    }
    if (!ALLOWED_OPS.has(op)) {
      throw new Error(`Unsupported operator: ${op}`);
    }
    filters.push({ column: key, op: op as PostgRESTOp, value });
  }

  return { filters, order, limit, select };
}

/** Compile a parsed query into a WHERE clause + bound params. The base
 *  table is provided by the caller — we only build what comes after it. */
export function compileWhere(filters: ParsedFilter[]): {
  sql: string;
  params: unknown[];
} {
  if (filters.length === 0) return { sql: "", params: [] };
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const f of filters) {
    switch (f.op) {
      case "eq":
        parts.push(`${quoteIdent(f.column)} = ?`);
        params.push(coerce(f.value));
        break;
      case "neq":
        parts.push(`${quoteIdent(f.column)} != ?`);
        params.push(coerce(f.value));
        break;
      case "lt":
        parts.push(`${quoteIdent(f.column)} < ?`);
        params.push(coerce(f.value));
        break;
      case "lte":
        parts.push(`${quoteIdent(f.column)} <= ?`);
        params.push(coerce(f.value));
        break;
      case "gt":
        parts.push(`${quoteIdent(f.column)} > ?`);
        params.push(coerce(f.value));
        break;
      case "gte":
        parts.push(`${quoteIdent(f.column)} >= ?`);
        params.push(coerce(f.value));
        break;
      case "in": {
        // PostgREST format: in.(a,b,c)
        let inner = f.value;
        if (inner.startsWith("(") && inner.endsWith(")")) {
          inner = inner.slice(1, -1);
        }
        const items = inner.split(",").map((s) => s.trim()).filter(Boolean);
        if (items.length === 0) {
          // SQL doesn't allow empty IN (), so produce a contradiction.
          parts.push("0 = 1");
        } else {
          parts.push(
            `${quoteIdent(f.column)} IN (${items.map(() => "?").join(", ")})`
          );
          params.push(...items.map(coerce));
        }
        break;
      }
      case "ilike":
        // SQLite has no native ILIKE; LIKE is case-insensitive by default
        // for ASCII (PRAGMA case_sensitive_like is off).
        parts.push(`${quoteIdent(f.column)} LIKE ?`);
        params.push(f.value.replaceAll("*", "%"));
        break;
      case "is":
        // is.null, is.true, is.false
        if (f.value === "null") parts.push(`${quoteIdent(f.column)} IS NULL`);
        else if (f.value === "true") parts.push(`${quoteIdent(f.column)} = 1`);
        else if (f.value === "false") parts.push(`${quoteIdent(f.column)} = 0`);
        else throw new Error(`Unsupported is value: ${f.value}`);
        break;
      case "not.is":
        if (f.value === "null") parts.push(`${quoteIdent(f.column)} IS NOT NULL`);
        else if (f.value === "true") parts.push(`${quoteIdent(f.column)} != 1`);
        else if (f.value === "false") parts.push(`${quoteIdent(f.column)} != 0`);
        else throw new Error(`Unsupported not.is value: ${f.value}`);
        break;
    }
  }
  return { sql: ` WHERE ${parts.join(" AND ")}`, params };
}

/** Build the ORDER BY + LIMIT suffix. */
export function compileOrderLimit(q: ParsedQuery): string {
  const parts: string[] = [];
  if (q.order) {
    parts.push(
      ` ORDER BY ${quoteIdent(q.order.column)} ${q.order.ascending ? "ASC" : "DESC"}`
    );
  }
  if (q.limit !== undefined) {
    parts.push(` LIMIT ${Number(q.limit)}`);
  }
  return parts.join("");
}

/** Defensive identifier quoting. Allow only [A-Za-z0-9_]. */
function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid column name: ${name}`);
  }
  return `"${name}"`;
}

/** Coerce a string value into a number when it looks numeric, otherwise
 *  pass through. Helps filter integer/numeric columns without ?cast hints. */
function coerce(value: string): string | number | null {
  if (value === "null") return null;
  if (value === "") return value;
  // Integer / float detection — keeps booleans as strings (callers handle).
  if (/^-?\d+$/.test(value)) return parseInt(value, 10);
  if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value);
  return value;
}
