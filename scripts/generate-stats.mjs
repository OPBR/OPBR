#!/usr/bin/env node
/**
 * 从 GitHub GraphQL API 拉取数据，生成自托管的统计 SVG。
 *
 * 为什么不用 github-readme-stats 之类的现成卡片：
 *   *.vercel.app 在部分网络下不可达，且 GitHub 的 camo 图片代理也抓不到，
 *   结果就是主页上挂一排裂图。自托管 SVG 提交进仓库后没有任何外部依赖。
 *
 * 用法：
 *   GITHUB_TOKEN=$(gh auth token) node scripts/generate-stats.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const USER = process.env.GITHUB_USERNAME || 'OPBR'
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN

if (!TOKEN) {
  console.error('缺少 GITHUB_TOKEN 环境变量。本地可这样跑：')
  console.error('  GITHUB_TOKEN=$(gh auth token) node scripts/generate-stats.mjs')
  process.exit(1)
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ASSETS = resolve(ROOT, 'assets')

// ── 与 banner.svg 保持一致的配色 ──────────────────────────────
const THEME = {
  bgFrom: '#0c1230',
  bgTo: '#070b18',
  border: '#ffffff',
  text: '#e2e8f0',
  muted: '#8b9dc3',
  indigo: '#6366f1',
  cyan: '#22d3ee',
  violet: '#a855f7',
}
const FONT =
  "ui-sans-serif, -apple-system, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', Helvetica, Arial, sans-serif"

// 语言没有官方色时的兜底调色板
const FALLBACK_COLORS = [
  '#6366f1', '#22d3ee', '#a855f7', '#f472b6',
  '#34d399', '#fbbf24', '#fb7185', '#38bdf8',
]

const QUERY = `
query($login: String!) {
  user(login: $login) {
    name
    followers { totalCount }
    repositories(privacy: PUBLIC, isFork: false, first: 100, ownerAffiliations: OWNER) {
      totalCount
      nodes {
        stargazerCount
        languages(first: 10, orderBy: {field: SIZE, direction: DESC}) {
          edges { size node { name color } }
        }
      }
    }
    contributionsCollection {
      contributionCalendar { totalContributions }
    }
  }
}`

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c],
  )
const fmt = (n) => n.toLocaleString('en-US')

async function fetchStats() {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': `${USER}-profile-readme`,
    },
    body: JSON.stringify({ query: QUERY, variables: { login: USER } }),
  })

  if (!res.ok) {
    throw new Error(`GraphQL 请求失败: ${res.status} ${await res.text()}`)
  }

  const json = await res.json()
  if (json.errors) {
    throw new Error(`GraphQL 返回错误: ${JSON.stringify(json.errors)}`)
  }

  const user = json.data.user
  const repos = user.repositories.nodes

  // 按字节数聚合语言占比
  const byLang = new Map()
  for (const repo of repos) {
    for (const { size, node } of repo.languages.edges) {
      const prev = byLang.get(node.name) ?? { size: 0, color: node.color }
      prev.size += size
      if (!prev.color && node.color) prev.color = node.color
      byLang.set(node.name, prev)
    }
  }

  const totalBytes = [...byLang.values()].reduce((a, b) => a + b.size, 0) || 1
  const languages = [...byLang.entries()]
    .map(([name, v], i) => ({
      name,
      bytes: v.size,
      pct: (v.size / totalBytes) * 100,
      color: v.color || FALLBACK_COLORS[i % FALLBACK_COLORS.length],
    }))
    .sort((a, b) => b.bytes - a.bytes)

  return {
    login: user.name || USER,
    followers: user.followers.totalCount,
    repos: user.repositories.totalCount,
    stars: repos.reduce((a, r) => a + r.stargazerCount, 0),
    contributions: user.contributionsCollection.contributionCalendar.totalContributions,
    languages,
  }
}

// ── 卡片外框（两张图共用） ────────────────────────────────────
function frame(w, h, id, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="${id}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="${w}" y2="${h}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${THEME.bgFrom}"/>
      <stop offset="1" stop-color="${THEME.bgTo}"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${THEME.indigo}"/>
      <stop offset="1" stop-color="${THEME.cyan}"/>
    </linearGradient>
  </defs>
  <rect width="${w}" height="${h}" rx="14" fill="url(#bg)"/>
  <rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="14" fill="none" stroke="${THEME.border}" stroke-opacity="0.09"/>
  <g font-family="${esc(FONT)}">${body}</g>
</svg>
`
}

// ── 统计卡片：四个数字块 ──────────────────────────────────────
function renderStats(d) {
  const w = 880
  const h = 168
  const tiles = [
    { label: 'TOTAL STARS', sub: '获得 Star', value: d.stars },
    { label: 'REPOSITORIES', sub: '自有仓库', value: d.repos },
    { label: 'FOLLOWERS', sub: '关注者', value: d.followers },
    { label: 'CONTRIBUTIONS', sub: '年度贡献', value: d.contributions },
  ]

  const pad = 34
  const gap = 18
  const tileW = (w - pad * 2 - gap * (tiles.length - 1)) / tiles.length

  const body = tiles
    .map((t, i) => {
      const x = pad + i * (tileW + gap)
      return `
    <g>
      <rect x="${x}" y="30" width="${tileW}" height="${h - 60}" rx="10" fill="#ffffff" fill-opacity="0.035" stroke="#ffffff" stroke-opacity="0.06"/>
      <rect x="${x}" y="30" width="${tileW}" height="2.5" rx="1.25" fill="url(#accent)" opacity="0.85"/>
      <text x="${x + tileW / 2}" y="76" text-anchor="middle" font-size="36" font-weight="800" fill="${THEME.text}">${esc(fmt(t.value))}</text>
      <text x="${x + tileW / 2}" y="102" text-anchor="middle" font-size="11.5" font-weight="700" letter-spacing="1.4" fill="${THEME.indigo}">${esc(t.label)}</text>
      <text x="${x + tileW / 2}" y="122" text-anchor="middle" font-size="13" fill="${THEME.muted}">${esc(t.sub)}</text>
    </g>`
    })
    .join('')

  return frame(w, h, 'statsTitle', body)
}

// ── 语言分布：环形图 + 图例 ──────────────────────────────────
function renderLangs(d) {
  const w = 880
  const h = 240
  const cx = 138
  const cy = h / 2
  const r = 66
  const stroke = 26
  const C = 2 * Math.PI * r

  const top = d.languages.slice(0, 7)
  const restPct = d.languages.slice(7).reduce((a, l) => a + l.pct, 0)
  const segs = restPct > 0.5
    ? [...top, { name: 'Other', pct: restPct, color: '#475569' }]
    : top

  let offset = 0
  const arcs = segs
    .map((l) => {
      const len = (l.pct / 100) * C
      // stroke-dashoffset 为负值即顺时针推进起点
      const el = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${l.color}" stroke-width="${stroke}"
        stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}"
        transform="rotate(-90 ${cx} ${cy})"/>`
      offset += len
      return el
    })
    .join('\n    ')

  const body = `
    <text x="34" y="34" font-size="12" font-weight="700" letter-spacing="1.4" fill="${THEME.muted}">语言分布 · LANGUAGES</text>
    <g>
      ${arcs}
      <text x="${cx}" y="${cy - 4}" text-anchor="middle" font-size="26" font-weight="800" fill="${THEME.text}">${esc(String(d.languages.length))}</text>
      <text x="${cx}" y="${cy + 18}" text-anchor="middle" font-size="11" fill="${THEME.muted}">种语言</text>
    </g>
    ${segs
      .map((l, i) => {
        const col = i < 4 ? 0 : 1
        const row = i % 4
        const x = 320 + col * 280
        const y = 78 + row * 40
        return `<g>
      <rect x="${x}" y="${y - 11}" width="12" height="12" rx="3" fill="${l.color}"/>
      <text x="${x + 22}" y="${y}" font-size="14.5" font-weight="600" fill="${THEME.text}">${esc(l.name)}</text>
      <text x="${x + 230}" y="${y}" text-anchor="end" font-size="14.5" font-weight="700" fill="${THEME.muted}">${l.pct.toFixed(1)}%</text>
    </g>`
      })
      .join('')}`

  return frame(w, h, 'langsTitle', body)
}

// ── 主流程 ───────────────────────────────────────────────────
const data = await fetchStats()
mkdirSync(ASSETS, { recursive: true })
writeFileSync(resolve(ASSETS, 'stats.svg'), renderStats(data), 'utf8')
writeFileSync(resolve(ASSETS, 'langs.svg'), renderLangs(data), 'utf8')

console.log(`OK  ${data.login}`)
console.log(`    stars=${data.stars} repos=${data.repos} followers=${data.followers} contributions=${data.contributions}`)
console.log(`    languages=${data.languages.length} -> ${data.languages.slice(0, 5).map((l) => `${l.name} ${l.pct.toFixed(1)}%`).join(', ')}`)
