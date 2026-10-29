// A file's outline for quick open's `@`: its classes, functions, methods, types, headings and the like, read from
// the syntax tree its language parses. Pure, so symbols.test.js runs it on Lezer's parsers without a window.

/** Kinds that hold methods: a function directly inside one is a method. */
const HOLDS_METHODS = new Set(['class', 'struct', 'interface', 'trait', 'impl', 'enum'])
/** Names a declaration's own name can go by, across Lezer's grammars. */
const NAMES = ['VariableDefinition', 'TypeDefinition', 'PropertyDefinition', 'PrivatePropertyDefinition', 'Definition',
  'DefName', 'Name', 'BoundIdentifier', 'TypeIdentifier', 'VariableName', 'Identifier', 'NamespaceIdentifier', 'FieldName']
/** Nodes whose value makes a JavaScript variable or property a function or a class. */
const VALUE = { ArrowFunction: 'function', FunctionExpression: 'function', ClassExpression: 'class' }

/** The first direct child of `node` named one of `names`. */
function child(node, names) {
  for (let c = node.firstChild; c; c = c.nextSibling) if (names.includes(c.name)) return c
  return null
}

/** The text of `node` before its first child named one of `stops`, on one line. */
function head(node, slice, stops) {
  const stop = child(node, stops)
  return slice(node.from, stop ? stop.from : node.to).replace(/\s+/g, ' ').trim()
}

const named = kind => (node, slice) => {
  const name = child(node, NAMES)
  return name && { kind, name: slice(name.from, name.to) }
}

/** Is `node` at the top of its file, or exported from there? */
function topLevel(node) {
  let p = node.parent
  if (p?.name === 'ExportDeclaration') p = p.parent
  if (p?.name === 'VarDecl' || p?.name === 'ConstDecl') p = p.parent // Go's groups
  return !p?.parent
}

/** A C or C++ function's name: its declarator up to the parameters, through pointers and references. */
function declarator(node, slice) {
  for (let d = child(node, ['FunctionDeclarator', 'PointerDeclarator', 'ReferenceDeclarator']); d;) {
    if (d.name === 'FunctionDeclarator') {
      const name = d.firstChild
      return name && name.name !== 'ParameterList' ? slice(name.from, name.to) : null
    }
    d = child(d, ['FunctionDeclarator', 'PointerDeclarator', 'ReferenceDeclarator'])
  }
  return null
}

/** Declarations by node name: each returns `{ kind, name }`, an array of them for several, or null. */
const RULES = {
  // JavaScript and TypeScript
  ClassDeclaration: named('class'), // Java's and PHP's too
  FunctionDeclaration: named('function'),
  MethodDeclaration: named('method'), // Java's and PHP's too
  InterfaceDeclaration: named('interface'),
  TypeAliasDeclaration: named('type'),
  EnumDeclaration: named('enum'),
  NamespaceDeclaration: named('module'),
  ModuleDeclaration: named('module'),
  PropertyDeclaration(node, slice) {
    const name = child(node, ['PropertyDefinition', 'PrivatePropertyDefinition'])
    if (!name) return null
    const value = child(node, Object.keys(VALUE))
    return { kind: value ? 'method' : 'field', name: slice(name.from, name.to), at: value }
  },
  VariableDeclaration(node, slice) {
    const out = []
    const top = topLevel(node)
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.name !== 'VariableDefinition') continue
      let value = c.nextSibling
      if (value?.name === 'TypeAnnotation') value = value.nextSibling
      if (value?.name === 'Equals') value = value.nextSibling
      const kind = VALUE[value?.name]
      if (kind) out.push({ kind, name: slice(c.from, c.to), at: value })
      else if (top) {
        // An object's methods sit under it.
        const at = value?.name === 'ObjectExpression' ? value : undefined
        out.push({ kind: slice(node.from, node.from + 5) === 'const' ? 'constant' : 'variable', name: slice(c.from, c.to), at })
      }
    }
    return out
  },
  Property(node, slice, depth, parent) { // in an object: a method, or a property holding a function
    const name = child(node, ['PropertyDefinition'])
    // Not in an object a function builds as it runs: its callbacks are noise.
    if (!name || parent?.kind === 'function' || parent?.kind === 'method') return null
    if (child(node, ['ParamList'])) return { kind: 'method', name: slice(name.from, name.to) }
    const value = child(node, Object.keys(VALUE))
    return value && { kind: VALUE[value.name] === 'class' ? 'class' : 'method', name: slice(name.from, name.to), at: value }
  },
  // Python
  ClassDefinition: named('class'),
  FunctionDefinition(node, slice) { // C's and C++'s too, and PHP's
    const name = child(node, ['VariableName', 'Name'])
    if (name) return { kind: 'function', name: slice(name.from, name.to) }
    const c = declarator(node, slice)
    return c && { kind: 'function', name: c }
  },
  AssignStatement(node, slice) {
    const name = node.parent?.name === 'Script' && child(node, ['VariableName'])
    return name ? { kind: /^[A-Z][A-Z0-9_]*$/.test(slice(name.from, name.to)) ? 'constant' : 'variable', name: slice(name.from, name.to) } : null
  },
  // Rust
  ModItem: named('module'),
  StructItem: named('struct'),
  UnionItem: named('struct'),
  EnumItem: named('enum'),
  TraitItem: named('trait'),
  ImplItem: (node, slice) => ({ kind: 'impl', name: head(node, slice, ['DeclarationList']).replace(/^(unsafe )?impl\s*(<[^>]*>)?\s*/, '') }),
  FunctionItem: named('function'),
  ConstItem: named('constant'),
  StaticItem: named('constant'),
  TypeItem: named('type'),
  MacroDefinition: named('function'),
  // Go
  TypeSpec(node, slice) {
    const name = child(node, ['DefName'])
    if (!name) return null
    const shape = child(node, ['StructType', 'InterfaceType'])
    return { kind: shape?.name === 'StructType' ? 'struct' : shape ? 'interface' : 'type', name: slice(name.from, name.to) }
  },
  FunctionDecl: named('function'),
  MethodDecl(node, slice) {
    const name = child(node, ['FieldName'])
    if (!name) return null
    const receiver = child(node, ['Parameters'])
    const type = receiver && slice(receiver.from, receiver.to).match(/\*?\s*([\w.]+)(\[[^\]]*\])?\s*\)$/)
    return { kind: 'method', name: slice(name.from, name.to), container: type?.[1] }
  },
  VarSpec: (node, slice) => (topLevel(node.parent) ? named('variable')(node, slice) : null),
  ConstSpec: (node, slice) => (topLevel(node.parent) ? named('constant')(node, slice) : null),
  // Java
  ConstructorDeclaration: named('method'),
  RecordDeclaration: named('class'),
  AnnotationTypeDeclaration: named('interface'),
  // C and C++
  NamespaceDefinition: named('module'), // PHP's too
  ClassSpecifier: (node, slice) => (child(node, ['FieldDeclarationList']) ? named('class')(node, slice) : null),
  StructSpecifier: (node, slice) => (child(node, ['FieldDeclarationList']) ? named('struct')(node, slice) : null),
  UnionSpecifier: (node, slice) => (child(node, ['FieldDeclarationList']) ? named('struct')(node, slice) : null),
  EnumSpecifier: (node, slice) => (child(node, ['EnumeratorList']) ? named('enum')(node, slice) : null),
  PreprocDirective(node, slice) {
    const name = node.firstChild?.name === '#define' && node.firstChild.nextSibling
    return name?.name === 'Identifier' ? { kind: name.nextSibling?.name === '(' ? 'function' : 'constant', name: slice(name.from, name.to) } : null
  },
  // PHP
  TraitDeclaration: named('trait'),
  // CSS, Sass and Less
  RuleSet: (node, slice) => ({ kind: 'rule', name: head(node, slice, ['Block']).slice(0, 120) }),
  // YAML and JSON: keys two deep at most
  Pair(node, slice, depth) {
    const key = depth < 2 && child(node, ['Key'])
    return key ? { kind: 'key', name: slice(key.from, key.to) } : null
  },
  Property_json(node, slice, depth) {
    const key = depth < 2 && child(node, ['PropertyName'])
    return key ? { kind: 'key', name: slice(key.from, key.to).replace(/^"|"$/g, '') } : null
  },
}

/** Markdown's headings: `#` to `######`, and underlined with `=` or `-`. */
const HEADING = /^(?:ATX|Setext)Heading(\d)$/

/**
 * The outline of a file that `tree` parses, `slice(from, to)` giving its text: `{ items, partial }`, where each item
 * is `{ name, kind, from, depth, container }` in the file's order, `depth` counting the items it sits inside and
 * `container` naming the nearest. `partial` when there were more than `limit`.
 */
export function outline(tree, slice, limit = 5000) {
  const items = []
  const stack = [] // [node, item] for each open item that holds others, closed as the walk leaves its node
  const opens = new Map() // a function's or class's value node start → its item, opened as the walk enters it
  const headings = [] // Markdown's open headings: [level, item]
  const json = tree.type.name === 'JsonText'
  const css = tree.type.name === 'StyleSheet'
  let partial = false

  function add(found, node, at = node) {
    const parent = stack.at(-1)?.[1]
    let kind = found.kind
    if ((kind === 'function') && HOLDS_METHODS.has(parent?.kind)) kind = 'method'
    const item = { name: found.name, kind, from: node.from, depth: stack.length, container: found.container ?? parent?.name ?? '' }
    if (!item.name) return null
    if (items.length >= limit) { partial = true; return null }
    items.push(item)
    return item
  }

  tree.iterate({
    enter(ref) {
      if (partial) return false
      const name = ref.name
      const level = HEADING.exec(name)?.[1]
      if (level) {
        while (headings.length && headings.at(-1)[0] >= +level) headings.pop()
        const text = slice(ref.from, ref.to).split('\n')[0].replace(/^\s*#+\s*|\s+#+\s*$/g, '').trim()
        const parent = headings.at(-1)?.[1]
        if (items.length >= limit) { partial = true; return false }
        const item = { name: text, kind: 'heading', from: ref.from, depth: headings.length, container: parent?.name ?? '' }
        items.push(item)
        headings.push([+level, item])
        return false
      }
      const open = opens.get(ref.from)
      if (open && (VALUE[name] || name === 'ObjectExpression')) {
        opens.delete(ref.from)
        stack.push([ref.node, open])
        return
      }
      const rule = json && name === 'Property' ? RULES.Property_json
        : css && /Statement$/.test(name) && slice(ref.from, ref.from + 1) === '@'
          ? (node, s) => (child(node, ['Block']) ? { kind: 'rule', name: head(node, s, ['Block']).slice(0, 120) } : null)
          : !css && name === 'RuleSet' ? null
          : Object.hasOwn(RULES, name) && !name.endsWith('_json') ? RULES[name] : null
      if (!rule) return
      const node = ref.node
      const found = rule(node, slice, stack.length, stack.at(-1)?.[1])
      if (!found) return
      if (Array.isArray(found)) {
        for (const f of found) {
          const item = add(f, node)
          if (item && f.at) opens.set(f.at.from, item)
        }
        return
      }
      const item = add(found, node)
      if (!item) return
      if (found.at) opens.set(found.at.from, item)
      else stack.push([node, item])
    },
    leave(ref) {
      const top = stack.at(-1)?.[0]
      if (top && top.from === ref.from && top.to === ref.to && top.type === ref.type) stack.pop()
    },
  })
  return { items, partial }
}
