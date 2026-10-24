# Toepen!

Multiplayer toepen voor 2 tot 4 spelers op je telefoon. Eén telefoon maakt een kamer aan en is de host; de anderen doen mee met een kamercode. Geen pc of server nodig, wel internet om verbinding te maken.

## Spelen

1. Open `https://teungritter.github.io/toepen/` op je telefoon, vul je naam in en tik **Kamer maken**.
2. Je krijgt een kamercode van 4 letters en een QR-code. Anderen scannen de QR, openen de link of vullen de code in bij **Meedoen**.
3. Te weinig spelers? Vul de tafel aan met bots (tik op hun niveau om te wisselen).
4. Kies **Klassiek**, **Kroeg** of **Finale** en druk op **Start**.

De host-telefoon draait het spel: houd de app open. Herlaadt iemand de pagina (ook de host), dan gaat het spel gewoon verder.

Tip: kies in Safari/Chrome "Zet op beginscherm" (of "App installeren"), dan draait het spel schermvullend als een app en start het direct op.

Extra's: geluid en trillen (aan/uit in het ☰-menu), snelle reacties via de 😀-knop, statistieken en titels op het eindscherm, en de host kiest de stijl.

## Spelregels

Zie het ☰-menu in het spel. Kort:
- 32 kaarten, 4 per speler. Rangorde laag → hoog: B V H A 7 8 9 10.
- Kleur bekennen. Alleen de laatste slag telt.
- Toepen = inzet +1; anderen gaan mee of passen (passen kost de oude inzet).
- Blind: vóór iemand kijkt mag je blind spelen voor 2–4 punten (max. 2× per speler per potje). Anderen: blind mee (= het bedrag) of gezien (kijken, dan mee voor +1 of weg voor het bedrag).
- Af bij 15 strafpunten (10 kan ook). Laatste overlevende wint.
- Op scherp: wie op 14 staat moet genomen worden. Iedereen kijkt; mee = 2 punten, weg = 1.
- Op 14 mag je niet toepen; één tegen één met iemand op 14 toept niemand.
- Finale: staan alle overgebleven spelers op 14, dan 8 kaarten elk, zonder toepen.

**Spelvorm Finale**: één ronde, 8 kaarten per persoon, niet toepen. Laatste slag wint het potje.

**Kroegregels** (los aan/uit te zetten): Was, Doorgeven, Dubbel toepen, Boerenslag, Comeback.

**Bots**: Makkelijk (willekeurig), Gemiddeld (vuistregels), Moeilijk (rekent kansen uit met wat hij kan weten) en God (kijkt stiekem in ieders kaarten).

Gewonnen potjes worden bijgehouden zolang je aan tafel blijft (🏆 in de lobby en in het menu).

## Op GitHub Pages zetten

1. Ga naar https://github.com/new, naam `toepen`, **Public**, maak de repository aan.
2. Klik op **uploading an existing file** en sleep alle bestanden uit `D:\Toepen` erin. Klik **Commit changes**.
3. Ga naar **Settings → Pages**, kies bij *Branch* `main` en `/ (root)`, klik **Save**.
4. Na een minuutje staat het spel op `https://teungritter.github.io/toepen/`.

Bij een update: stap 2 opnieuw (bestaande bestanden worden overschreven).

## Bestanden

- `game.js`: alle spelregels, het spelverloop en de bots. Draait op de host-telefoon.
- `app.js`: de interface en de verbinding tussen de telefoons (PeerJS).
- `index.html`, `style.css`: de pagina en de stijlen.
- `sw.js`, `manifest.webmanifest`, `icon-*.png`, `icon.svg`: installeerbare app (PWA) en iconen.
- `vendor/`: PeerJS 1.5.4 en qrcodejs 1.0.0, lokaal meegeleverd.
- `fonts/`: Fredoka en Nunito (SIL Open Font License).
