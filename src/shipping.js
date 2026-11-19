// Shipping across Nigeria: zone-based rates (same state / same geopolitical zone / nationwide)
const { getSettings } = require('./db');

const ZONES = {
  'North Central': ['Benue', 'FCT', 'Kogi', 'Kwara', 'Nasarawa', 'Niger', 'Plateau'],
  'North East': ['Adamawa', 'Bauchi', 'Borno', 'Gombe', 'Taraba', 'Yobe'],
  'North West': ['Jigawa', 'Kaduna', 'Kano', 'Katsina', 'Kebbi', 'Sokoto', 'Zamfara'],
  'South East': ['Abia', 'Anambra', 'Ebonyi', 'Enugu', 'Imo'],
  'South South': ['Akwa Ibom', 'Bayelsa', 'Cross River', 'Delta', 'Edo', 'Rivers'],
  'South West': ['Ekiti', 'Lagos', 'Ogun', 'Ondo', 'Osun', 'Oyo'],
};
const STATES = Object.values(ZONES).flat().sort((a, b) => (a === 'FCT' ? 'Abuja (FCT)' : a).localeCompare(b === 'FCT' ? 'Abuja (FCT)' : b));
const REGION_OF = {};
for (const [z, list] of Object.entries(ZONES)) for (const st of list) REGION_OF[st] = z;
const stateLabel = s => (s === 'FCT' ? 'Abuja (FCT)' : s);

const METHODS = ['doorstep', 'park', 'pickup'];
const ZONE_LABEL = { same_state: 'Within the same state', same_region: 'Same geopolitical zone', nationwide: 'Other parts of Nigeria' };

function zoneOf(from, to) {
  if (!from || !to) return 'nationwide';
  if (from === to) return 'same_state';
  if (REGION_OF[from] && REGION_OF[from] === REGION_OF[to]) return 'same_region';
  return 'nationwide';
}

function rates() {
  try { return JSON.parse(getSettings().shipping_rates); } catch { return {}; }
}

/** Fee (kobo) for one parcel, or null if the method isn't offered for that zone. */
function parcelFee(method, zone, weightKg) {
  const r = rates()[method];
  if (!r || !r.on) return null;
  const base = r[zone];
  if (base == null || base === '') return null;
  const extraKg = Math.max(0, Math.ceil((Number(weightKg) || 0.5) - 1));
  return Number(base) + extraKg * (Number(r.per_kg) || 0);
}

function eta(method, zone) {
  const r = rates()[method];
  return (r && r.eta && (r.eta[zone] || r.eta.same_state)) || '';
}

/**
 * Group printed items into parcels by who ships them (each author ships from their own location; the store ships its own stock).
 * items: [{ id, author_id, ship_from_state, ship_from_city, weight_kg, ... }]
 */
function groupParcels(items) {
  const s = getSettings();
  const groups = new Map();
  for (const it of items) {
    const key = it.author_id ? 'a' + it.author_id : 'store';
    if (!groups.has(key)) {
      groups.set(key, {
        key, author_id: it.author_id || null,
        origin_state: it.ship_from_state || (it.author_id ? null : s.store_ship_state),
        origin_city: it.ship_from_city || (it.author_id ? null : s.store_ship_city),
        items: [], weight: 0,
      });
    }
    const g = groups.get(key);
    g.items.push(it);
    g.weight += Number(it.weight_kg) || 0.5;
  }
  return [...groups.values()];
}

/** Quote every method for a set of printed items going to a state. */
function quote(items, destState) {
  const parcels = groupParcels(items);
  const out = {};
  for (const m of METHODS) {
    const r = rates()[m];
    if (!r || !r.on) continue;
    let total = 0, ok = true;
    const lines = [];
    for (const g of parcels) {
      const zone = zoneOf(g.origin_state, destState);
      const fee = parcelFee(m, zone, g.weight);
      if (fee == null) { ok = false; break; }
      total += fee;
      lines.push({ key: g.key, zone, fee, eta: eta(m, zone), origin: g.origin_state });
    }
    if (ok) out[m] = { method: m, label: r.label, total, parcels: lines, eta: lines.map(l => l.eta).filter(Boolean)[0] || '' };
  }
  return { parcels, options: out };
}

module.exports = { ZONES, STATES, REGION_OF, METHODS, ZONE_LABEL, stateLabel, zoneOf, rates, parcelFee, eta, groupParcels, quote };
