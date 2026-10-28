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
function secretName(pattern: RegExp): string | undefined {
  return Object.keys(Deno.env.toObject()).find((k) => pattern.test(k) && !/^SUPABASE_/i.test(k));
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
// settings.stores: kjeder som skal være med (tom = alle). chains: kjeder appen har sett, kode → navn
// saved: lagrede lister som kan hentes fram igjen, id → { name, items, ts }
type Saved = { name: string; ts: number; items: Omit<Item, "id" | "done" | "ts">[] };
type State = { v: number; items: Item[]; often: Record<string, Often>; settings?: { stores: string[] }; chains?: Record<string, string>; saved?: Record<string, Saved> };
// kcat/w/wu/q beskriver det valgte produktet, så appen kan finne lignende varer i andre kjeder
type Meta = { kcat?: number; w?: number; wu?: string; q?: string; img?: string };
// Produktbilde fra Kassalapp (bare https-adresser)
const imgOf = (v: unknown) => (/^https:\/\//.test(String(v || "")) ? String(v).slice(0, 500) : undefined);
type Item = { id: string; name: string; qty: string; cat: string; ean: string; pname: string; done: boolean; ts: number } & Meta;
// fast = lagt inn på siden «Faste varer». aliases = andre navn som skal gi samme produkt
type Often = { name: string; cat: string; count: number; last: number; ean?: string; pname?: string; fast?: boolean; aliases?: string[] } & Meta;

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
  for (let tries = 0; tries < 8; tries++) {
    if (tries) await new Promise((r) => setTimeout(r, 40 + Math.random() * 120 * tries));
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
      let fk = k, known = s.often[k];
      // «margarin» kan være et annet navn på den faste varen «Smør»
      if (!known?.ean) {
        const hit = Object.entries(s.often).find(([, of]) => of.fast && of.ean && (of.aliases || []).some((a) => key(a) === k));
        if (hit) { fk = hit[0]; known = hit[1]; }
      }
      const dup = s.items.find((i) => key(i.name) === k && !i.done);
      if (dup) { if (o.qty) dup.qty = clean(o.qty, 20); return; }
      if (s.items.length >= 200) return false;
      const cat = known?.cat || clean(o.cat, 20) || "annet";
      s.items.push({ id: crypto.randomUUID().slice(0, 12), name, qty: clean(o.qty, 20), cat, ean: known?.ean || "", pname: known?.pname || "", kcat: known?.kcat, w: known?.w, wu: known?.wu, q: known?.q, img: known?.img, done: false, ts: Date.now() });
      s.often[fk] = { ...(known || {}), name: fk === k ? name : known!.name, cat, count: (known?.count || 0) + 1, last: Date.now() };
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
      const meta: Meta = it.ean
        ? { kcat: Number(o.kcat) || undefined, w: Number(o.w) || undefined, wu: clean(o.wu, 10) || undefined, q: clean(o.q, 60) || undefined, img: imgOf(o.img) }
        : { kcat: undefined, w: undefined, wu: undefined, q: undefined, img: undefined };
      Object.assign(it, meta);
      const k = key(it.name);
      s.often[k] = { ...(s.often[k] || { name: it.name, cat: it.cat, count: 1, last: Date.now() }), ean: it.ean, pname: it.pname, ...meta };
      return;
    }
    case "fav_set": {
      const name = clean(o.name, 80);
      if (!name) return false;
      const k = o.key ? key(o.key) : key(name);
      const cur: Often = s.often[k] || { name, cat: clean(o.cat, 20) || "annet", count: 0, last: Date.now() };
      const upd: Often = { ...cur, name, fast: true };
      if (o.cat) upd.cat = clean(o.cat, 20);
      if ("aliases" in o) upd.aliases = String(o.aliases || "").split(",").map((a) => clean(a, 40)).filter(Boolean).slice(0, 10);
      if ("ean" in o) {
        upd.ean = /^\d{8,14}$/.test(String(o.ean || "")) ? String(o.ean) : "";
        upd.pname = upd.ean ? clean(o.pname, 120) : "";
        Object.assign(upd, upd.ean
          ? { kcat: Number(o.kcat) || undefined, w: Number(o.w) || undefined, wu: clean(o.wu, 10) || undefined, q: clean(o.q, 60) || undefined, img: imgOf(o.img) }
          : { kcat: undefined, w: undefined, wu: undefined, q: undefined, img: undefined });
      }
      s.often[k] = upd;
      // Varer som allerede står på lista uten produkt, får det med en gang
      if (upd.ean) {
        const names = new Set([k, ...(upd.aliases || []).map(key)]);
        for (const it of s.items) if (!it.done && !it.ean && names.has(key(it.name))) {
          Object.assign(it, { ean: upd.ean, pname: upd.pname, kcat: upd.kcat, w: upd.w, wu: upd.wu, q: upd.q, img: upd.img });
        }
      }
      if (Object.keys(s.often).length > 400) return false;
      return;
    }
    case "fav_remove": { const of = s.often[key(o.key)]; if (of) of.fast = false; return; }
    case "settings": {
      const list = Array.isArray(o.stores) ? (o.stores as unknown[]).map((x) => clean(x, 40)).filter(Boolean).slice(0, 40) : [];
      s.settings = { stores: list };
      return;
    }
    case "chains": {
      s.chains = { ...(s.chains || {}) };
      for (const [c, n] of Object.entries((o.chains || {}) as Record<string, unknown>)) if (c) s.chains[clean(c, 40)] = clean(n, 60) || clean(c, 40);
      return;
    }
    case "save_list": {
      const name = clean(o.name, 60);
      const open = s.items.filter((i) => !i.done);
      if (!name || !open.length) return false;
      s.saved = { ...(s.saved || {}) };
      // Samme navn overskriver den gamle lista
      const existing = Object.entries(s.saved).find(([, l]) => key(l.name) === key(name));
      const id = existing ? existing[0] : crypto.randomUUID().slice(0, 10);
      s.saved[id] = { name, ts: Date.now(), items: open.slice(0, 120).map(({ id: _i, done: _d, ts: _t, ...rest }) => rest) };
      const ids = Object.keys(s.saved);
      if (ids.length > 40) ids.sort((a, b) => s.saved![a].ts - s.saved![b].ts).slice(0, ids.length - 40).forEach((x) => delete s.saved![x]);
      return;
    }
    case "load_list": {
      const l = s.saved?.[String(o.id)];
      if (!l) return false;
      for (const it of l.items) {
        if (s.items.length >= 200) break;
        const dup = s.items.find((i) => !i.done && key(i.name) === key(it.name));
        if (dup) continue;
        s.items.push({ ...it, id: crypto.randomUUID().slice(0, 12), done: false, ts: Date.now() });
      }
      return;
    }
    case "delete_list": { if (s.saved) { s.saved = { ...s.saved }; delete s.saved[String(o.id)]; } return; }
    case "remove": { const ids = new Set((o.ids as string[]) || []); s.items = s.items.filter((i) => !ids.has(i.id)); return; }
    default: return false;
  }
}

// ---------- Kassalapp ----------
async function kassal(path: string, init: RequestInit = {}) {
  // Tåler at nøkkelen er limt inn med «Bearer » foran eller med anførselstegn
  const k = getKassalKey()?.replace(/^bearer\s+/i, "").replace(/^["']|["']$/g, "").trim();
  if (!k) { console.error("Kassalapp: fant ingen nøkkel. Navn funnet:", secretName(/kassal/i) ?? "ingen"); return { error: "mangler_nokkel", status: 503 }; }
  const r = await fetch(KASSAL + path, {
    ...init,
    headers: { Authorization: `Bearer ${k}`, Accept: "application/json", "Content-Type": "application/json", "User-Agent": "Handlelista/1.0" },
  });
  if (!r.ok) {
    const body = (await r.text()).slice(0, 300);
    console.error("Kassalapp", r.status, path.split("?")[0], "nøkkelnavn:", secretName(/kassal/i) ?? "KASSAL_KEY", "lengde:", k.length, "svar:", body);
  }
  if (r.status === 429) return { error: "for_mange_kall", status: 429 };
  if (r.status === 401 || r.status === 403) return { error: "ugyldig_nokkel", status: 502 };
  if (!r.ok) return { error: "kassalapp_feil", status: 502 };
  return { body: await r.json() };
}
// ---------- Hjelpere for Kassalapp-data ----------
// deno-lint-ignore no-explicit-any
type Any = any;
const first = (v: Any) => (Array.isArray(v) ? v[0] : v);
// Pris kan komme som tall, {price} eller [{price}]
const num = (v: Any): number | null => {
  v = first(v);
  return typeof v === "number" ? v : v && typeof v.price === "number" ? v.price : null;
};
const unitNum = (p: Any): number | null => {
  if (typeof p?.current_unit_price === "number") return p.current_unit_price;
  const c = first(p?.current_price);
  return c && typeof c.unit_price === "number" ? c.unit_price : null;
};
function storeInfo(st: Any, fallbackName = ""): { code: string; name: string } {
  st = first(st);
  if (typeof st === "string") return { code: st, name: fallbackName || st };
  return { code: String(st?.code || st?.name || ""), name: String(st?.name || st?.code || "") };
}
// Dypeste (mest presise) kategori, f.eks. «Grovbrød» framfor «Brød og bakevarer»
function deepestCat(c: Any): number | undefined {
  const arr = Array.isArray(c) ? c : c ? [c] : [];
  let best: Any;
  for (const x of arr) if (x && typeof x.id === "number" && (!best || (x.depth ?? 0) >= (best.depth ?? 0))) best = x;
  return best?.id;
}
// Samme enhet for sammenligning: g, ml eller stk
function normW(w: unknown, u: unknown): { v: number; u: string } | null {
  const n = Number(w);
  if (!n) return null;
  const unit = String(u || "").toLowerCase();
  const f: Record<string, [number, string]> = { kg: [1000, "g"], g: [1, "g"], l: [1000, "ml"], dl: [100, "ml"], cl: [10, "ml"], ml: [1, "ml"] };
  const [m, base] = f[unit] || [1, "stk"];
  return { v: n * m, u: base };
}
const sizeLabel = (w: unknown, u: unknown) => (Number(w) ? `${w} ${u === "piece" ? "stk" : u || ""}`.trim() : "");

// Husk kjedene vi ser, så de kan velges i innstillingene. Skriver bare når noe er nytt.
async function recordChains(found: Map<string, string>) {
  if (!found.size) return;
  try {
    const s = await load();
    const fresh = [...found].filter(([c]) => !s.chains?.[c]);
    if (fresh.length) await op({ op: "chains", chains: Object.fromEntries(fresh) });
  } catch (e) { console.error("recordChains", e); }
}
const allowedFrom = (v: unknown): Set<string> | null => {
  const arr = Array.isArray(v) ? v : typeof v === "string" && v ? v.split(",") : [];
  const set = new Set(arr.map((x) => String(x).trim()).filter(Boolean));
  return set.size ? set : null;
};

// ---------- Produktsøk ----------
async function search(url: URL) {
  const q = (url.searchParams.get("q") || "").trim();
  if (q.length < 3) return json({ results: [] });
  const allowed = allowedFrom(url.searchParams.get("stores"));
  // Ikke slått sammen per strekkode, så vi ser hvilke kjeder som har varen
  const params = new URLSearchParams({ search: q, size: "100", exclude_without_ean: "1" });
  const res = await kassal("/products?" + params);
  if (res.error) return json({ error: res.error }, res.status);
  const byEan = new Map<string, Any>();
  const seen = new Map<string, string>();
  for (const p of res.body.data || []) {
    if (!p?.ean) continue;
    const st = storeInfo(p.store);
    if (st.code) seen.set(st.code, st.name);
    const ok = !allowed || allowed.has(st.code);
    const price = num(p.current_price);
    let e = byEan.get(String(p.ean));
    if (!e) {
      e = {
        ean: String(p.ean), name: p.name, brand: p.brand || p.vendor || "", image: p.image || "",
        weight: p.weight ?? null, unit: p.weight_unit || "", price: null as number | null, stores: [] as string[],
        kcat: deepestCat(p.category) ?? null,
      };
      byEan.set(e.ean, e);
    }
    if (!e.image && p.image) e.image = p.image;
    if (e.kcat == null) e.kcat = deepestCat(p.category) ?? null;
    if (ok && st.name && !e.stores.includes(st.name)) e.stores.push(st.name);
    if (ok && price != null && (e.price == null || price < e.price)) e.price = price;
  }
  await recordChains(seen);
  const results = [...byEan.values()].filter((e) => e.stores.length).slice(0, 25);
  return json({ results });
}

// ---------- Mellomlager i Postgres (sparer Kassalapp-kall) ----------
async function cacheGet(keys: string[]): Promise<Map<string, Any>> {
  const out = new Map<string, Any>();
  if (!keys.length) return out;
  try {
    for (let i = 0; i < keys.length; i += 80) {
      const chunk = keys.slice(i, i + 80).map((k) => `"${k.replace(/"/g, "")}"`).join(",");
      const r = await fetch(
        `${DB_URL}/rest/v1/handlelista_cache?select=key,data&key=in.(${encodeURIComponent(chunk)})&expires_at=gt.${encodeURIComponent(new Date().toISOString())}`,
        { headers: dbHeaders() },
      );
      if (r.ok) for (const row of await r.json()) out.set(row.key, row.data);
    }
  } catch (e) { console.error("cacheGet", e); }
  return out;
}
async function cachePut(rows: { key: string; data: unknown; hours: number }[]) {
  if (!rows.length) return;
  try {
    const now = Date.now();
    await fetch(`${DB_URL}/rest/v1/handlelista_cache`, {
      method: "POST",
      headers: dbHeaders({ Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify(rows.map((r) => ({ key: r.key, data: r.data ?? { none: true }, expires_at: new Date(now + r.hours * 3600e3).toISOString() }))),
    });
  } catch (e) { console.error("cachePut", e); }
}

// ---------- Priser ----------
type Store = { code: string; name: string; price: number; checked?: string; sub?: { name: string; size: string; actual?: number; per?: string } };
type Want = { ean: string; name?: string; q?: string } & Meta;

function storeOf(x: Any): Store | null {
  const price = num(x?.current_price ?? x?.price);
  if (price == null) return null;
  const si = storeInfo(x?.store, typeof x?.store === "string" ? x?.name : "");
  if (!si.code) return null;
  return { code: si.code, name: si.name, price, checked: x?.last_checked || first(x?.current_price)?.date };
}
function bestPerChain(list: (Store | null)[]): Store[] {
  const m = new Map<string, Store>();
  for (const s of list) if (s) { const o = m.get(s.code); if (!o || s.price < o.price) m.set(s.code, s); }
  return [...m.values()];
}

// Eksakt pris per kjede + metadata (kategori, vekt) for én strekkode
async function lookupEan(ean: string): Promise<{ name: string; stores: Store[]; meta: Meta }> {
  const res = await kassal("/products/ean/" + ean);
  if (res.error) return { name: "", stores: [], meta: {} };
  const d = res.body?.data ?? {};
  const products: Any[] = Array.isArray(d) ? d : d.products || [];
  const p0 = products.find((p) => p?.category) || products[0] || {};
  return {
    name: d.name || p0.name || "",
    stores: bestPerChain(products.map(storeOf)),
    meta: { kcat: deepestCat(p0.category), w: Number(p0.weight) || undefined, wu: p0.weight_unit || undefined },
  };
}

// Billigste lignende vare i én kjede: samme kategori, omtrent samme størrelse
async function findSimilar(chain: Store, want: Want): Promise<Store | null | "limit"> {
  const target = normW(want.w, want.wu);
  const tries: URLSearchParams[] = [];
  if (want.kcat) tries.push(new URLSearchParams({ store: chain.code, category_id: String(want.kcat), size: "60" }));
  const term = (want.q || want.name || "").trim();
  if (term.length >= 3) tries.push(new URLSearchParams({ store: chain.code, search: term, size: "40" }));

  for (const params of tries) {
    const res = await kassal("/products?" + params);
    if (res.error === "for_mange_kall") return "limit";
    if (res.error) continue;
    const cands = (res.body.data || [])
      .map((p: Any) => ({ p, price: num(p.current_price), unit: unitNum(p), w: normW(p.weight, p.weight_unit) }))
      .filter((c: Any) => c.price != null && storeInfo(c.p.store).code === chain.code)
      .filter((c: Any) => {
        if (!target) return true;
        if (!c.w || c.w.u !== target.u) return false;
        const r = c.w.v / target.v;
        return r >= 0.65 && r <= 1.5; // ±35 % størrelse
      });
    if (!cands.length) continue;
    // Billigst per kilo/liter når vi har det, ellers billigst
    cands.sort((a: Any, b: Any) => (a.unit ?? a.price) - (b.unit ?? b.price));
    const c = cands[0];
    // Regn om til samme størrelse som det valgte produktet, så totalsummene kan sammenlignes
    const scaled = target && c.w && Math.abs(c.w.v / target.v - 1) > 0.02;
    const price = scaled ? Math.round(c.price * (target!.v / c.w.v) * 100) / 100 : c.price;
    return {
      code: chain.code, name: chain.name, price,
      sub: { name: c.p.name, size: sizeLabel(c.p.weight, c.p.weight_unit), ...(scaled ? { actual: c.price, per: sizeLabel(want.w, want.wu) } : {}) },
    };
  }
  return null;
}

let loggedShape = false;
async function prices(body: { eans?: unknown[]; items?: Want[]; similar?: boolean; stores?: string[] }) {
  const allowed = allowedFrom(body.stores);
  const wants: Want[] = (body.items?.length ? body.items : (body.eans || []).map((e) => ({ ean: String(e) })))
    .filter((w) => /^\d{8,14}$/.test(String(w?.ean)))
    .slice(0, 100);
  const uniq = [...new Map(wants.map((w) => [String(w.ean), { ...w, ean: String(w.ean) }])).values()];
  if (!uniq.length) return json({ items: [] });
  const byEan = new Map<string, { ean: string; name: string; stores: Store[] }>();

  // 1) Eksakte priser i ett samlekall
  const res = await kassal("/products/prices-bulk", { method: "POST", body: JSON.stringify({ eans: uniq.map((w) => w.ean), days: 1 }) });
  if (res.error === "for_mange_kall") return json({ error: res.error }, 429);
  if (!res.error) {
    if (!loggedShape) { loggedShape = true; console.log("prices-bulk form:", JSON.stringify(res.body).slice(0, 400)); }
    const data = res.body?.data;
    const arr: Any[] = Array.isArray(data) ? data : data && typeof data === "object" ? Object.values(data) : [];
    for (const it of arr) {
      const ean = String(it?.ean ?? "");
      const stores = bestPerChain(((it?.stores || it?.prices || []) as Any[]).map(storeOf));
      if (ean && stores.length) byEan.set(ean, { ean, name: it.name || "", stores });
    }
  }
  // 2) Det samlesvaret ikke dekket, og metadata vi mangler: per strekkode (mellomlagret)
  const needLookup = uniq.filter((w) => !byEan.has(w.ean) || (body.similar && !w.kcat && !w.w));
  const cached = await cacheGet(needLookup.map((w) => "ean:" + w.ean));
  const toCache: { key: string; data: unknown; hours: number }[] = [];
  for (let i = 0; i < needLookup.length; i += 5) {
    await Promise.all(needLookup.slice(i, i + 5).map(async (w) => {
      let r = cached.get("ean:" + w.ean);
      if (!r || r.none) { r = await lookupEan(w.ean); toCache.push({ key: "ean:" + w.ean, data: r, hours: 6 }); }
      if (!byEan.has(w.ean) && r.stores?.length) byEan.set(w.ean, { ean: w.ean, name: r.name, stores: r.stores });
      if (!w.kcat) w.kcat = r.meta?.kcat;
      if (!w.w) { w.w = r.meta?.w; w.wu = r.meta?.wu; }
    }));
  }

  // Husk alle kjeder vi så, og fjern dem som ikke er valgt i innstillingene
  const seenChains = new Map<string, string>();
  for (const it of byEan.values()) for (const st of it.stores) seenChains.set(st.code, st.name);
  await recordChains(seenChains);
  if (allowed) {
    for (const [ean, it] of byEan) {
      it.stores = it.stores.filter((st) => allowed.has(st.code));
      if (!it.stores.length && !body.similar) byEan.delete(ean);
    }
  }

  // 3) Lignende varer der kjeden mangler akkurat produktet
  let subs = 0, limited = false;
  if (body.similar) {
    // Kjeder som har minst 40 % av varene regnes som aktuelle
    const seen = new Map<string, { s: Store; n: number }>();
    for (const it of byEan.values()) for (const s of it.stores) {
      const o = seen.get(s.code); seen.set(s.code, { s: o?.s || s, n: (o?.n || 0) + 1 });
    }
    const need = Math.max(1, Math.ceil(uniq.length * 0.4));
    let chains = [...seen.values()].filter((c) => c.n >= need).sort((a, b) => b.n - a.n).slice(0, 8).map((c) => c.s);
    // Er kjedene valgt i innstillingene, sjekker vi akkurat dem
    if (allowed) {
      const names = (await load()).chains || {};
      chains = [...allowed].slice(0, 10).map((code) => ({ code, name: seenChains.get(code) || names[code] || code, price: 0 }));
    }

    const jobs: { w: Want; chain: Store; key: string }[] = [];
    for (const w of uniq) {
      const have = new Set((byEan.get(w.ean)?.stores || []).map((s) => s.code));
      for (const chain of chains) if (!have.has(chain.code)) jobs.push({ w, chain, key: `sub:${w.ean}:${chain.code}:${w.kcat || ""}:${w.w || ""}` });
    }
    const subCache = await cacheGet(jobs.map((j) => j.key));
    const MAX_CALLS = 30;
    let calls = 0;
    for (let i = 0; i < jobs.length; i += 4) {
      await Promise.all(jobs.slice(i, i + 4).map(async (j) => {
        let hit: Store | null | undefined = subCache.has(j.key) ? (subCache.get(j.key).none ? null : subCache.get(j.key)) : undefined;
        if (hit === undefined) {
          if (limited || calls >= MAX_CALLS) return;
          calls++;
          const r = await findSimilar(j.chain, j.w);
          if (r === "limit") { limited = true; return; }
          hit = r;
          toCache.push({ key: j.key, data: r, hours: 12 });
        }
        if (hit) {
          const entry = byEan.get(j.w.ean) || { ean: j.w.ean, name: j.w.name || "", stores: [] };
          entry.stores.push({ ...hit, code: j.chain.code, name: j.chain.name });
          byEan.set(j.w.ean, entry);
          subs++;
        }
      }));
    }
    if (calls >= MAX_CALLS) limited = true;
  }
  await cachePut(toCache);
  const asked = new Set(uniq.map((w) => w.ean));
  const items = [...byEan.values()].filter((it) => it.stores.length && asked.has(it.ean));
  return json({ items, subs, partial: limited, fetched: new Date().toISOString() });
}
