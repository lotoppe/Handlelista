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
- Har ikke en kjede akkurat produktet dere valgte, bruker appen den billigste varen i samme kategori og omtrent samme størrelse (±35 %), regnet om til samme størrelse. Trykk «lignende varer» under kjeden for å se hva den valgte. Kan slås av med bryteren.
- **Velg selv per butikk:** trykk «Se varene» under en butikk i kvitteringen. Der ser dere hva som er samme vare, lignende eller mangler, og kan trykke **Velg** for å plukke blant butikkens egne varer. Valget huskes.
- **Snittpris:** har en butikk ikke en vare, og ingenting er valgt der, brukes snittprisen fra de andre butikkene (merket ~), så totalsummene kan sammenlignes.
- **Penger spart:** når siste vare krysses av, spør appen hvilken butikk dere handlet i. Den regner ut hva lista kostet der mot den dyreste av de valgte butikkene, og samler sparingen under **Meny → Penger spart**.
- **Meny** (øverst til høyre): ny tom liste, lagre lista, lagrede lister, faste varer og butikker.
- **Lagre lista:** knappen nederst spør bare om et navn («Taco-fredag»). Under **Meny → Lagrede lister** åpner dere en lagret liste (bytter ut den som er åpen) eller legger varene til med «+ Legg til». Har den åpne lista endringer som ikke er lagret, spør appen om dere vil lagre først.
- **Meny → Del lista:** sender lenken via delingsmenyen på mobilen (eller kopierer den). «Del med kode» logger mottakeren rett inn. Åpne lenken i Safari og velg Del → *Legg til på Hjem-skjerm*, så får appen sitt eget ikon.
- **Meny → Faste varer:** koble f.eks. «Smør» til Olivero, og gi den gjerne andre navn («margarin»). Skriver dere navnet på lista, er produktet valgt automatisk. «+ Lista» legger varen rett på lista.
- **Meny → Butikker:** huk av kjedene dere handler i. Søk og totalpris viser bare disse. Valget er felles for alle som bruker lista.
- Prisene er ordinære hyllepriser fra Kassalapp. Medlemspriser (Coop, Trumf) er ikke med.

## Pause i Supabase

Gratisprosjekter i Supabase settes på pause etter en uke uten bruk. GitHub Actions-jobben `Hold Supabase våken` pinger derfor funksjonen hver tredje dag. Den starter av seg selv når prosjekt-URL-en er lagt inn i `docs/index.html`. Du kan også kjøre den manuelt under *Actions*.
