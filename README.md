# The McKeehan Family website

An interactive family tree built from a GEDCOM file. Pan and zoom the whole
tree, open anyone's page, explore the ancestor fan chart and migration map,
and read the stories ("connections") that tie the branches together.

The output is a folder of plain static files, so it can be hosted anywhere
(GitHub Pages, Cloudflare Pages, Netlify, any web server).

## Build

```
npm install
node build/build.mjs            # reads the first GEDCOM listed in site.config.json
node build/build.mjs --gedcom path/to/other.ged --out dist
```

Output goes to `dist/`:

- `index.html`, `app.js`, `styles.css`, `vendor/d3.min.js`: the site
- `data/family.json`: people, families, layout, places and stories
- `data/map.json`: country and US state outlines for the maps
- `media/`: photos referenced by the GEDCOM (OBJE FILE paths) or `content/portraits.json`,
  with `media/thumbs/` (480px copies) and `media/portraits/` (face crops for tree cards)
- `preview.html`: the same page with CSS and script inlined, for hosts that wrap pages

Open it with any static server, for example `npx serve dist`.

## Where the content comes from

| What | Where |
|---|---|
| People, families, events, notes, sources, photos | the GEDCOM (`/mnt/project-files/tree/mckeehan.ged`, maintained by the research work) |
| Place coordinates | `PLAC` → `MAP LATI/LONG` in the GEDCOM; `content/places.json` fills gaps |
| Stories ("connections") | Markdown files in `content/stories/` and `<gedcom folder>/stories/` |
| Face crops for the round portraits on tree cards | `content/portraits.json` |
| Title, starting person, privacy | `site.config.json` |

### Writing a story

Create `content/stories/my-story.md`:

```
---
title: The train west, 1898
era: 1864 – 1949
order: 4
summary: One or two sentences for the story card.
route:
  - Johnson City, Washington County, Tennessee, USA | 1864 | Samuel born
  - Pullman, Whitman County, Washington, USA | 1898 | The family arrives
---
Text in Markdown. Link people with [[Samuel Rosencrans McKeehan (1864)|Samuel]]:
name as in the tree, optional birth year to tell people apart, optional link text.
```

Route places use the same names as the GEDCOM so they land on the map.

### Portraits on tree cards

Each person's card shows a round portrait cut from a photo. Add an entry to
`content/portraits.json` to choose which photo and where the face is:

```
{ "person": "Ben LeRoy McKeehan (1897)", "file": "media/ben_mckeehan_wwi.jpg",
  "title": "Ben McKeehan in his World War I uniform", "face": [0.47, 0.125], "size": 0.3 }
```

`face` is the centre of the face as fractions of the photo's width and height,
and `size` is the side of the square crop as a fraction of the width. That lets
one couple or group photo give each person in it their own portrait. A photo
named here is also added to that person's photos. Without an entry, a person
gets an automatic crop only when a photo is linked to them alone.

## Privacy

- Anyone with `RESN privacy`/`confidential`, or with no death record and born
  (or estimated born) within the last 100 years, counts as living.
- `privacy.living` sets how a living person's name appears: `hidden`, `given`
  (first name only) or `full`. `privacy.livingDetails` is `year` (birth year
  and birthplace), `birth` (full birth date and birthplace) or `none`. Living people never get other events, notes, photos,
  portraits or sources.
- `privacy.showDescendantsOfRoot` and `privacy.showLivingCollaterals` include the
  starting person's descendants and living cousins; when they are off, cards show
  "+N" where living relatives were left out.
- Current settings (chosen by the family, November 2026): full names with birth
  year and birthplace, descendants and cousins included. Full birth dates of
  living people are never written to the output.
- Notes and source titles are published as written, so keep living people's
  names out of them.

## Publishing and the custom domain

The built `dist/` folder (without `preview.html`) is published to the
`gh-pages` branch as a single commit, replacing the branch each time so old
builds do not stay in its history. GitHub Pages serves that branch.

To serve the site at its own domain (for example `mckeehanfamily.org`):

1. At the domain's DNS provider, add these records (turn off any proxying,
   such as Cloudflare's orange cloud, so GitHub can issue the certificate):

   | Type | Name | Value |
   |---|---|---|
   | A | `@` | `185.199.108.153` |
   | A | `@` | `185.199.109.153` |
   | A | `@` | `185.199.110.153` |
   | A | `@` | `185.199.111.153` |
   | AAAA | `@` | `2606:50c0:8000::153` |
   | AAAA | `@` | `2606:50c0:8001::153` |
   | AAAA | `@` | `2606:50c0:8002::153` |
   | AAAA | `@` | `2606:50c0:8003::153` |
   | CNAME | `www` | `alekxos.github.io` |

2. Set `customDomain` in `site.config.json`, rebuild and publish. The build
   writes `dist/CNAME`, which tells GitHub Pages the domain. Do this only after
   the DNS records exist, because the github.io address starts redirecting to
   the domain as soon as the file is published.
3. In the repository's Settings, Pages, tick "Enforce HTTPS" once GitHub has
   issued the certificate (usually within an hour).

Optional but recommended: verify the domain under your GitHub account's
Settings, Pages, so no other GitHub repository can claim it.

All paths in the site are relative, so it works at a domain root or under a
sub-path such as `/mckeehan_family/`.

## RootsMagic bootstrap

`tools/rmtree-to-gedcom.py` converts a RootsMagic `.rmtree` file to GEDCOM,
for building the site straight from RootsMagic:

```
python3 tools/rmtree-to-gedcom.py tree.rmtree content/bootstrap/from-rootsmagic.ged --merge 125=123,126=124
```
