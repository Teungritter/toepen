# Toepen!

Multiplayer toepen voor 2 tot 4 spelers op je telefoon. Eén telefoon maakt een kamer aan en is de host; de anderen doen mee met een kamercode. Geen pc of server nodig, wel internet om verbinding te maken.

## Spelen

1. Open `https://teungritter.github.io/toepen/` op je telefoon, vul je naam in en tik **Kamer maken**.
2. Je krijgt een kamercode van 4 letters en een QR-code. Anderen scannen de QR, openen de link of vullen de code in bij **Meedoen**.
3. Te weinig spelers? Vul de tafel aan met bots (tik op hun niveau om te wisselen).
4. Kies **Klassiek**, **Kroeg** of **Finale** en druk op **Start**.

De host-telefoon draait het spel: houd de app open. Herlaadt iemand de pagina (ook de host), dan gaat het spel gewoon verder.

Tip: kies in Safari/Chrome "Zet op beginscherm" (of "App installeren"), dan draait het spel schermvullend als een app en start het direct op.

Muntjes en shop: je begint met 100 muntjes. Win je een potje met minstens één andere echte speler, dan krijg je 100 muntjes (25 als je alleen van bots wint). In de shop koop je kaartruggen en een rand om je avatar (die zien de anderen ook), een tafelkleed en een winst-effect. Alles wordt op je eigen telefoon bewaard, zonder account.

Extra's: expert-hulp (standaard uit, aan te zetten in het ☰-menu: tipt welke kaart je het beste speelt en of je mee moet), een vaste avatar die je in het menu kiest, geluid en trillen (aan/uit in het ☰-menu), snelle reacties via de 😀-knop, statistieken en titels op het eindscherm, en de host kiest de stijl.

## Spelregels

Zie het ☰-menu in het spel. Kort:
- 32 kaarten, 4 per speler. Rangorde laag → hoog: B V H A 7 8 9 10.
- Kleur bekennen. Alleen de laatste slag telt.
- Toepen = inzet +1; de anderen kiezen om de beurt (met de klok mee) mee of passen (passen kost de oude inzet).
- De speler links van de rondewinnaar begint de volgende ronde.
- Inkopen: wie als eerste af is, mag zich direct inkopen voor 50 muntjes en komt op de stand van de hoogste speler. Niet als iemand anders op 14 staat, niet als er al iemand af is en niet een ronde later. Maar 1× per potje. De winnaar krijgt dan 25 muntjes extra.
- Blind: vóór iemand kijkt mag je blind spelen voor 2, 3 of 4 punten (max. 2× per speler per potje). Anderen kiezen om de beurt: meteen weg (1 punt, zonder te kijken), gezien (kijken, dan mee voor +1 of weg voor 2) of blind mee (= het bedrag). Blind telt als een toep: de blindspeler mag pas weer toepen nadat iemand anders heeft getoept.
- Af bij 15 strafpunten (10 kan ook); je eindigt nooit boven de 15. Laatste overlevende wint.
- Op scherp: wie op 14 staat moet genomen worden en mag beginnen. Iedereen kijkt; mee = 2 punten, weg = 1. Geen blind.
- Zolang iemand op 14 meedoet, kan niemand toepen.
- Finale: staan alle overgebleven spelers op 14, dan 8 kaarten elk, zonder toepen.

**Spelvorm Finale**: één ronde, 8 kaarten per persoon, niet toepen. Laatste slag wint het potje.

**Kroegregels** (los aan/uit te zetten): Was, Doorgeven, Dubbel toepen, Boerenslag, Comeback.

**Bots**: Makkelijk (willekeurig), Gemiddeld (vuistregels), Moeilijk en God.
- Moeilijk rekent per zet 150 mogelijke kaartverdelingen door met alleen wat hij kan weten. Hij blufft, en past zich aan: toepers die vaak eerlijk toepen neemt hij serieus, en tegen spelers die snel passen blufft hij meer.
- God kijkt stiekem in ieders kaarten en blufft alleen als hij weet dat de anderen passen.
- Afgesteld met ruim 25.000 gesimuleerde potjes. Tegen drie Gemiddeld-bots wint Moeilijk 57% en God 97% van de potjes (eerlijk zou 25% zijn).

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

## Illustraties en licenties

- `avatars/p*.webp`: Notionists door Zoish, via [DiceBear](https://www.dicebear.com) (CC0 1.0).
- `avatars/bot-*.webp`: Bottts door Pablo Stanley, via DiceBear (vrij voor persoonlijk en commercieel gebruik).
- `cards/*.jpg`: klassieke kaartfiguren uit [Vector Playing Cards](https://github.com/notpeter/Vector-Playing-Cards), oorspronkelijk van Byron Knoll (publiek domein).
- Lettertypes Fredoka en Nunito: SIL Open Font License.
