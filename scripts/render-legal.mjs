#!/usr/bin/env node
/**
 * Render the legal documents from Markdown into the site.
 *
 *   node scripts/render-legal.mjs
 *
 * `docs/legal/*.md` is the SOURCE. `site/terms.html` and `site/privacy.html`
 * are generated and committed — committed because the site deploy publishes
 * `site/` as static files and has no build step, and generated because two
 * copies of a legal document that can disagree is precisely the failure mode
 * to avoid. Edit the Markdown, re-run this, commit both.
 *
 * The converter handles only what these documents use — headings, paragraphs,
 * bullet lists, tables, blockquotes, rules, and inline bold/code/links. It is
 * deliberately not a general Markdown implementation: anything it does not
 * recognise should fail visibly in review rather than silently render wrong.
 *
 * No JavaScript, no external requests, local fonts only — the same promise the
 * landing page makes, and these pages are where it would be most galling to
 * break it.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Inline: `code`, **bold**, *em*, [text](href), bare emails. */
function inline(s) {
  let out = esc(s)
  out = out.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, h) => {
    // Relative links between the two documents point at the published pages.
    const href = h.replace(/^\.\/privacy-policy\.md$/, '/privacy').replace(/^\.\/terms-of-service\.md$/, '/terms')
    return `<a href="${href}">${t}</a>`
  })
  out = out.replace(/(^|\s)([\w.+-]+@[\w.-]+\.\w+)/g, '$1<a href="mailto:$2">$2</a>')
  return out
}

function render(md) {
  const lines = md.split('\n')
  const html = []
  let i = 0
  let para = []

  const flushPara = () => {
    if (para.length) {
      html.push(`<p>${inline(para.join(' '))}</p>`)
      para = []
    }
  }

  while (i < lines.length) {
    const line = lines[i]

    if (!line.trim()) { flushPara(); i++; continue }

    if (line.startsWith('# ')) { flushPara(); html.push(`<h1>${inline(line.slice(2))}</h1>`); i++; continue }
    if (line.startsWith('## ')) { flushPara(); html.push(`<h2>${inline(line.slice(3))}</h2>`); i++; continue }
    if (line.startsWith('### ')) { flushPara(); html.push(`<h3>${inline(line.slice(4))}</h3>`); i++; continue }
    if (/^---+$/.test(line.trim())) { flushPara(); html.push('<hr/>'); i++; continue }

    // Blockquote — used for the data-loss warning, which is the one passage
    // that must not read like the rest of the page.
    if (line.startsWith('> ')) {
      flushPara()
      const buf = []
      while (i < lines.length && lines[i].startsWith('>')) {
        buf.push(lines[i].replace(/^>\s?/, ''))
        i++
      }
      html.push(`<blockquote><p>${inline(buf.join(' '))}</p></blockquote>`)
      continue
    }

    // Table
    if (line.startsWith('|')) {
      flushPara()
      const rows = []
      while (i < lines.length && lines[i].startsWith('|')) {
        rows.push(lines[i])
        i++
      }
      const cells = r => r.split('|').slice(1, -1).map(c => c.trim())
      const head = cells(rows[0])
      const body = rows.slice(2).map(cells) // row 1 is the |---| separator
      html.push(
        `<div class="tablewrap"><table><thead><tr>${head
          .map(h => `<th>${inline(h)}</th>`)
          .join('')}</tr></thead><tbody>${body
          .map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table></div>`,
      )
      continue
    }

    // Bullet list, with continuation lines folded into their item.
    if (line.startsWith('- ')) {
      flushPara()
      const items = []
      while (i < lines.length && (lines[i].startsWith('- ') || /^\s{2,}\S/.test(lines[i]))) {
        if (lines[i].startsWith('- ')) items.push(lines[i].slice(2))
        else items[items.length - 1] += ' ' + lines[i].trim()
        i++
      }
      html.push(`<ul>${items.map(t => `<li>${inline(t)}</li>`).join('')}</ul>`)
      continue
    }

    para.push(line.trim())
    i++
  }
  flushPara()
  return html.join('\n')
}

const SHELL = (title, body) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} — TideWork</title>
<meta name="description" content="${title} for TideWork, the end-to-end encrypted collaborative workspace." />
<link rel="stylesheet" href="/fonts/fonts.css" />
<style>
  :root {
    --abyss:#03101c; --deep:#062338; --foam:#eaf6f6; --mist:#9fc3cd; --faint:#5c8292;
    --spray:#67e2d4; --buoy:#ff9e57; --line:rgba(154,203,212,0.16);
    --serif:'Fraunces', Georgia, serif; --sans:'IBM Plex Sans', system-ui, sans-serif;
    --mono:'IBM Plex Mono', ui-monospace, monospace;
  }
  * { margin:0; box-sizing:border-box; }
  body {
    font-family:var(--sans); color:var(--mist); line-height:1.7;
    background: radial-gradient(120% 60% at 70% -20%, #11597d 0%, transparent 55%), var(--abyss);
    background-color:var(--abyss); padding-bottom:80px;
  }
  ::selection { background:var(--spray); color:var(--abyss); }
  .wrap { max-width:760px; margin:0 auto; padding:0 24px; }
  header { border-bottom:1px solid var(--line); padding:18px 0; margin-bottom:48px; }
  header .wrap { display:flex; align-items:center; gap:18px; }
  .brand { color:var(--foam); text-decoration:none; font-weight:600; letter-spacing:-0.01em; }
  header a { color:var(--mist); text-decoration:none; font-size:14px; }
  header a:hover { color:var(--foam); }
  h1 { font-family:var(--serif); font-size:34px; line-height:1.2; color:var(--foam); margin-bottom:8px; letter-spacing:-0.01em; }
  h2 { font-family:var(--serif); font-size:22px; color:var(--foam); margin:40px 0 12px; }
  h3 { font-size:15px; color:var(--foam); margin:26px 0 8px; }
  p, li { font-size:15px; }
  p { margin:14px 0; }
  ul { margin:14px 0 14px 20px; }
  li { margin:7px 0; }
  a { color:var(--spray); }
  strong { color:var(--foam); }
  code { font-family:var(--mono); font-size:13px; background:rgba(154,203,212,0.10); padding:1px 5px; border-radius:4px; }
  hr { border:none; border-top:1px solid var(--line); margin:36px 0; }
  blockquote {
    margin:22px 0; padding:16px 20px; border-left:2px solid var(--buoy);
    background:rgba(255,158,87,0.07); border-radius:0 8px 8px 0;
  }
  blockquote p { margin:0; color:var(--foam); }
  .tablewrap { overflow-x:auto; margin:18px 0; }
  table { border-collapse:collapse; width:100%; font-size:14px; }
  th, td { text-align:left; padding:9px 12px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--foam); font-weight:600; font-size:13px; }
  footer { margin-top:64px; padding-top:22px; border-top:1px solid var(--line); font-size:13px; color:var(--faint); }
  footer a { color:var(--mist); text-decoration:none; }
  footer a:hover { color:var(--foam); }
  @media (max-width:600px) {
    h1 { font-size:27px; }
    h2 { font-size:19px; }
    header { margin-bottom:32px; }
  }
</style>
</head>
<body>
<header>
  <div class="wrap">
    <a class="brand" href="/">TideWork</a>
    <a href="/terms">Terms</a>
    <a href="/privacy">Privacy</a>
    <a href="https://app.tidework.io">Open app</a>
  </div>
</header>
<main class="wrap">
${body}
<footer>
  <p>© 2026 TideWork · <a href="/">tidework.io</a> · <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a> · <a href="mailto:tideworksupport@proton.me">Contact</a></p>
</footer>
</main>
</body>
</html>
`

const pages = [
  ['docs/legal/terms-of-service.md', 'site/terms.html', 'Terms of Service'],
  ['docs/legal/privacy-policy.md', 'site/privacy.html', 'Privacy Policy'],
]

for (const [src, dest, title] of pages) {
  const md = readFileSync(join(root, src), 'utf8')
  writeFileSync(join(root, dest), SHELL(title, render(md)), 'utf8')
  console.log(`rendered ${src} -> ${dest}`)
}
