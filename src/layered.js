// Layered layout for flowcharts. Ranks by network simplex, dummy nodes on long edges and at edge labels,
// barycenter sweeps that keep each subgraph contiguous, x by network simplex on graphviz's auxiliary graph,
// and edges as polylines through their dummies. It lays out top to bottom; the other directions transpose
// or mirror the result.

/** The values minimizing Σ weight × (rank[to] - rank[from]) with each edge at least `len` long, by network
 * simplex with graphviz's incremental updates, for an acyclic graph whose edges join a pair of nodes at most
 * once. Lengths are integers, so slack compares exactly. A disconnected part keeps its longest-path start. */
function simplex(n, from, to, len, weight) {
  const m = from.length, rank = new Float64Array(n)
  const start = new Int32Array(n + 1)
  for (let e = 0; e < m; e++) start[from[e] + 1]++, start[to[e] + 1]++
  for (let i = 0; i < n; i++) start[i + 1] += start[i]
  const adj = new Int32Array(2 * m), fill = start.slice(0, n)
  for (let e = 0; e < m; e++) adj[fill[from[e]]++] = e, adj[fill[to[e]]++] = e
  const slack = e => rank[to[e]] - rank[from[e]] - len[e]
  // Longest path from the sources, in topological order: a feasible start.
  const indeg = new Int32Array(n), stack = new Int32Array(n)
  for (let e = 0; e < m; e++) indeg[to[e]]++
  let qn = 0
  for (let v = 0; v < n; v++) if (!indeg[v]) stack[qn++] = v
  for (let qi = 0; qi < qn; qi++) {
    const u = stack[qi]
    for (let i = start[u]; i < start[u + 1]; i++) {
      const e = adj[i], v = to[e]
      if (from[e] !== u) continue
      if (rank[u] + len[e] > rank[v]) rank[v] = rank[u] + len[e]
      if (--indeg[v] === 0) stack[qn++] = v
    }
  }
  // Each source moves to just short of its nearest successor, so one of its edges starts tight.
  const fed = new Uint8Array(n)
  for (let e = 0; e < m; e++) fed[to[e]] = 1
  for (let v = 0; v < n; v++) {
    if (fed[v] || start[v] === start[v + 1]) continue
    let least = Infinity
    for (let i = start[v]; i < start[v + 1]; i++) least = Math.min(least, rank[to[adj[i]]] - len[adj[i]])
    rank[v] = least
  }
  // A tight spanning tree, grown from node 0, shifting the tree onto the nearest node outside it.
  const inTree = new Uint8Array(n), tree = new Uint8Array(m), list = new Int32Array(Math.max(1, n - 1)), at = new Int32Array(m).fill(-1)
  let size = 1, edges = 0
  inTree[0] = 1
  const join = e => { tree[e] = 1; at[e] = edges; list[edges++] = e }
  const grow = s => {
    let sp = 0
    stack[sp++] = s
    while (sp) {
      const x = stack[--sp]
      for (let i = start[x]; i < start[x + 1]; i++) {
        const e = adj[i], y = from[e] === x ? to[e] : from[e]
        if (!inTree[y] && slack(e) === 0) inTree[y] = 1, join(e), size++, (stack[sp++] = y)
      }
    }
  }
  grow(0)
  while (size < n) {
    let best = -1, least = Infinity
    for (let e = 0; e < m; e++) if (inTree[from[e]] !== inTree[to[e]] && slack(e) < least) least = slack(e), (best = e)
    if (best < 0) return rank
    const delta = inTree[from[best]] ? least : -least
    for (let v = 0; v < n; v++) if (inTree[v]) rank[v] += delta
    const y = inTree[from[best]] ? to[best] : from[best]
    inTree[y] = 1
    join(best)
    size++
    grow(y)
  }
  // Postorder numbers: x's subtree holds the nodes whose lim is in low[x]..lim[x]; up[x] is its tree edge
  // to its parent.
  const low = new Int32Array(n), lim = new Int32Array(n), up = new Int32Array(n), next = new Int32Array(n)
  const post = new Int32Array(n), cut = new Float64Array(m)
  const range = (root, parent, first) => {
    let sp = 0, number = first, k = 0
    up[root] = parent
    low[root] = first
    next[root] = start[root]
    stack[sp++] = root
    while (sp) {
      const x = stack[sp - 1]
      let e = -1
      while (next[x] < start[x + 1]) {
        const f = adj[next[x]++]
        if (tree[f] && f !== up[x]) { e = f; break }
      }
      if (e < 0) { lim[x] = number++; post[k++] = x; sp--; continue }
      const y = from[e] === x ? to[e] : from[e]
      up[y] = e
      low[y] = number
      next[y] = start[y]
      stack[sp++] = y
    }
  }
  const inside = (x, root) => low[root] <= lim[x] && lim[x] <= lim[root]
  range(0, -1, 1)
  // A tree edge's cut value: the weight of the edges crossing from its tail's side to its head's side, less
  // those crossing back. Children before parents, so each reuses the cut values below it.
  for (let k = 0; k < n; k++) {
    const child = post[k], e = up[child]
    if (e < 0) continue
    const tail = from[e] === child, parent = tail ? to[e] : from[e]
    let cv = weight[e]
    for (let i = start[child]; i < start[child + 1]; i++) {
      const f = adj[i], out = from[f] === child, other = out ? to[f] : from[f]
      if (other === parent) continue
      const head = out === tail
      cv += head ? weight[f] : -weight[f]
      if (tree[f]) cv += head ? -cut[f] : cut[f]
    }
    cut[e] = cv
  }
  let scan = 0
  for (let iter = 0, cap = 4 * n + 100; iter < cap; iter++) {
    // Leave: the most negative cut value among the next few negative ones.
    let leave = -1, found = 0
    for (let k = 0; k < edges && found < 30; k++) {
      const e = list[(scan + k) % edges]
      if (cut[e] < 0) {
        if (leave < 0 || cut[e] < cut[leave]) leave = e
        if (++found === 1) scan = (scan + k) % edges
      }
    }
    if (leave < 0) break
    // Enter: the tightest edge from the leaving edge's head side to its tail side, searched from whichever
    // side is the subtree below it.
    const sub = lim[from[leave]] < lim[to[leave]] ? from[leave] : to[leave], out = sub === to[leave]
    let enter = -1, least = Infinity, sp = 0
    stack[sp++] = sub
    while (sp) {
      const x = stack[--sp]
      for (let i = start[x]; i < start[x + 1]; i++) {
        const f = adj[i]
        if (tree[f]) {
          const y = from[f] === x ? to[f] : from[f]
          if (lim[y] < lim[x]) stack[sp++] = y
        } else if (out ? from[f] === x && !inside(to[f], sub) : to[f] === x && !inside(from[f], sub)) {
          const s = slack(f)
          if (s < least) least = s, (enter = f)
        }
      }
    }
    if (enter < 0) break
    // Shift the subtree so the entering edge is tight, fix the cut values on the cycle it closes, swap.
    if (least > 0) {
      const d = sub === from[leave] ? -least : least
      sp = 0
      stack[sp++] = sub
      while (sp) {
        const x = stack[--sp]
        rank[x] += d
        for (let i = start[x]; i < start[x + 1]; i++) {
          const f = adj[i]
          if (!tree[f]) continue
          const y = from[f] === x ? to[f] : from[f]
          if (lim[y] < lim[x]) stack[sp++] = y
        }
      }
    }
    const cv = cut[leave]
    const climb = (v, w, dir) => {
      while (!inside(w, v)) {
        const e = up[v]
        cut[e] += (v === from[e]) === dir ? cv : -cv
        v = lim[from[e]] > lim[to[e]] ? from[e] : to[e]
      }
      return v
    }
    const lca = climb(from[enter], to[enter], true)
    climb(to[enter], from[enter], false)
    cut[enter] = -cv
    cut[leave] = 0
    tree[leave] = 0
    tree[enter] = 1
    list[at[leave]] = enter
    at[enter] = at[leave]
    at[leave] = -1
    range(lca, up[lca], low[lca])
  }
  return rank
}

const Ω = [1, 2, 8] // how hard an edge pulls straight: between nodes, a node and a dummy, two dummies

/**
 * Lays out a flowchart. `g`:
 * - nodes: [{ w, h, cluster, loop }]: size, the subgraph it's in (-1 for none), and room its self-loops take
 *   on its right (below, left to right);
 * - clusters: [{ parent, w, h }]: the subgraph's parent (-1 for none) and its title's size;
 * - edges: [{ v, w, minlen, label }]: a node's index, or ~index for a subgraph; label is { w, h } or null;
 * - dir: TB, BT, LR or RL; nodeSep, rankSep, edgeSep, pad: spacing in px.
 * Returns node centers, subgraph boxes with where their titles start (tx, ty), and each edge's polyline (null for an edge it can't draw) with its
 * label's center, all in px from the top left of the drawing, which is width × height. An edge's ends at
 * nodes are their centers, for the caller to clip to its shapes; its ends at subgraphs are on their boxes.
 */
export function layout(g) {
  // A subgraph that sets its own direction and keeps its edges inside lays out on its own, then stands in
  // its parent as one node of its size.
  const C = g.clusters.length
  const up = c => (c < 0 ? [] : [c, ...up(g.clusters[c].parent)])
  const dirOf = c => (c < 0 ? g.dir : g.clusters[c].dir ?? dirOf(g.clusters[c].parent))
  const within = (end, c) => (end >= 0 ? up(g.nodes[end].cluster).includes(c) : ~end !== c && up(~end).includes(c))
  const alone = []
  for (const c of [...g.clusters.keys()].sort((a, b) => up(a).length - up(b).length)) {
    const { dir, parent } = g.clusters[c]
    if (!dir || dir === dirOf(parent) || up(parent).some(a => alone.includes(a))) continue
    if (g.edges.some(e => e.v !== ~c && e.w !== ~c && within(e.v, c) !== within(e.w, c))) continue
    alone.push(c)
  }
  if (!alone.length) return place(g)
  const owner = end => alone.find(c => within(end, c)) ?? -1
  const parts = alone.map(c => {
    const nodes = [...g.nodes.keys()].filter(v => within(v, c)), clusters = [...g.clusters.keys()].filter(d => within(~d, c))
    const ni = new Map(nodes.map((v, k) => [v, k])), ci = new Map(clusters.map((d, k) => [d, k]))
    const edges = [...g.edges.keys()].filter(k => owner(g.edges[k].v) === c && owner(g.edges[k].w) === c)
    const map = end => (end >= 0 ? ni.get(end) : ~ci.get(~end))
    const res = layout({
      ...g, dir: g.clusters[c].dir,
      nodes: nodes.map(v => ({ ...g.nodes[v], cluster: ci.get(g.nodes[v].cluster) ?? -1 })),
      clusters: clusters.map(d => ({ ...g.clusters[d], parent: ci.get(g.clusters[d].parent) ?? -1 })),
      edges: edges.map(k => ({ ...g.edges[k], v: map(g.edges[k].v), w: map(g.edges[k].w) })),
    })
    const { w, h } = g.clusters[c]
    return { c, nodes, clusters, edges, res, w: Math.max(res.width + 2 * g.pad, w), h: res.height + 2 * g.pad + h }
  })
  // The parent: everything outside those subgraphs, each of them a node.
  const nodes = [...g.nodes.keys()].filter(v => owner(v) < 0), clusters = [...g.clusters.keys()].filter(c => owner(~c) < 0 && !alone.includes(c))
  const ni = new Map(nodes.map((v, k) => [v, k])), ci = new Map(clusters.map((c, k) => [c, k]))
  parts.forEach((p, k) => (p.node = nodes.length + k))
  const map = end => (end >= 0 ? ni.get(end) : alone.includes(~end) ? parts[alone.indexOf(~end)].node : ~ci.get(~end))
  const edges = [...g.edges.keys()].filter(k => owner(g.edges[k].v) < 0 && owner(g.edges[k].w) < 0)
  const res = place({
    ...g,
    nodes: [...nodes.map(v => ({ ...g.nodes[v], cluster: ci.get(g.nodes[v].cluster) ?? -1 })),
      ...parts.map(p => ({ w: p.w, h: p.h, cluster: ci.get(g.clusters[p.c].parent) ?? -1 }))],
    clusters: clusters.map(c => ({ ...g.clusters[c], parent: ci.get(g.clusters[c].parent) ?? -1 })),
    edges: edges.map(k => ({ ...g.edges[k], v: map(g.edges[k].v), w: map(g.edges[k].w) })),
  })
  const out = { width: res.width, height: res.height, nodes: [], clusters: [], edges: g.edges.map(() => null) }
  nodes.forEach((v, k) => (out.nodes[v] = res.nodes[k]))
  clusters.forEach((c, k) => (out.clusters[c] = res.clusters[k]))
  edges.forEach((k, i) => (out.edges[k] = res.edges[i]))
  for (const p of parts) {
    const [cx, cy] = res.nodes[p.node], box = { x: cx - p.w / 2, y: cy - p.h / 2, w: p.w, h: p.h }
    const dx = box.x + (p.w - p.res.width) / 2, dy = box.y + g.clusters[p.c].h + g.pad
    const move = ([x, y]) => [x + dx, y + dy]
    out.clusters[p.c] = { ...box, tx: box.x, ty: box.y + g.clusters[p.c].h / 2 }
    p.nodes.forEach((v, k) => (out.nodes[v] = move(p.res.nodes[k])))
    p.clusters.forEach((d, k) => {
      const b = p.res.clusters[k]
      out.clusters[d] = { x: b.x + dx, y: b.y + dy, w: b.w, h: b.h, tx: b.tx + dx, ty: b.ty + dy }
    })
    p.edges.forEach((k, i) => {
      const e = p.res.edges[i]
      if (e) out.edges[k] = { points: e.points.map(move), label: e.label && move(e.label) }
    })
    // Edges at the subgraph stop on its box.
    g.edges.forEach((e, k) => {
      if (!out.edges[k] || (e.v !== ~p.c && e.w !== ~p.c)) return
      if (e.v === ~p.c) clipBox(out.edges[k].points, box, false)
      if (e.w === ~p.c) clipBox(out.edges[k].points, box, true)
    })
  }
  return out
}

/** The layout of a graph whose subgraphs all flow its way. */
function place(g) {
  const lr = g.dir === 'LR' || g.dir === 'RL', bt = g.dir === 'BT'
  const N = g.nodes.length, C = g.clusters.length
  const top = c => N + 2 * c, bottom = c => N + 2 * c + 1
  const labels = g.edges.some(e => e.label)
  // Vertices: nodes, each subgraph's top and bottom border, then dummies. Sizes are along the order axis
  // (w) and the rank axis (h), so left to right lays out as top to bottom with sizes swapped.
  const W = [], H = [], cl = [], dummy = []
  for (const n of g.nodes) W.push(lr ? n.h : n.w), H.push(lr ? n.w : n.h), cl.push(n.cluster), dummy.push(0)
  const ex = v => (v < N ? g.nodes[v].loop || 0 : 0) // room a node's self-loops take past its right
  for (let c = 0; c < C; c++) {
    const { w, h } = g.clusters[c], titled = !lr
    // The title sits in the band of the border that ends up on top; left to right, beside the members.
    W.push(titled && !bt ? w : 0, titled && bt ? w : 0)
    H.push(titled && !bt ? h : 0, titled && bt ? h : 0)
    cl.push(c, c)
    dummy.push(0, 0)
  }
  const path = g.clusters.map((_, c) => {
    const p = []
    for (let k = c; k >= 0 && p.length <= C; k = g.clusters[k].parent) p.unshift(k)
    return p
  })
  const inside = (v, c) => cl[v] >= 0 && path[cl[v]].includes(c)

  // Ranking graph: nesting edges hold each subgraph's members between its borders, then each edge in turn,
  // reversed when it would close a cycle, so the first edges written set the flow.
  const out = Array.from({ length: N + 2 * C }, () => [])
  const pairs = new Map(), from = [], to = [], len = [], wt = []
  const link = (a, b, l, w) => {
    const k = a * 65536 + b, i = pairs.get(k)
    if (i === undefined) pairs.set(k, from.length), from.push(a), to.push(b), len.push(l), wt.push(w), out[a].push(b)
    else len[i] = Math.max(len[i], l), (wt[i] += w)
  }
  const NEST = g.edges.length + 1
  for (let c = 0; c < C; c++) {
    let any = false
    for (let v = 0; v < N; v++) if (cl[v] === c) link(top(c), v, 1, NEST), link(v, bottom(c), 1, NEST), (any = true)
    for (let d = 0; d < C; d++) if (g.clusters[d].parent === c) link(top(c), top(d), 1, NEST), link(bottom(d), bottom(c), 1, NEST), (any = true)
    if (!any) link(top(c), bottom(c), 1, NEST)
  }
  const seen = new Int32Array(N + 2 * C)
  let stamp = 0
  const reaches = (a, b) => {
    const st = [a]
    stamp++
    while (st.length) {
      const x = st.pop()
      if (x === b) return true
      if (seen[x] === stamp) continue
      seen[x] = stamp
      for (const y of out[x]) st.push(y)
    }
    return false
  }
  // Each edge spans `span` ranks per rank it asks for, so subgraph borders fit between their members' ranks
  // and the next ones', and a label's dummy has a rank at the middle.
  const deep = Math.max(0, ...path.map(p => p.length))
  const span = deep ? 2 * deep + (labels ? 2 : 1) : labels ? 2 : 1
  const routes = g.edges.map(e => {
    const sc = e.v < 0 ? ~e.v : -1, tc = e.w < 0 ? ~e.w : -1
    const s = sc >= 0 ? bottom(sc) : e.v, t = tc >= 0 ? top(tc) : e.w
    if (s === t || (sc >= 0 && sc === tc) || (sc >= 0 && inside(t, sc)) || (tc >= 0 && inside(s, tc))) return null
    if (sc < 0 && tc < 0 && e.v === e.w) return null
    let r = { a: s, b: t, flip: false }
    if (reaches(t, s)) {
      const s2 = sc >= 0 ? top(sc) : s, t2 = tc >= 0 ? bottom(tc) : t
      r = (sc >= 0 || tc >= 0) && !reaches(s2, t2) ? { a: t2, b: s2, flip: true } : { a: t, b: s, flip: true }
    }
    link(r.a, r.b, Math.max(1, e.minlen || 1) * span, 1)
    return r
  })

  // Ranks, by network simplex over each connected part, each part's first rank 0.
  let V = N + 2 * C
  const part = new Int32Array(V).map((_, i) => i)
  const find = x => { while (part[x] !== x) x = part[x] = part[part[x]]; return x }
  for (let i = 0; i < from.length; i++) part[find(from[i])] = find(to[i])
  const roots = [...new Set(Array.from({ length: V }, (_, v) => find(v)))]
  if (roots.length > 1) for (const r of roots) from.push(V), to.push(r), len.push(0), wt.push(0)
  const raw = simplex(roots.length > 1 ? V + 1 : V, Int32Array.from(from), Int32Array.from(to), Float64Array.from(len), Float64Array.from(wt))
  const least = new Map()
  for (let v = 0; v < V; v++) least.set(find(v), Math.min(least.get(find(v)) ?? Infinity, raw[v]))
  const rank = []
  for (let v = 0; v < V; v++) rank.push(raw[v] - least.get(find(v)))
  // Only ranks with a node, a border, or a label stay; edges just pass through the others.
  const mids = routes.map((r, i) => (r && g.edges[i].label ? rank[r.a] + ((rank[r.b] - rank[r.a]) >> 1) : -1))
  const kept = [...new Set([...rank, ...mids.filter(m => m >= 0)])].sort((a, b) => a - b)
  const squeeze = new Map(kept.map((k, i) => [k, i]))
  for (let v = 0; v < V; v++) rank[v] = squeeze.get(rank[v])

  // Dummies along each edge longer than one rank, the label's at its middle. A dummy sits in the
  // subgraphs its edge passes through at that rank: up out of its tail's, then down into its head's.
  const chains = routes.map((r, i) => {
    if (!r) return null
    const chain = [r.a], ra = rank[r.a], rb = rank[r.b], label = g.edges[i].label
    const mid = label ? squeeze.get(mids[i]) : -1
    const ups = cl[r.a] >= 0 ? path[cl[r.a]] : [], downs = cl[r.b] >= 0 ? path[cl[r.b]] : []
    let common = 0
    while (common < ups.length && common < downs.length && ups[common] === downs[common]) common++
    const list = [...ups.slice(common).reverse(), common ? ups[common - 1] : -1, ...downs.slice(common)]
    const lca = ups.length - common
    let at = 0
    for (let k = ra + 1; k < rb; k++) {
      while (at < lca && rank[bottom(list[at])] < k) at++
      while (at >= lca && at + 1 < list.length && rank[top(list[at + 1])] <= k) at++
      const lab = label && k === mid
      W.push(lab ? (lr ? label.h : label.w) : 0)
      H.push(lab ? (lr ? label.w : label.h) : 0)
      cl.push(list[at])
      dummy.push(lab ? 2 : 1)
      rank.push(k)
      chain.push(V++)
    }
    chain.push(r.b)
    return chain
  })
  // A subgraph's box spans every rank from its top border to its bottom. A rank it has nothing in gets an
  // empty vertex in it, so its sides hold there too.
  const held = new Set()
  const hold = v => { for (const c of path[cl[v]]) held.add(c * 65536 + rank[v]) }
  for (let v = 0; v < V; v++) if (cl[v] >= 0) hold(v)
  for (const c of [...path.keys()].sort((a, b) => path[b].length - path[a].length)) {
    for (let k = rank[top(c)] + 1; k < rank[bottom(c)]; k++) {
      if (held.has(c * 65536 + k)) continue
      W.push(0), H.push(0), cl.push(c), dummy.push(1), rank.push(k)
      hold(V++)
    }
  }
  const ups = Array.from({ length: V }, () => []), downs = Array.from({ length: V }, () => [])
  for (const chain of chains) if (chain) for (let k = 1; k < chain.length; k++) downs[chain[k - 1]].push(chain[k]), ups[chain[k]].push(chain[k - 1])

  // Order within ranks: a depth-first start, then barycenter sweeps down and up, keeping the order with
  // the fewest crossings. Each subgraph's vertices stay together in a rank, and sibling subgraphs keep
  // one order across ranks, so their boxes never overlap.
  const R = Math.max(0, ...rank) + 1
  let layers = Array.from({ length: R }, () => [])
  const pos = new Float64Array(V), key = new Float64Array(V)
  {
    const done = new Uint8Array(V), byRank = [...Array(V).keys()].sort((a, b) => rank[a] - rank[b] || a - b)
    for (const s of byRank) {
      const st = [s]
      while (st.length) {
        const v = st.pop()
        if (done[v]) continue
        done[v] = 1
        layers[rank[v]].push(v)
        for (let k = downs[v].length - 1; k >= 0; k--) st.push(downs[v][k])
      }
    }
  }
  const depth = c => (c < 0 ? 0 : path[c].length)
  const under = (v, p) => (cl[v] === p ? v : ~path[cl[v]][depth(p)])
  const place = (p, verts, order) => {
    const groups = new Map(), list = []
    verts.forEach(v => {
      const c = under(v, p)
      let gr = groups.get(c)
      if (!gr) groups.set(c, (gr = { c, items: [], sum: 0, n: 0, i: list.length })), list.push(gr)
      gr.items.push(v)
      // A border's key puts it first in its own subgraph, not its subgraph first among others.
      if (key[v] === key[v] && (key[v] > -Infinity || c === v)) gr.sum += key[v], gr.n++
    })
    const sorted = list.filter(gr => gr.n).sort((a, b) => a.sum / a.n - b.sum / b.n || a.i - b.i)
    const fixed = list.filter(gr => !gr.n)
    const result = []
    for (let s = 0, f = 0; result.length < list.length;) result.push(f < fixed.length && (fixed[f].i <= result.length || s >= sorted.length) ? fixed[f++] : sorted[s++])
    // Sibling subgraphs this sweep has already ordered keep that order; the rest join it where they fall.
    const known = order.get(p) ?? []
    const slots = [], mine = []
    result.forEach((gr, i) => gr.c < 0 && known.includes(~gr.c) && (slots.push(i), mine.push(gr)))
    mine.sort((a, b) => known.indexOf(~a.c) - known.indexOf(~b.c))
    slots.forEach((i, k) => (result[i] = mine[k]))
    let after = -1
    for (const gr of result) {
      if (gr.c >= 0) continue
      const at = known.indexOf(~gr.c)
      if (at >= 0) after = at
      else known.splice(++after, 0, ~gr.c)
    }
    order.set(p, known)
    return result.flatMap(gr => (gr.c < 0 ? place(~gr.c, gr.items, order) : gr.items))
  }
  const arrange = (r, order) => {
    layers[r] = place(-1, layers[r], order)
    layers[r].forEach((v, i) => (pos[v] = i))
  }
  const barycenters = (r, adj) => {
    for (const v of layers[r]) {
      let s = 0
      for (const u of adj[v]) s += pos[u]
      key[v] = adj[v].length ? s / adj[v].length : v >= N && v < N + 2 * C ? -Infinity : NaN
    }
  }
  {
    const order = new Map()
    layers.forEach(layer => layer.forEach((v, i) => (key[v] = i)))
    for (let r = 0; r < R; r++) arrange(r, order)
  }
  const crossings = () => {
    let total = 0
    for (let r = 0; r + 1 < R; r++) {
      const pairs = []
      for (const u of layers[r]) for (const v of downs[u]) pairs.push(pos[u] * 65536 + pos[v])
      pairs.sort((a, b) => a - b)
      const n = layers[r + 1].length, tree = new Int32Array(n + 1)
      for (let i = 0; i < pairs.length; i++) {
        const p = (pairs[i] % 65536) + 1
        let higher = i
        for (let k = p; k > 0; k -= k & -k) higher -= tree[k]
        total += higher
        for (let k = p; k <= n; k += k & -k) tree[k]++
      }
    }
    return total
  }
  let best = layers.map(l => l.slice()), fewest = crossings()
  for (let sweep = 0, stale = 0; sweep < 24 && stale < 4 && fewest > 0; sweep++) {
    const order = new Map()
    if (sweep % 2 === 0) for (let r = 1; r < R; r++) barycenters(r, ups), arrange(r, order)
    else for (let r = R - 2; r >= 0; r--) barycenters(r, downs), arrange(r, order)
    const n = crossings()
    if (n < fewest) fewest = n, (best = layers.map(l => l.slice())), (stale = 0)
    else stale++
  }
  layers = best
  layers.forEach(layer => layer.forEach((v, i) => (pos[v] = i)))

  // x by network simplex on graphviz's auxiliary graph: each edge pulls its ends into line through a node
  // of its own, and neighbors in a rank keep their distance. Each subgraph's sides are two variables shared
  // by all its ranks, so nothing outside a box comes within it at any rank.
  const cside = V, aux = V + 2 * C
  const xs = new Map(), xf = [], xt = [], xl = [], xw = []
  const tie = (a, b, l, w) => {
    const k = a * 1048576 + b, i = xs.get(k)
    if (i === undefined) xs.set(k, xf.length), xf.push(a), xt.push(b), xl.push(Math.ceil(l)), xw.push(w)
    else xl[i] = Math.max(xl[i], Math.ceil(l)), (xw[i] += w)
  }
  const gap = (a, b) => (dummy[a] && dummy[b] ? g.edgeSep : dummy[a] || dummy[b] ? (g.nodeSep + g.edgeSep) / 2 : g.nodeSep)
  // Left to right, a subgraph's title takes a band above its members: on the order axis, past its left side.
  const band = c => g.pad + (lr ? g.clusters[c].h + g.pad / 2 : 0)
  for (const layer of layers) {
    const open = []
    let prev = -1
    // How far past `prev` the next item's near edge starts: prev is a vertex, or a subgraph's left or right side.
    const after = next => (prev < 0 ? 0 : prev < V ? W[prev] / 2 + ex(prev) + (next < V ? gap(prev, next) : (next - cside) & 1 ? g.pad : g.nodeSep)
      : (prev - cside) & 1 ? ((next - cside) & 1 && next >= V ? g.pad : g.nodeSep) : band((prev - cside) >> 1))
    const step = (x, l) => {
      if (prev >= 0) tie(prev, x, after(x) + l, 0)
      prev = x
    }
    for (const v of layer) {
      const p = cl[v] >= 0 ? path[cl[v]] : []
      let common = 0
      while (common < open.length && common < p.length && open[common] === p[common]) common++
      while (open.length > common) step(cside + 2 * open.pop() + 1, 0)
      while (open.length < p.length) open.push(p[open.length]), step(cside + 2 * open[open.length - 1], 0)
      step(v, W[v] / 2)
    }
    while (open.length) step(cside + 2 * open.pop() + 1, 0)
  }
  for (let c = 0; c < C; c++) tie(cside + 2 * c, cside + 2 * c + 1, 0, 1)
  let a = aux
  for (const chain of chains) {
    if (!chain) continue
    for (let k = 1; k < chain.length; k++) {
      const u = chain[k - 1], v = chain[k]
      const w = Ω[(dummy[u] ? 1 : 0) + (dummy[v] ? 1 : 0)]
      tie(a, u, 0, w)
      tie(a, v, 0, w)
      a++
    }
  }
  const x = simplex(a, Int32Array.from(xf), Int32Array.from(xt), Float64Array.from(xl), Float64Array.from(xw))
  // Of the equally short placements, a node takes the middle one: centered over its children and under its
  // parents, as far as its neighbors in its rank let it move.
  const left = new Int32Array(N).fill(-1), right = new Int32Array(N).fill(-1)
  for (let i = 0; i < xf.length; i++) {
    if (xw[i] || xf[i] >= aux || xt[i] >= aux) continue
    if (xt[i] < N) left[xt[i]] = i
    if (xf[i] < N) right[xf[i]] = i
  }
  for (let pass = 0; pass < 2; pass++) {
    for (let v = 0; v < N; v++) {
      const near = [...ups[v], ...downs[v]].map(u => [x[u], dummy[u] ? Ω[1] : Ω[0]]).sort((p, q) => p[0] - q[0])
      if (near.length < 2) continue
      const half = near.reduce((s, p) => s + p[1], 0) / 2
      let k = 0, sum = near[0][1]
      while (sum < half) sum += near[++k][1]
      const [m1, m2] = sum === half ? [near[k][0], near[k + 1][0]] : [near[k][0], near[k][0]]
      if (x[v] < m1 || x[v] > m2) continue
      const min = left[v] >= 0 ? x[xf[left[v]]] + xl[left[v]] : -Infinity, max = right[v] >= 0 ? x[xt[right[v]]] - xl[right[v]] : Infinity
      x[v] = Math.min(Math.max((m1 + m2) / 2, min, m1), max, m2)
    }
  }

  // y from the ranks' heights. Ranks of nodes are rankSep apart, a label's a little closer; a rank of
  // borders sits a box's padding away, or room for an arrow when an edge ends across the gap.
  const height = new Float64Array(R), y = new Float64Array(R), kind = new Uint8Array(R), ends = new Uint8Array(R)
  for (let v = 0; v < V; v++) {
    height[rank[v]] = Math.max(height[rank[v]], H[v])
    kind[rank[v]] |= v < N ? 2 : dummy[v] === 2 ? 1 : 0
  }
  for (const chain of chains) if (chain) for (let k = 1; k < chain.length; k++) if (!dummy[chain[k - 1]] || !dummy[chain[k]]) ends[rank[chain[k - 1]]] = 1
  for (let r = 1; r < R; r++) {
    const a = kind[r - 1], b = kind[r]
    const gap = a && b ? (a & b & 2 ? g.rankSep : g.rankSep * 0.65) : Math.max(g.pad, ends[r - 1] ? 24 : 0)
    y[r] = y[r - 1] + height[r - 1] / 2 + gap + height[r] / 2
  }

  // Back to the drawing's own axes, from the top left.
  const boxes = g.clusters.map((cluster, c) => {
    const t = top(c), b = bottom(c)
    const x0 = x[cside + 2 * c], x1 = x[cside + 2 * c + 1]
    const y0 = y[rank[t]] - H[t] / 2, y1 = y[rank[b]] + H[b] / 2
    return { x0, x1, y0, y1 }
  })
  let minX = Infinity, maxX = -Infinity, maxY = 0
  for (let v = 0; v < N; v++) minX = Math.min(minX, x[v] - W[v] / 2), (maxX = Math.max(maxX, x[v] + W[v] / 2 + ex(v)))
  for (let v = N + 2 * C; v < V; v++) minX = Math.min(minX, x[v] - W[v] / 2), (maxX = Math.max(maxX, x[v] + W[v] / 2))
  for (const b of boxes) minX = Math.min(minX, b.x0), (maxX = Math.max(maxX, b.x1))
  maxY = R ? y[R - 1] + height[R - 1] / 2 : 0
  const minY = R ? -height[0] / 2 : 0
  const span0 = maxX - minX, span1 = maxY - minY
  const at = (ox, oy) => {
    const u = ox - minX, w = oy - minY
    if (g.dir === 'LR') return [w, u]
    if (g.dir === 'RL') return [span1 - w, u]
    if (bt) return [u, span1 - w]
    return [u, w]
  }
  const nodes = g.nodes.map((_, v) => at(x[v], y[rank[v]]))
  // A title sits in its border's slot, which edges pass beside; left to right, in the band atop the box.
  const clusters = boxes.map((b, c) => {
    const [p, q] = at(b.x0, b.y0), [r, s] = at(b.x1, b.y1), t = bt ? bottom(c) : top(c)
    const box = { x: Math.min(p, r), y: Math.min(q, s), w: Math.abs(r - p), h: Math.abs(s - q) }
    const [tx, ty] = lr ? [box.x, box.y + g.pad / 2 + g.clusters[c].h / 2] : at(x[t] - W[t] / 2, y[rank[t]])
    return { ...box, tx, ty }
  })
  // Ports: a vertex's edges leave its bottom and reach its top spread out, in the order of where they go.
  const faces = new Map(), port = new Float64Array(2 * chains.length)
  chains.forEach((chain, i) => {
    if (!chain) return
    const n = chain.length
    for (const [v, toward, k] of [[chain[0], chain[1], 2 * i], [chain[n - 1], chain[n - 2], 2 * i + 1]]) {
      const key = v * 2 + (k & 1)
      if (!faces.has(key)) faces.set(key, [])
      faces.get(key).push([x[toward], k])
    }
  })
  for (const [key, list] of faces) {
    if (list.length < 2) continue
    list.sort((a, b) => a[0] - b[0])
    const step = Math.min(18, (0.7 * W[key >> 1]) / (list.length - 1))
    list.forEach(([, k], j) => (port[k] = (j - (list.length - 1) / 2) * step))
  }
  const edges = chains.map((chain, i) => {
    if (!chain) return null
    // From inside the tail at its port, straight out of its rank, through each dummy's rank, and straight
    // into the head at its port.
    const a = chain[0], b = chain[chain.length - 1], xa = x[a] + port[2 * i], xb = x[b] + port[2 * i + 1]
    const pts = [at(xa, y[rank[a]]), at(xa, y[rank[a]] + height[rank[a]] / 2)]
    let label = null
    for (let k = 1; k < chain.length - 1; k++) {
      const d = chain[k], r = rank[d], half = height[r] / 2
      if (dummy[d] === 2) label = at(x[d], y[r])
      pts.push(at(x[d], y[r] - half))
      if (half) pts.push(at(x[d], y[r] + half))
    }
    pts.push(at(xb, y[rank[b]] - height[rank[b]] / 2), at(xb, y[rank[b]]))
    if (routes[i].flip) pts.reverse()
    // An end at a subgraph stops on its box.
    const e = g.edges[i]
    if (e.v < 0) clipBox(pts, clusters[~e.v], false)
    if (e.w < 0) clipBox(pts, clusters[~e.w], true)
    if (!label && e.label) label = midpoint(pts)
    return { points: pts, label }
  })
  return { width: lr ? span1 : span0, height: lr ? span0 : span1, nodes, clusters, edges }
}

/** Cuts the polyline `pts` where it crosses the box, at its end (or its start), dropping what's inside. */
function clipBox(pts, b, end) {
  if (end) pts.reverse()
  const inBox = ([px, py]) => px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h
  let k = 0
  while (k + 1 < pts.length && inBox(pts[k + 1])) k++
  if (k + 1 < pts.length) {
    const [ax, ay] = pts[k + 1], [bx, by] = pts[k]
    // From the outside point a toward b: the first t where the segment enters the box.
    let t0 = 0
    const dx = bx - ax, dy = by - ay
    for (const [p, q] of [[-dx, ax - b.x], [dx, b.x + b.w - ax], [-dy, ay - b.y], [dy, b.y + b.h - ay]]) {
      if (p < 0) t0 = Math.max(t0, q / p)
    }
    pts.splice(0, k + 1, [ax + dx * t0, ay + dy * t0])
  }
  if (end) pts.reverse()
}

/** The point halfway along a polyline. */
function midpoint(pts) {
  let total = 0
  for (let k = 1; k < pts.length; k++) total += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1])
  for (let k = 1, half = total / 2; k < pts.length; k++) {
    const d = Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1])
    if (d >= half) return [pts[k - 1][0] + ((pts[k][0] - pts[k - 1][0]) * half) / (d || 1), pts[k - 1][1] + ((pts[k][1] - pts[k - 1][1]) * half) / (d || 1)]
    half -= d
  }
  return pts[0]
}
