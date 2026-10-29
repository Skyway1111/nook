// File names in Explorer's order: case and accents ignored, runs of digits compared as numbers. `Intl.Collator`
// gives that order but takes about 300 ms to sort a folder of 50,000 files, so names of printable ASCII, nearly
// all of them, are compared here with each character's weight taken from that collator, and the rest go to it.

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

// Each printable ASCII character's place in the collator's order. Characters it holds equal, as a and A, share
// one. Digits share one too, since a run of them compares as a number.
const WEIGHT = new Uint8Array(128)
{
  const chars = []
  for (let c = 32; c < 127; c++) chars.push(String.fromCharCode(c))
  chars.sort(collator.compare)
  let w = 1
  chars.forEach((c, i) => {
    if (i && collator.compare(chars[i - 1], c) !== 0 && !(isDigit(chars[i - 1].charCodeAt(0)) && isDigit(c.charCodeAt(0)))) w++
    WEIGHT[c.charCodeAt(0)] = w
  })
}

function isDigit(c) { return c >= 48 && c <= 57 }

/**
 * A string that orders as `name` does under the collator, compared with < and >, or null when `name` isn't all
 * printable ASCII. Each character becomes its weight; a run of digits becomes the digits' weight, the run's
 * length without leading zeros, then those digits, so a longer number ranks higher.
 */
export const nameKey = name => key(name, -1)

/** nameKey(name), led by the code `lead` unless it's -1 and followed by a 0 and `index` when `index` is given. */
function key(name, lead, index = -1) {
  const out = []
  let n = 0
  if (lead >= 0) out[n++] = lead
  for (let i = 0; i < name.length;) {
    const c = name.charCodeAt(i)
    if (c < 32 || c > 126) return null
    if (!isDigit(c)) {
      out[n++] = WEIGHT[c] + 32
      i++
      continue
    }
    let end = i
    while (end < name.length && isDigit(name.charCodeAt(end))) end++
    while (i < end - 1 && name.charCodeAt(i) === 48) i++
    out[n++] = WEIGHT[c] + 32
    out[n++] = end - i + 32
    while (i < end) out[n++] = name.charCodeAt(i++)
  }
  if (index >= 0) {
    out[n++] = 0
    out[n++] = index >>> 16
    out[n++] = index & 0xffff
  }
  // One call makes one flat string; strings joined from pieces compare several times slower.
  return String.fromCharCode.apply(null, out)
}

const byKey = (a, b) => (a.k !== null && b.k !== null ? (a.k < b.k ? -1 : a.k > b.k ? 1 : 0) : collator.compare(a.name, b.name))

/** Orders two names as Explorer does: negative when `a` comes first, 0 when they rank equal. */
export function compareNames(a, b) {
  return byKey({ name: a, k: nameKey(a) }, { name: b, k: nameKey(b) })
}

/** A folder's entries, `{ name, dir }`, sorted folders first and then by name, in a new array. */
export function sortEntries(entries) {
  // Keyed, every name sorts by plain string comparison, the fastest sort there is: a folder or file mark, the
  // key, then a 0 and the entry's index, which keeps names that rank equal in the order they came.
  const keys = new Array(entries.length)
  for (let i = 0; i < entries.length; i++) {
    const k = key(entries[i].name, entries[i].dir ? 1 : 2, i)
    if (k === null) return entries.slice().sort((a, b) => (b.dir ? 1 : 0) - (a.dir ? 1 : 0) || compareNames(a.name, b.name))
    keys[i] = k
  }
  keys.sort()
  return keys.map(k => entries[(k.charCodeAt(k.length - 2) << 16) | k.charCodeAt(k.length - 1)])
}
