# Handlelista

Felles handleliste med totalpris per butikkjede, med priser fra Kassalapp.

- **Appen** (`docs/index.html`) ligger på GitHub Pages.
- **Lista og Kassalapp-nøkkelen** ligger i Supabase: én tabell og én edge-funksjon (`supabase/`).

## Oppsett (én gang)

### 1. Kassalapp-nøkkel
Logg inn på https://kassal.app/api og lag en API-nøkkel.

### 2. Supabase
Bruk gjerne et nytt prosjekt, så holdes handlelista adskilt fra bryllupssiden (gratisplanen tillater to prosjekter).

1. **Tabell:** Åpne *SQL Editor → New query*, lim inn innholdet i `supabase/setup.sql` og trykk *Run*.
2. **Funksjon:** Åpne *Edge Functions → Deploy a new function → Via Editor*. Gi den navnet `handlelista` (nøyaktig), lim inn hele `supabase/functions/handlelista/index.ts` og trykk *Deploy*.
3. **Slå av JWT-sjekk:** Åpne funksjonen, gå til *Details* og slå av **Verify JWT with legacy secret** (eller «Enforce JWT verification»). Appen beskyttes av koden deres i stedet. Trykk *Save*.
4. **Hemmeligheter:** Åpne *Edge Functions → Secrets* og legg til:
   - `KASSAL_KEY`: Kassalapp-nøkkelen
   - `APP_PASSWORD`: en kode dere velger selv
5. **Prosjekt-URL:** Kopier *Project URL* fra *Project Settings → Data API*. Den ser ut som `https://abcdefgh.supabase.co`.

### 3. Appen
1. Åpne `docs/index.html` i GitHub, trykk blyanten og bytt ut `https://DITT-PROSJEKT.supabase.co` med prosjekt-URL-en din. Trykk *Commit changes*.
2. Gå til repoets *Settings → Pages*. Under *Build and deployment* velger du *Deploy from a branch*, deretter `main` og mappen `/docs`. Trykk *Save*.
3. Etter et minutt eller to ligger appen på `https://lotoppe.github.io/handlelista/`. Åpne den, skriv koden og legg den på Hjem-skjermen (Del → *Legg til på Hjem-skjerm*).

## Bruk

- Skriv varer nederst, gjerne flere med komma: `2 melk, brød, bananer`.
- Trykk **velg** på en vare og plukk produktet dere kjøper. Valget huskes til neste gang.
- Trykk **Hva koster lista?** for totalpris per kjede. Antall (`2`, `3 stk`) ganges inn; vekt og volum teller som én.
- Prisene er ordinære hyllepriser fra Kassalapp. Medlemspriser (Coop, Trumf) er ikke med.

## Pause i Supabase

Gratisprosjekter i Supabase settes på pause etter en uke uten bruk. GitHub Actions-jobben `Hold Supabase våken` pinger derfor funksjonen hver tredje dag. Den starter av seg selv når prosjekt-URL-en er lagt inn i `docs/index.html`. Du kan også kjøre den manuelt under *Actions*.
