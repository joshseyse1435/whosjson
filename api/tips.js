// The tip line API. Vercel turns this file into the endpoint /api/tips.
//
//   GET  /api/tips  -> { total, tips: [{ id, name, message, created_at }] }   (approved tips only)
//   POST /api/tips  <- { name?, message, website? }  -> 201 { ok: true }
//
// The database address comes from an environment variable that Vercel sets when a
// database is connected to the project: DATABASE_URL (Neon) or POSTGRES_URL (Supabase).
// Any Postgres database works.

import postgres from "postgres";
import { createHash } from "node:crypto";

const LIMITS = { name: 40, message: 500, minMessage: 3 };
const RATE = { max: 3, minutes: 10 };   // at most 3 tips per visitor per 10 minutes

let sql = null;
let ready = null;

function db() {
  if (!sql) {
    const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!url) throw new Error("No database connected: set DATABASE_URL or POSTGRES_URL");
    // max: 1 because each serverless function instance handles one request at a time.
    // prepare: false keeps it compatible with connection poolers (Supabase, Neon).
    sql = postgres(url, { max: 1, idle_timeout: 20, connect_timeout: 10, prepare: false });
  }
  // Create the table the first time this instance runs (does nothing if it already exists).
  ready ??= sql.begin(async (tx) => {
    await tx`create table if not exists tips (
      id bigint generated always as identity primary key,
      name text,
      message text not null,
      approved boolean not null default false,
      ip_hash text,
      created_at timestamptz not null default now()
    )`;
    await tx`create index if not exists tips_public_idx on tips (approved, created_at desc)`;
    await tx`create index if not exists tips_ip_idx on tips (ip_hash, created_at desc)`;
    // Lock the table against Supabase's automatic public API. With row-level security on
    // and no policies, only this server (connecting as the database owner) can read or write it.
    await tx`alter table tips enable row level security`;
  }).catch((err) => { ready = null; throw err; });
  return ready.then(() => sql);
}

// Store a one-way hash of the visitor's IP instead of the IP itself.
function hashIp(req) {
  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();
  const salt = process.env.TIP_SALT || "whosjson-tip-line";
  return createHash("sha256").update(salt + ip).digest("hex").slice(0, 32);
}

function clean(value, max) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

async function listTips(res) {
  const sql = await db();
  const [{ total }] = await sql`select count(*)::int as total from tips`;
  const tips = await sql`
    select id, name, message, created_at from tips
    where approved order by created_at desc limit 50`;
  // Let Vercel's CDN cache the list for 30 seconds so page views don't all hit the database.
  res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=60");
  return res.status(200).json({ total, tips });
}

async function addTip(req, res) {
  let body = req.body ?? {};
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

  // "website" is a hidden field people never see. Bots fill it in; pretend it worked.
  if (clean(body.website, 200)) return res.status(201).json({ ok: true });

  const name = clean(body.name, LIMITS.name) || null;
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (message.length < LIMITS.minMessage) return res.status(400).json({ error: "Write a tip before submitting." });
  if (message.length > LIMITS.message) return res.status(400).json({ error: `Keep tips under ${LIMITS.message} characters.` });

  const sql = await db();
  const ipHash = hashIp(req);
  const [{ recent }] = await sql`
    select count(*)::int as recent from tips
    where ip_hash = ${ipHash} and created_at > now() - make_interval(mins => ${RATE.minutes})`;
  if (recent >= RATE.max) {
    return res.status(429).json({ error: "That's a lot of tips at once. Try again in a few minutes." });
  }

  await sql`insert into tips (name, message, ip_hash) values (${name}, ${message}, ${ipHash})`;
  return res.status(201).json({ ok: true });
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  try {
    if (req.method === "GET") return await listTips(res);
    if (req.method === "POST") return await addTip(req, res);
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("tip line error:", err);
    return res.status(500).json({ error: "The tip line is down right now. Try again later." });
  }
}
