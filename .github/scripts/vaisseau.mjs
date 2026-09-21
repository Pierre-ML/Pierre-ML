/**
 * Génère l'animation « vaisseau » du profil : un chasseur balaie l'année de gauche à
 * droite sous le calendrier de contributions et tire sur chaque colonne qui porte des
 * commits. Les jours touchés explosent, puis tout se recompose et la passe recommence.
 *
 * Aucune dépendance : le calendrier vient de l'API GraphQL de GitHub, le reste est une
 * chaîne SVG. L'animation est en CSS et non en SMIL — c'est ce qui survit au proxy
 * d'images de GitHub (camo) quand le SVG est affiché par une balise <img>.
 *
 * Sortie : dist/vaisseau.svg
 */

import { mkdir, writeFile } from "node:fs/promises";

const LOGIN = process.env.GITHUB_LOGIN;
const TOKEN = process.env.GITHUB_TOKEN;

if (!LOGIN || !TOKEN) {
	console.error("GITHUB_LOGIN et GITHUB_TOKEN sont requis.");
	process.exit(1);
}

// ------------------------------------------------ palette

/* Reprise telle quelle de src/styles/global.css du portfolio : 60 % obsidian, 30 % crème,
   10 % carmin. Les cases suivent l'échelle de crème, le vaisseau et ses tirs le carmin —
   la cible est claire, l'arme est rouge. */
const OBSIDIAN = "#070605";
const BORDURE = "#26211C";
const CREAM = "#F7F2E8";
const CREAM_MUTED = "#C5BDAD";
const CREAM_DARK = "#8C8271";
const CRIMSON = "#9E1012";
const CRIMSON_SOMBRE = "#7A0C0D";

/** Échelle des cases, du jour vide au jour le plus fourni. */
const NIVEAUX = ["#1C1815", "#4A4438", CREAM_DARK, CREAM_MUTED, CREAM];

// ------------------------------------------------ géométrie

const CASE = 11;
const ECART = 3;
const PAS = CASE + ECART;

const MARGE = 18;
const COLONNE_JOURS = 30; // libellés Lun / Mer / Ven
const HAUTEUR_MOIS = 20;
const COULOIR = 42; // bande du vaisseau, sous la grille
const PIED = 22; // ligne de compte en bas

const GRILLE_X = MARGE + COLONNE_JOURS;
const GRILLE_Y = MARGE + HAUTEUR_MOIS;
const GRILLE_H = 7 * PAS - ECART;

// ------------------------------------------------ minutage

/** Durée d'une passe complète, en secondes. */
const DUREE = 30;
/** Part de la passe consacrée au balayage ; le reste sert à recomposer la grille. */
const FIN_BALAYAGE = 0.88;
/** Temps de montée d'un tir, en fraction de la passe. */
const DUREE_TIR = 0.012;

const MOIS = ["jan", "fév", "mar", "avr", "mai", "juin", "juil", "août", "sep", "oct", "nov", "déc"];

const pct = (f) => `${(f * 100).toFixed(3)}%`;

// ------------------------------------------------ données

async function calendrier(login) {
	const requete = `
		query($login: String!) {
			user(login: $login) {
				contributionsCollection {
					contributionCalendar {
						totalContributions
						weeks {
							contributionDays { date weekday contributionCount }
						}
					}
				}
			}
		}`;

	const reponse = await fetch("https://api.github.com/graphql", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${TOKEN}`,
			"Content-Type": "application/json",
			"User-Agent": "vaisseau-contributions",
		},
		body: JSON.stringify({ query: requete, variables: { login } }),
	});

	if (!reponse.ok) throw new Error(`GraphQL ${reponse.status} : ${await reponse.text()}`);

	const charge = await reponse.json();
	if (charge.errors) throw new Error(JSON.stringify(charge.errors));

	const cal = charge.data?.user?.contributionsCollection?.contributionCalendar;
	if (!cal) throw new Error(`Aucun calendrier pour « ${login} ».`);
	return cal;
}

/**
 * Le niveau d'une case (1 à 4) à partir de son nombre de commits. Les seuils sont calés
 * sur le maximum de l'année : sur un compte peu fourni, un seul commit doit déjà se voir,
 * sinon toute la grille reste au niveau 1 et le vaisseau tire dans le noir.
 */
function echelle(max) {
	const pas = Math.max(1, Math.ceil(max / 4));
	return (n) => (n <= 0 ? 0 : Math.min(4, Math.ceil(n / pas)));
}

// ------------------------------------------------ rendu

function construire(cal) {
	const semaines = cal.weeks;
	const colonnes = semaines.length;

	const max = Math.max(0, ...semaines.flatMap((s) => s.contributionDays.map((j) => j.contributionCount)));
	const niveau = echelle(max);

	const largeur = GRILLE_X + colonnes * PAS - ECART + MARGE;
	const hauteur = GRILLE_Y + GRILLE_H + COULOIR + PIED;

	// Hauteur de vol, puis la course du tir. Elle se mesure depuis le NEZ du projectile et
	// non depuis le centre du vaisseau : sinon l'impact est daté d'un demi-tir en retard, et
	// le trait s'arrête au-dessus des libellés de mois au lieu du bord de la grille.
	const VOL_Y = GRILLE_Y + GRILLE_H + 24;
	const HAUTEUR_TIR = 15;
	const NEZ = VOL_Y - 14;
	const CIBLE_HAUTE = GRILLE_Y - 3;
	const COURSE = NEZ - CIBLE_HAUTE;

	/** Déduplique les blocs de keyframes identiques : un nom par corps distinct. */
	const keyframes = new Map();
	const nommer = (corps) => {
		let nom = keyframes.get(corps);
		if (!nom) {
			nom = `k${keyframes.size.toString(36)}`;
			keyframes.set(corps, nom);
		}
		return nom;
	};

	const cases = [];
	const explosions = [];
	const tirs = [];
	let touches = 0;

	semaines.forEach((semaine, i) => {
		const x = GRILLE_X + i * PAS;
		// Instant où le vaisseau se trouve au-dessus de cette colonne.
		const t = colonnes > 1 ? (i / (colonnes - 1)) * FIN_BALAYAGE : 0;
		let colonneArmee = false;

		semaine.contributionDays.forEach((jour) => {
			const y = GRILLE_Y + jour.weekday * PAS;
			const n = niveau(jour.contributionCount);

			if (n === 0) {
				cases.push(`<rect x="${x}" y="${y}" width="${CASE}" height="${CASE}" rx="2" fill="${NIVEAUX[0]}"/>`);
				return;
			}

			colonneArmee = true;
			touches += 1;

			const couleur = NIVEAUX[n];
			// Le tir monte : la case du bas (samedi) est atteinte la première.
			const centre = y + CASE / 2;
			const impact = t + DUREE_TIR * ((NEZ - centre) / COURSE);

			const h = impact * 100;
			const avant = Math.max(0, h - 0.05);
			const eclat = Math.min(99, h + 0.55);
			const mort = Math.min(99.5, h + 2.2);

			const kCase = nommer(
				`0%,${avant.toFixed(3)}%{opacity:1;fill:${couleur};transform:scale(1)}` +
					`${h.toFixed(3)}%{opacity:1;fill:${CREAM};transform:scale(1.6)}` +
					`${eclat.toFixed(3)}%{opacity:.9;fill:${CRIMSON};transform:scale(1.15)}` +
					`${mort.toFixed(3)}%{opacity:.16;fill:${NIVEAUX[0]};transform:scale(1)}` +
					`96%{opacity:.16;fill:${NIVEAUX[0]}}` +
					`100%{opacity:1;fill:${couleur}}`,
			);

			const kBoum = nommer(
				`0%,${h.toFixed(3)}%{opacity:0;transform:scale(.1)}` +
					`${Math.min(99, h + 0.12).toFixed(3)}%{opacity:.95;transform:scale(.5)}` +
					`${Math.min(99.5, h + 1.9).toFixed(3)}%{opacity:0;transform:scale(2)}` +
					`100%{opacity:0;transform:scale(2)}`,
			);

			cases.push(
				`<rect class="v ${kCase}" x="${x}" y="${y}" width="${CASE}" height="${CASE}" rx="2" fill="${couleur}"/>`,
			);
			explosions.push(
				`<circle class="v ${kBoum}" cx="${(x + CASE / 2).toFixed(1)}" cy="${centre.toFixed(1)}" r="7" fill="none" stroke="${CRIMSON}" stroke-width="1.6"/>`,
			);
		});

		if (!colonneArmee) return;

		// Un seul trait par colonne : il traverse toute la hauteur et allume au passage
		// chaque jour travaillé. Un projectile par case aurait triplé le poids du fichier.
		const p = t * 100;
		const kTir = nommer(
			`0%,${p.toFixed(3)}%{opacity:0;transform:translateY(0)}` +
				`${Math.min(99, p + 0.06).toFixed(3)}%{opacity:1;transform:translateY(-2px)}` +
				`${Math.min(99.4, (t + DUREE_TIR) * 100).toFixed(3)}%{opacity:1;transform:translateY(-${COURSE.toFixed(1)}px)}` +
				`${Math.min(99.6, (t + DUREE_TIR) * 100 + 0.25).toFixed(3)}%{opacity:0;transform:translateY(-${COURSE.toFixed(1)}px)}` +
				`100%{opacity:0}`,
		);

		tirs.push(
			`<rect class="v ${kTir}" x="${(x + CASE / 2 - 1).toFixed(1)}" y="${NEZ}" width="2" height="${HAUTEUR_TIR}" rx="1" fill="${CRIMSON}"/>`,
		);
	});

	// ---------------- vaisseau

	const xDepart = GRILLE_X + CASE / 2;
	const xArrivee = GRILLE_X + (colonnes - 1) * PAS + CASE / 2;

	// Il entre par la gauche, balaie l'année, sort par la droite, et revient hors cadre
	// pendant que la grille se recompose : le saut de position ne se voit jamais.
	// Keyframe nommée à part de la table de déduplication : le vaisseau est seul de son
	// espèce, et sa règle CSS a besoin d'un sélecteur stable pour caler son repère.
	const volKeyframes =
		`@keyframes vol{` +
		`0%{transform:translateX(-40px)}` +
		`1.5%{transform:translateX(${xDepart.toFixed(1)}px)}` +
		`${(FIN_BALAYAGE * 100).toFixed(1)}%{transform:translateX(${xArrivee.toFixed(1)}px)}` +
		`94%{transform:translateX(${(largeur + 40).toFixed(1)}px)}` +
		`94.01%,100%{transform:translateX(-40px)}}`;

	// Silhouette de chasseur, nez vers le haut, dessinée autour de (0,0).
	const coque = `M0,-11 L4,-3 L11,3 L11,8 L4,5 L3,9 L-3,9 L-4,5 L-11,8 L-11,3 L-4,-3 Z`;

	const vaisseau = `
		<g class="v vol">
			<g transform="translate(0 ${VOL_Y})">
				<path class="flamme" d="M-3,9 L0,20 L3,9 Z" fill="${CRIMSON}"/>
				<path d="${coque}" fill="${CRIMSON_SOMBRE}" stroke="${CRIMSON}" stroke-width="1.2" stroke-linejoin="round"/>
				<circle cx="0" cy="0" r="2.4" fill="${CREAM}"/>
			</g>
		</g>`;

	// ---------------- repères

	const libellesMois = [];
	let dernierMois = -1;
	semaines.forEach((semaine, i) => {
		const premier = semaine.contributionDays[0];
		if (!premier) return;
		const d = new Date(`${premier.date}T00:00:00Z`);
		const m = d.getUTCMonth();
		// Le libellé n'est posé que si le mois dispose d'assez de colonnes pour le porter.
		if (m === dernierMois || d.getUTCDate() > 7 || i > colonnes - 3) return;
		dernierMois = m;
		libellesMois.push(
			`<text x="${GRILLE_X + i * PAS}" y="${GRILLE_Y - 8}" class="hud">${MOIS[m]}</text>`,
		);
	});

	const libellesJours = [
		[1, "lun"],
		[3, "mer"],
		[5, "ven"],
	].map(
		([r, nom]) =>
			`<text x="${GRILLE_X - 9}" y="${GRILLE_Y + r * PAS + CASE - 1.5}" class="hud" text-anchor="end">${nom}</text>`,
	);

	const compte =
		`<text x="${GRILLE_X}" y="${hauteur - 8}" class="hud">` +
		`${cal.totalContributions} contributions · ${touches} jours dans le viseur</text>`;

	const signature = `<text x="${largeur - MARGE}" y="${hauteur - 8}" class="hud" text-anchor="end">${LOGIN}</text>`;

	// ---------------- assemblage

	const styles =
		`.v{animation-duration:${DUREE}s;animation-timing-function:linear;animation-iteration-count:infinite;` +
		`transform-box:fill-box;transform-origin:center}` +
		`.hud{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:9px;` +
		`letter-spacing:.12em;text-transform:uppercase;fill:${CREAM_DARK}}` +
		`.flamme{transform-box:fill-box;transform-origin:top center;animation:reacteur .18s steps(2,end) infinite}` +
		`@keyframes reacteur{0%{opacity:.35;transform:scaleY(.55)}100%{opacity:.9;transform:scaleY(1.1)}}` +
		// Le vaisseau se déplace dans le repère du calque, pas dans sa propre boîte : sans
		// ce `view-box`, `translateX` partirait du centre de la silhouette et le balayage
		// se ferait sur quelques pixels au lieu de toute la largeur.
		`.vol{transform-box:view-box;transform-origin:0 0;animation-name:vol}` +
		volKeyframes +
		[...keyframes].map(([corps, nom]) => `@keyframes ${nom}{${corps}}`).join("") +
		[...keyframes].map(([, nom]) => `.${nom}{animation-name:${nom}}`).join("");

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${largeur}" height="${hauteur}" viewBox="0 0 ${largeur} ${hauteur}" role="img" aria-label="Un vaisseau balaie le calendrier de contributions de ${LOGIN} et tire sur les jours travaillés">
<style>${styles}</style>
<rect width="${largeur}" height="${hauteur}" rx="10" fill="${OBSIDIAN}"/>
<rect x=".5" y=".5" width="${largeur - 1}" height="${hauteur - 1}" rx="10" fill="none" stroke="${BORDURE}"/>
<g>${libellesMois.join("")}${libellesJours.join("")}</g>
<g>${cases.join("")}</g>
<g>${tirs.join("")}</g>
<g>${explosions.join("")}</g>
${vaisseau}
<g>${compte}${signature}</g>
</svg>`;
}

// ------------------------------------------------ exécution

const cal = await calendrier(LOGIN);
const svg = construire(cal);

await mkdir("dist", { recursive: true });
await writeFile("dist/vaisseau.svg", svg, "utf8");

console.log(`dist/vaisseau.svg écrit — ${cal.totalContributions} contributions, ${(svg.length / 1024).toFixed(1)} Ko`);
