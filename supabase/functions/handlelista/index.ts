// Handlelista – Supabase Edge Function
//   GET  /api/state   felles liste
//   POST /api/op      endring av lista
//   GET  /api/search  produktsøk via Kassalapp
//   POST /api/prices  dagens priser per kjede for en liste EAN-er
//
// Hemmeligheter (Edge Functions → Secrets):
//   KASSAL_KEY    – API-nøkkel fra kassal.app/api (navn med «kassal» virker også)
//   APP_PASSWORD  – koden dere skriver inn i appen (navn med «passord» virker også)
// SUPABASE_URL og SUPABASE_SERVICE_ROLE_KEY settes automatisk av Supabase.

const KASSAL = Deno.env.get("KASSAL_BASE") || "https://kassal.app/api/v1";
const DB_URL = Deno.env.get("SUPABASE_URL")!;
const DB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ROW = "hjemme";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-kode",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// Finner hemmeligheten selv om den har et annet navn (f.eks. «Kassalapp api», «Passord»)
function secret(exact: string[], pattern: RegExp): string | undefined {
  for (const n of exact) { const v = Deno.env.get(n); if (v) return v.trim(); }
  const env = Deno.env.toObject();
  const hit = Object.keys(env).find((k) => pattern.test(k) && !/^SUPABASE_/i.test(k));
  return hit ? env[hit].trim() : undefined;
}
const getKassalKey = () => secret(["KASSAL_KEY"], /kassal/i);
const getPassword = () => secret(["APP_PASSWORD"], /passord|password|kode/i);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*?\/handlelista/, "") || "/";

  // Holder prosjektet våkent (kalles av GitHub Actions). Avslører ingenting.
  if (path === "/api/ping") { await load(); return json({ ok: true }); }

  const pw = getPassword();
  // Uten APP_PASSWORD er lista låst for alle
  if (!pw || req.headers.get("x-kode") !== pw) return json({ error: "feil_kode" }, 401);

  try {
    if (path === "/api/state" && req.method === "GET") return state(url);
    if (path === "/api/op" && req.method === "POST") return op(await req.json());
    if (path === "/api/search") return search(url);
    if (path === "/api/prices" && req.method === "POST") return prices(await req.json());
    return json({ error: "ukjent" }, 404);
  } catch (e) {
    return json({ error: "serverfeil", detail: String((e as Error)?.message || e) }, 500);
  }
});

// ---------- Lagring i Postgres (én rad) ----------
function dbHeaders(extra: Record<string, string> = {}) {
  const h: Record<string, string> = { apikey: DB_KEY, "Content-Type": "application/json", ...extra };
  if (DB_KEY.startsWith("eyJ")) h.Authorization = `Bearer ${DB_KEY}`;
  return h;
}
type State = { v: number; items: Item[]; often: Record<string, Often> };
type Item = { id: string; name: string; qty: string; cat: string; ean: string; pname: string; done: boolean; ts: number };
type Often = { name: string; cat: string; count: number; last: number; ean?: string; pname?: string };

async function load(): Promise<State> {
  const r = await fetch(`${DB_URL}/rest/v1/handlelista_state?id=eq.${ROW}&select=data`, { headers: dbHeaders() });
  if (!r.ok) throw new Error("db_les " + r.status + " " + (await r.text()).slice(0, 200));
  const rows = await r.json();
  if (rows.length) return rows[0].data;
  // Raden finnes ikke ennå: lag den
  const empty: State = { v: 0, items: [], often: {} };
  await fetch(`${DB_URL}/rest/v1/handlelista_state`, {
    method: "POST",
    headers: dbHeaders({ Prefer: "resolution=ignore-duplicates" }),
    body: JSON.stringify({ id: ROW, data: empty }),
  });
  return empty;
}
// Lagrer bare hvis ingen andre har lagret i mellomtiden
async function save(s: State, prevV: number): Promise<boolean> {
  const r = await fetch(
    `${DB_URL}/rest/v1/handlelista_state?id=eq.${ROW}&data->>v=eq.${prevV}`,
    { method: "PATCH", headers: dbHeaders({ Prefer: "return=representation" }), body: JSON.stringify({ data: s, updated_at: new Date().toISOString() }) },
  );
  if (!r.ok) throw new Error("db_skriv " + r.status + " " + (await r.text()).slice(0, 200));
  return (await r.json()).length > 0;
}

async function state(url: URL) {
  const s = await load();
  const since = Number(url.searchParams.get("v") ?? -1);
  return json(since === s.v ? { same: true, v: s.v } : s);
}

async function op(o: Record<string, unknown>) {
  for (let tries = 0; tries < 4; tries++) {
    const s = await load();
    const prev = s.v;
    if (apply(s, o) === false) return json({ error: "ugyldig" }, 400);
    s.v = prev + 1;
    if (await save(s, prev)) return json(s);
  }
  return json({ error: "opptatt" }, 409);
}

const key = (n: unknown) => String(n || "").toLowerCase().trim().replace(/[^a-z0-9æøå]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
const clean = (s: unknown, max = 120) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

function apply(s: State, o: Record<string, unknown>): void | false {
  const find = (id: unknown) => s.items.find((i) => i.id === id);
  switch (o.op) {
    case "add": {
      const name = clean(o.name, 80);
      if (!name) return false;
      const k = key(name);
      const known = s.often[k];
      const dup = s.items.find((i) => key(i.name) === k && !i.done);
      if (dup) { if (o.qty) dup.qty = clean(o.qty, 20); return; }
      if (s.items.length >= 200) return false;
      const cat = known?.cat || clean(o.cat, 20) || "annet";
      s.items.push({ id: crypto.randomUUID().slice(0, 12), name, qty: clean(o.qty, 20), cat, ean: known?.ean || "", pname: known?.pname || "", done: false, ts: Date.now() });
      s.often[k] = { ...(known || {}), name, cat, count: (known?.count || 0) + 1, last: Date.now() };
      const keys = Object.keys(s.often);
      if (keys.length > 300) {
        keys.sort((a, b) => (s.often[a].last || 0) - (s.often[b].last || 0)).slice(0, keys.length - 300).forEach((x) => delete s.often[x]);
      }
      return;
    }
    case "toggle": { const it = find(o.id); if (it) it.done = !it.done; return; }
    case "qty": { const it = find(o.id); if (it) it.qty = clean(o.qty, 20); return; }
    case "cat": {
      const it = find(o.id); if (!it) return;
      it.cat = clean(o.cat, 20);
      const of = s.often[key(it.name)]; if (of) of.cat = it.cat;
      return;
    }
    case "link": {
      const it = find(o.id); if (!it) return;
      it.ean = /^\d{8,14}$/.test(String(o.ean || "")) ? String(o.ean) : "";
      it.pname = it.ean ? clean(o.pname, 120) : "";
      const k = key(it.name);
      s.often[k] = { ...(s.often[k] || { name: it.name, cat: it.cat, count: 1, last: Date.now() }), ean: it.ean, pname: it.pname };
      return;
    }
    case "remove": { const ids = new Set((o.ids as string[]) || []); s.items = s.items.filter((i) => !ids.has(i.id)); return; }
    default: return false;
  }
}

// ---------- Kassalapp ----------
async function kassal(path: string, init: RequestInit = {}) {
  const k = getKassalKey();
  if (!k) return { error: "mangler_nokkel", status: 503 };
  const r = await fetch(KASSAL + path, {
    ...init,
    headers: { Authorization: `Bearer ${k}`, Accept: "application/json", "Content-Type": "application/json" },
  });
  if (r.status === 429) return { error: "for_mange_kall", status: 429 };
  if (r.status === 401 || r.status === 403) return { error: "ugyldig_nokkel", status: 502 };
  if (!r.ok) return { error: "kassalapp_feil", status: 502 };
  return { body: await r.json() };
}
// deno-lint-ignore no-explicit-any
const num = (v: any) => (typeof v === "number" ? v : v && typeof v.price === "number" ? v.price : null);

async function search(url: URL) {
  const q = (url.searchParams.get("q") || "").trim();
  if (q.length < 3) return json({ results: [] });
  const params = new URLSearchParams({ search: q, size: "20", unique: "true", exclude_without_ean: "true" });
  const res = await kassal("/products?" + params);
  if (res.error) return json({ error: res.error }, res.status);
  // deno-lint-ignore no-explicit-any
  const results = (res.body.data || []).filter((p: any) => p.ean).map((p: any) => ({
    ean: String(p.ean), name: p.name, brand: p.brand || p.vendor || "", image: p.image || "",
    weight: p.weight ?? null, unit: p.weight_unit || "", price: num(p.current_price), store: p.store?.name || "",
  }));
  return json({ results });
}

async function prices(body: { eans?: unknown[] }) {
  const list = [...new Set((body.eans || []).map(String).filter((e) => /^\d{8,14}$/.test(e)))].slice(0, 100);
  if (!list.length) return json({ items: [] });
  const res = await kassal("/products/prices-bulk", { method: "POST", body: JSON.stringify({ eans: list, days: 1 }) });
  if (res.error) return json({ error: res.error }, res.status);
  // deno-lint-ignore no-explicit-any
  const items = (res.body.data || []).map((it: any) => ({
    ean: String(it.ean), name: it.name,
    // deno-lint-ignore no-explicit-any
    stores: (it.stores || []).filter((s: any) => typeof s.current_price === "number")
      // deno-lint-ignore no-explicit-any
      .map((s: any) => ({ code: s.store, name: s.name, price: s.current_price, checked: s.last_checked })),
  }));
  return json({ items, fetched: new Date().toISOString() });
}
