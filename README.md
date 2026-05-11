# Loman sklad MVP

Funkčné desktopové aj mobilné MVP pre sklad a expedície.

## Stack

- `Node.js + Express`
- responzívny frontend pre mobil aj PC v `public/`
- perzistencia dát do `data/store.json`

## Spustenie

```bash
npm install
npm start
```

Appka beží na:

- `http://localhost:4174`
- alebo `http://TVOJA-LOKALNA-IP:4174` na mobile v rovnakej Wi-Fi

## Render deploy

Repo je pripravené na deploy na `Render` cez [render.yaml](/Users/patrikkorec/Desktop/loman/render.yaml).

Použi:

1. pushni repo na `GitHub`
2. v Renderi vytvor `New Blueprint Instance`
3. vyber toto repo
4. potvrď web service z `render.yaml`
5. nechaj zapnutý persistent disk

Render konfigurácia:

- web service `Node`
- `buildCommand`: `npm install`
- `startCommand`: `npm start`
- `healthCheckPath`: `/api/health`
- persistent disk mountnutý na `/opt/render/project/src/data`
- región `frankfurt`
- plán `starter`

Dôležité:

- persistent disk je nutný, lebo dáta sa ukladajú do `data/store.json`
- bez disku by sa objednávky a sklad po redeployi stratili
- disk nie je dostupný na `free` inštancii, preto je v konfigurácii `starter`
- sessions sú zatiaľ v pamäti procesu, takže po redeployi alebo reštarte sa používatelia prihlásia znova

## Platformy

- `iPhone / iPad`: otvor v `Safari`, funguje aj ako web app po `Add to Home Screen`
- `Android`: otvor v `Chrome`, dá sa nainštalovať na plochu
- `Windows`: otvor v `Edge` alebo `Chrome`, funguje normálne v prehliadači a dá sa pripnúť ako app

## Demo prihlásenie

- `Marek` admin, PIN `1111`
- `Jana` skladník, PIN `2222`
- `Peter` skladník, PIN `3333`
- `Ivana` skladník, PIN `4444`

## Čo je hotové

- jednoduché rozhranie pre mobil aj PC
- role `Admin` a `Skladník`
- session login cez `HttpOnly` cookie
- PINy ukladané hashovane (`scrypt`)
- vytvorenie objednávky adminom
- posun stavov `Na stroji -> Naskladnené -> Pripravené`
- označenie expedície
- digitálny sklad s lokáciami a množstvami
- história aktivít
- reset demo datasetu
- backend API s uložením do súboru

## API

- `GET /api/bootstrap`
- `POST /api/login`
- `POST /api/logout`
- `POST /api/orders`
- `PATCH /api/orders/:id/advance`
- `PATCH /api/orders/:id/expedition`
- `GET /api/health`

## Poznámka

Toto je reálne MVP, nie finálna produkčná verzia. Zatiaľ chýba databáza, push notifikácie a ERP integrácie.

Nové admin účty musia mať PIN aspoň `6` číslic. Existujúce demo účty v `data/store.json` ostávajú funkčné a pri štarte sa automaticky migrujú na hashované PINy.
