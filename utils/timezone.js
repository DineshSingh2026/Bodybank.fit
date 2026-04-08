const COUNTRY_TIMEZONE_MAP = {
  india: 'Asia/Kolkata',
  'united states': 'America/New_York',
  'united states of america': 'America/New_York',
  usa: 'America/New_York',
  us: 'America/New_York',
  canada: 'America/Toronto',
  norway: 'Europe/Oslo',
  uk: 'Europe/London',
  'united kingdom': 'Europe/London',
  england: 'Europe/London',
  scotland: 'Europe/London',
  ireland: 'Europe/Dublin',
  germany: 'Europe/Berlin',
  france: 'Europe/Paris',
  spain: 'Europe/Madrid',
  italy: 'Europe/Rome',
  netherlands: 'Europe/Amsterdam',
  sweden: 'Europe/Stockholm',
  denmark: 'Europe/Copenhagen',
  finland: 'Europe/Helsinki',
  australia: 'Australia/Sydney',
  'new zealand': 'Pacific/Auckland',
  singapore: 'Asia/Singapore',
  uae: 'Asia/Dubai',
  'united arab emirates': 'Asia/Dubai',
  qatar: 'Asia/Qatar',
  kuwait: 'Asia/Kuwait',
  saudi: 'Asia/Riyadh',
  'saudi arabia': 'Asia/Riyadh',
  oman: 'Asia/Muscat',
  bahrain: 'Asia/Bahrain',
  pakistan: 'Asia/Karachi',
  bangladesh: 'Asia/Dhaka',
  nepal: 'Asia/Kathmandu',
  'sri lanka': 'Asia/Colombo',
  malaysia: 'Asia/Kuala_Lumpur',
  indonesia: 'Asia/Jakarta',
  philippines: 'Asia/Manila',
  japan: 'Asia/Tokyo',
  'south korea': 'Asia/Seoul',
  korea: 'Asia/Seoul',
  china: 'Asia/Shanghai',
  'south africa': 'Africa/Johannesburg',
  nigeria: 'Africa/Lagos',
  kenya: 'Africa/Nairobi',
  brazil: 'America/Sao_Paulo',
  mexico: 'America/Mexico_City'
};

const WEEKDAY_INDEX = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6
};

function normalizeCountry(country) {
  return String(country || '')
    .trim()
    .toLowerCase()
    .replace(/[.,-]/g, ' ')
    .replace(/\s+/g, ' ');
}

function inferTimezoneFromCountry(country) {
  return COUNTRY_TIMEZONE_MAP[normalizeCountry(country)] || '';
}

function getUserTimezone(user) {
  const explicit = String(user?.timezone || '').trim();
  if (explicit) return explicit;
  return inferTimezoneFromCountry(user?.country) || 'UTC';
}

function extractLocalDateTimeParts(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) return null;

  const localMatch = value.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2})?(?:\.\d+)?$/);
  if (localMatch) return { date: localMatch[1], time: localMatch[2], hasExplicitTimezone: false };

  const zonedMatch = value.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i);
  if (zonedMatch) return { date: zonedMatch[1], time: zonedMatch[2], hasExplicitTimezone: true };

  return null;
}

function getTimeZoneParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'short'
  }).formatToParts(date);

  const result = {};
  for (const part of parts) {
    if (part.type !== 'literal') result[part.type] = part.value;
  }

  return {
    year: Number(result.year),
    month: Number(result.month),
    day: Number(result.day),
    hour: Number(result.hour),
    minute: Number(result.minute),
    second: Number(result.second),
    weekday: WEEKDAY_INDEX[String(result.weekday || '').slice(0, 3).toLowerCase()]
  };
}

function getTimeZoneOffsetMs(date, timeZone) {
  const parts = getTimeZoneParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0);
  return asUtc - date.getTime();
}

function localDateTimeToUtcIso(dateStr, timeHHMM, timeZone) {
  const [year, month, day] = String(dateStr || '').split('-').map(Number);
  const [hour, minute] = String(timeHHMM || '').split(':').map(Number);
  const tz = timeZone || 'UTC';
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  let offset = getTimeZoneOffsetMs(new Date(utcGuess), tz);
  let adjusted = utcGuess - offset;
  const refinedOffset = getTimeZoneOffsetMs(new Date(adjusted), tz);
  if (refinedOffset !== offset) adjusted = utcGuess - refinedOffset;
  return new Date(adjusted).toISOString();
}

function addDaysToDateString(dateStr, days) {
  const [year, month, day] = String(dateStr || '').split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

function getLocalDateParts(date, timeZone) {
  const parts = getTimeZoneParts(date, timeZone || 'UTC');
  return {
    date: `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`,
    weekday: parts.weekday
  };
}

module.exports = {
  inferTimezoneFromCountry,
  getUserTimezone,
  extractLocalDateTimeParts,
  localDateTimeToUtcIso,
  addDaysToDateString,
  getLocalDateParts
};
