/**
 * Address Normalization Utility
 * Ensures consistent cache keys across all Redis operations
 */

/**
 * Normalize address for cache key consistency
 * Used by: geocodeCache, redisCache (subject refs, global comps, rawComps)
 */
export function normalizeAddress(address: string): string {
  return address
    .toLowerCase()
    .trim()
    // Remove punctuation except commas
    .replace(/[^\w\s,]/g, '')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    // Remove extra commas
    .replace(/,+/g, ',')
    .trim();
}

const DIRECTIONALS = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw', 'north', 'south', 'east', 'west']);
const STREET_TYPES: Record<string, string> = {
  street: 'st', st: 'st', avenue: 'ave', ave: 'ave', road: 'rd', rd: 'rd', drive: 'dr', dr: 'dr',
  lane: 'ln', ln: 'ln', court: 'ct', ct: 'ct', circle: 'cir', cir: 'cir', place: 'pl', pl: 'pl',
  boulevard: 'blvd', blvd: 'blvd', highway: 'hwy', hwy: 'hwy', parkway: 'pkwy', pkwy: 'pkwy',
  terrace: 'ter', ter: 'ter', trail: 'trl', trl: 'trl', square: 'sq', sq: 'sq', way: 'way',
  loop: 'loop', row: 'row', alley: 'aly', aly: 'aly'
};

/**
 * Strip an address down to house number, street name, street type and unit, so the
 * same physical property matches across the formats the search providers return
 * ("2612 clairmont rd, atl, ga, 30329" vs "123 Example Rd NE, Atlanta, GA 30329").
 */
export function propertyIdentity(address: string): { num: string; core: string; type: string; unit: string; zip: string } {
  const norm = normalizeAddress(address || '');
  const zip = (norm.match(/\b(\d{5})\b/) || ['', ''])[1];
  const words = (norm.split(',')[0] || '').split(/\s+/).filter(Boolean);
  const num = /^\d+$/.test(words[0] || '') ? words[0] : '';
  const core: string[] = [];
  let type = '';
  for (const word of (num ? words.slice(1) : words)) {
    if (STREET_TYPES[word]) {
      type = STREET_TYPES[word];
      break;
    }
    if (DIRECTIONALS.has(word)) continue;
    core.push(word);
    if (core.length >= 3) break;
  }
  const unit = ((address || '').toLowerCase().match(/(?:#|\bunit|\bapt|\bste|\bsuite|\btmu)\s*([a-z0-9]+)/) || ['', ''])[1];
  return { num, core: core.join(' '), type, unit, zip };
}

/**
 * True when two address strings name the same property. Directionals and punctuation
 * are ignored; a differing street type ("Fama Dr" vs "Fama Ct") or a differing zip
 * means a different property. A one-sided unit or street type still matches, because
 * a "123 Example Rd Unit A" listing under a "123 Example Rd" subject is the
 * subject itself, not a comparable.
 */
export function isSamePropertyAddress(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const x = propertyIdentity(a);
  const y = propertyIdentity(b);
  if (!x.num || x.num !== y.num) return false;
  if (x.core !== y.core) return false;
  if (x.zip && y.zip && x.zip !== y.zip) return false;
  if (x.type && y.type && x.type !== y.type) return false;
  return !x.unit || !y.unit || x.unit === y.unit;
}
