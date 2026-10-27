# Handlelista

Felles handleliste med totalpris per butikkjede, med priser fra Kassalapp.
Kjører gratis som én Cloudflare Worker: appen (`public/index.html`), den felles lista (Durable Object) og en mellomserver som holder Kassalapp-nøkkelen hemmelig (`src/worker.js`).

## Oppsett (ca. 15 minutter, én gang)

1. **Kassalapp-nøkkel**: Logg inn på https://kassal.app/api og lag en API-nøkkel. Ta vare på den.
2. **Cloudflare-konto**: Opprett gratis konto på https://dash.cloudflare.com.
3. **Koble repoet**: I Cloudflare: *Workers & Pages → Create → Import a repository*, velg dette repoet. Standardinnstillingene holder (bygg-kommandoen er tom, deploy-kommandoen er `npx wrangler deploy`). Trykk *Deploy*.
4. **Hemmeligheter**: Åpne workeren *handlelista → Settings → Variables and Secrets* og legg til to av typen *Secret*:
   - `KASSAL_KEY`: Kassalapp-nøkkelen
   - `APP_PASSWORD`: en kode dere velger selv, som beskytter lista
5. **Åpne appen**: Adressen står øverst på workeren (`handlelista.<navn>.workers.dev`). Skriv inn koden. På iPhone: Del → *Legg til på Hjem-skjerm*, så blir den en app-ikon.

Hver gang noe pushes til repoet, publiserer Cloudflare automatisk på nytt.

## Bruk

- Skriv varer nederst, gjerne flere med komma: `2 melk, brød, bananer`.
- Trykk **velg** på en vare og plukk produktet dere kjøper. Valget huskes, så neste gang varen legges til er den allerede koblet.
- Trykk **Hva koster lista?** for totalpris per kjede. Antall (`2`, `3 stk`) ganges inn; vekt og volum teller som én.
- Prisene er ordinære hyllepriser fra Kassalapp. Medlemspriser (Coop, Trumf) er ikke med.

## Gratisgrenser

Cloudflare Workers gratis: 100 000 forespørsler per dag. Appen spør etter endringer hvert 5. sekund bare mens den er åpen, så vanlig bruk ligger langt under. Prisoppslag caches i 30 minutter.
