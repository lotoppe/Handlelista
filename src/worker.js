// Handlelista – Cloudflare Worker
// /api/state   GET   felles liste (Durable Object)
// /api/op      POST  endring av lista
// /api/search  GET   produktsøk via Kassalapp
// /api/prices  POST  dagens priser per kjede for en liste EAN-er
// Alt annet serveres fra ./public

const KASSAL = "https://kassal.app/api/v1";

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS ? env.ASSETS.fetch(req) : new Response("Not found", { status: 404 });

    if (env.APP_PASSWORD && req.headers.get("x-kode") !== env.APP_PASSWORD) {
      return json({ error: "feil_kode" }, 401);
    }

    try {
      if (url.pathname === "/api/state" || url.pathname === "/api/op") {
        const stub = env.LIST.get(env.LIST.idFromName("hjemme"));
        return stub.fetch(req);
      }
      if (url.pathname === "/api/search") return search(url, env);
      if (url.pathname === "/api/prices" && req.method === "POST") return prices(req, env);
      return json({ error: "ukjent" }, 404);
    } catch (e) {
      return json({ error: "serverfeil", detail: String(e && e.message || e) }, 500);
    }
  },
};

async function kassal(env, path, init = {}) {
  if (!env.KASSAL_KEY) return { error: "mangler_nokkel", status: 503 };
  const r = await fetch((env.KASSAL_BASE || KASSAL) + path, {
    ...init,
    headers: { Authorization: `Bearer ${env.KASSAL_KEY}`, Accept: "application/json", "Content-Type": "application/json", ...(init.headers || {}) },
  });
  if (r.status === 429) return { error: "for_mange_kall", status: 429 };
  if (r.status === 401 || r.status === 403) return { error: "ugyldig_nokkel", status: 502 };
  if (!r.ok) return { error: "kassalapp_feil", status: 502 };
  return { body: await r.json() };
}

const num = (v) => (typeof v === "number" ? v : v && typeof v === "object" && typeof v.price === "number" ? v.price : null);

async function search(url, env) {
  const q = (url.searchParams.get("q") || "").trim();
  if (q.length < 3) return json({ results: [] });
  const params = new URLSearchParams({ search: q, size: "20", unique: "true", exclude_without_ean: "true" });
  const res = await kassal(env, "/products?" + params);
  if (res.error) return json({ error: res.error }, res.status);
  const results = (res.body.data || [])
    .filter((p) => p.ean)
    .map((p) => ({
      ean: String(p.ean),
      name: p.name,
      brand: p.brand || p.vendor || "",
      image: p.image || "",
      weight: p.weight ?? null,
      unit: p.weight_unit || "",
      price: num(p.current_price),
      store: p.store?.name || "",
    }));
  return json({ results });
}

async function prices(req, env) {
  const { eans } = await req.json();
  const list = [...new Set((eans || []).map(String).filter((e) => /^\d{8,14}$/.test(e)))].slice(0, 100);
  if (!list.length) return json({ items: [] });

  // Del cache i 30 min så samme liste ikke bruker opp kall
  const cacheKey = new Request("https://cache.handlelista/prices/" + list.slice().sort().join(","));
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const res = await kassal(env, "/products/prices-bulk", { method: "POST", body: JSON.stringify({ eans: list, days: 1 }) });
  if (res.error) return json({ error: res.error }, res.status);
  const items = (res.body.data || []).map((it) => ({
    ean: String(it.ean),
    name: it.name,
    stores: (it.stores || [])
      .filter((s) => typeof s.current_price === "number")
      .map((s) => ({ code: s.store, name: s.name, price: s.current_price, checked: s.last_checked })),
  }));
  const out = json({ items, fetched: new Date().toISOString() });
  const toCache = out.clone();
  toCache.headers.set("Cache-Control", "max-age=1800");
  await cache.put(cacheKey, toCache);
  return out;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}

// ---------- Felles liste ----------
const key = (n) => String(n || "").toLowerCase().trim().replace(/[^a-z0-9æøå]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
const clean = (s, max = 120) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export class ListStore {
  constructor(state) {
    this.state = state;
  }
  async load() {
    if (!this.s) this.s = (await this.state.storage.get("s")) || { v: 0, items: [], often: {} };
    return this.s;
  }
  async fetch(req) {
    const s = await this.load();
    const url = new URL(req.url);
    if (req.method === "GET") {
      const since = Number(url.searchParams.get("v") || -1);
      return json(since === s.v ? { same: true, v: s.v } : s);
    }
    const op = await req.json();
    if (this.apply(s, op) === false) return json({ error: "ugyldig" }, 400);
    s.v++;
    await this.state.storage.put("s", s);
    return json(s);
  }
  apply(s, op) {
    const find = (id) => s.items.find((i) => i.id === id);
    switch (op.op) {
      case "add": {
        const name = clean(op.name, 80);
        if (!name) return false;
        const k = key(name);
        const known = s.often[k];
        const dup = s.items.find((i) => key(i.name) === k && !i.done);
        if (dup) { if (op.qty) dup.qty = clean(op.qty, 20); return; }
        if (s.items.length >= 200) return false;
        s.items.push({
          id: crypto.randomUUID().slice(0, 12),
          name,
          qty: clean(op.qty, 20),
          cat: known?.cat || clean(op.cat, 20) || "annet",
          ean: known?.ean || "",
          pname: known?.pname || "",
          done: false,
          ts: Date.now(),
        });
        s.often[k] = { ...(known || {}), name, cat: known?.cat || clean(op.cat, 20) || "annet", count: (known?.count || 0) + 1, last: Date.now() };
        // hold listen over faste varer kort
        const keys = Object.keys(s.often);
        if (keys.length > 300) {
          keys.sort((a, b) => (s.often[a].last || 0) - (s.often[b].last || 0)).slice(0, keys.length - 300).forEach((x) => delete s.often[x]);
        }
        return;
      }
      case "toggle": { const it = find(op.id); if (it) it.done = !it.done; return; }
      case "qty": { const it = find(op.id); if (it) it.qty = clean(op.qty, 20); return; }
      case "cat": {
        const it = find(op.id); if (!it) return;
        it.cat = clean(op.cat, 20);
        const o = s.often[key(it.name)]; if (o) o.cat = it.cat;
        return;
      }
      case "link": {
        const it = find(op.id); if (!it) return;
        it.ean = /^\d{8,14}$/.test(String(op.ean || "")) ? String(op.ean) : "";
        it.pname = it.ean ? clean(op.pname, 120) : "";
        const k = key(it.name);
        s.often[k] = { ...(s.often[k] || { name: it.name, cat: it.cat, count: 1, last: Date.now() }), ean: it.ean, pname: it.pname };
        return;
      }
      case "remove": { const ids = new Set(op.ids || []); s.items = s.items.filter((i) => !ids.has(i.id)); return; }
      default: return false;
    }
  }
}
