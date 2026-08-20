/* ============================================================================
   BodyBank — countries and dialling codes
   ----------------------------------------------------------------------------
   Country used to be a free-text box, which meant "India", "india", "IN" and
   "Bharat" all arrived as different countries, and the phone number next to it
   arrived with whatever prefix the member felt like typing — or none. One list
   fixes both: the member picks a country, and the dialling code follows it.

   The names here MUST match the ones BB.TZ_COUNTRY produces in auth-pages.js,
   because that is what pre-selects the country from the browser's timezone.

   Data is one string, "Name|ISO2|dial", parsed once — a table of 200 object
   literals is the same information and eight times the bytes.
   ========================================================================== */
(function (global) {
  'use strict';

  var RAW = [
    'Afghanistan|AF|93', 'Albania|AL|355', 'Algeria|DZ|213', 'Andorra|AD|376', 'Angola|AO|244',
    'Antigua and Barbuda|AG|1268', 'Argentina|AR|54', 'Armenia|AM|374', 'Aruba|AW|297',
    'Australia|AU|61', 'Austria|AT|43', 'Azerbaijan|AZ|994', 'Bahamas|BS|1242', 'Bahrain|BH|973',
    'Bangladesh|BD|880', 'Barbados|BB|1246', 'Belarus|BY|375', 'Belgium|BE|32', 'Belize|BZ|501',
    'Benin|BJ|229', 'Bermuda|BM|1441', 'Bhutan|BT|975', 'Bolivia|BO|591',
    'Bosnia and Herzegovina|BA|387', 'Botswana|BW|267', 'Brazil|BR|55', 'Brunei|BN|673',
    'Bulgaria|BG|359', 'Burkina Faso|BF|226', 'Burundi|BI|257', 'Cambodia|KH|855',
    'Cameroon|CM|237', 'Canada|CA|1', 'Cape Verde|CV|238', 'Cayman Islands|KY|1345',
    'Central African Republic|CF|236', 'Chad|TD|235', 'Chile|CL|56', 'China|CN|86',
    'Colombia|CO|57', 'Comoros|KM|269', 'Congo|CG|242', 'Congo (DRC)|CD|243', 'Costa Rica|CR|506',
    'Croatia|HR|385', 'Cuba|CU|53', 'Cyprus|CY|357', 'Czechia|CZ|420', 'Denmark|DK|45',
    'Djibouti|DJ|253', 'Dominica|DM|1767', 'Dominican Republic|DO|1809', 'Ecuador|EC|593',
    'Egypt|EG|20', 'El Salvador|SV|503', 'Equatorial Guinea|GQ|240', 'Eritrea|ER|291',
    'Estonia|EE|372', 'Eswatini|SZ|268', 'Ethiopia|ET|251', 'Fiji|FJ|679', 'Finland|FI|358',
    'France|FR|33', 'Gabon|GA|241', 'Gambia|GM|220', 'Georgia|GE|995', 'Germany|DE|49',
    'Ghana|GH|233', 'Gibraltar|GI|350', 'Greece|GR|30', 'Greenland|GL|299', 'Grenada|GD|1473',
    'Guatemala|GT|502', 'Guinea|GN|224', 'Guinea-Bissau|GW|245', 'Guyana|GY|592', 'Haiti|HT|509',
    'Honduras|HN|504', 'Hong Kong|HK|852', 'Hungary|HU|36', 'Iceland|IS|354', 'India|IN|91',
    'Indonesia|ID|62', 'Iran|IR|98', 'Iraq|IQ|964', 'Ireland|IE|353', 'Israel|IL|972',
    'Italy|IT|39', 'Ivory Coast|CI|225', 'Jamaica|JM|1876', 'Japan|JP|81', 'Jordan|JO|962',
    'Kazakhstan|KZ|7', 'Kenya|KE|254', 'Kiribati|KI|686', 'Kosovo|XK|383', 'Kuwait|KW|965',
    'Kyrgyzstan|KG|996', 'Laos|LA|856', 'Latvia|LV|371', 'Lebanon|LB|961', 'Lesotho|LS|266',
    'Liberia|LR|231', 'Libya|LY|218', 'Liechtenstein|LI|423', 'Lithuania|LT|370',
    'Luxembourg|LU|352', 'Macau|MO|853', 'Madagascar|MG|261', 'Malawi|MW|265', 'Malaysia|MY|60',
    'Maldives|MV|960', 'Mali|ML|223', 'Malta|MT|356', 'Marshall Islands|MH|692',
    'Mauritania|MR|222', 'Mauritius|MU|230', 'Mexico|MX|52', 'Micronesia|FM|691', 'Moldova|MD|373',
    'Monaco|MC|377', 'Mongolia|MN|976', 'Montenegro|ME|382', 'Morocco|MA|212', 'Mozambique|MZ|258',
    'Myanmar|MM|95', 'Namibia|NA|264', 'Nauru|NR|674', 'Nepal|NP|977', 'Netherlands|NL|31',
    'New Zealand|NZ|64', 'Nicaragua|NI|505', 'Niger|NE|227', 'Nigeria|NG|234',
    'North Macedonia|MK|389', 'Norway|NO|47', 'Oman|OM|968', 'Pakistan|PK|92', 'Palau|PW|680',
    'Palestine|PS|970', 'Panama|PA|507', 'Papua New Guinea|PG|675', 'Paraguay|PY|595',
    'Peru|PE|51', 'Philippines|PH|63', 'Poland|PL|48', 'Portugal|PT|351', 'Puerto Rico|PR|1787',
    'Qatar|QA|974', 'Romania|RO|40', 'Russia|RU|7', 'Rwanda|RW|250', 'Saint Kitts and Nevis|KN|1869',
    'Saint Lucia|LC|1758', 'Saint Vincent and the Grenadines|VC|1784', 'Samoa|WS|685',
    'San Marino|SM|378', 'Sao Tome and Principe|ST|239', 'Saudi Arabia|SA|966', 'Senegal|SN|221',
    'Serbia|RS|381', 'Seychelles|SC|248', 'Sierra Leone|SL|232', 'Singapore|SG|65',
    'Slovakia|SK|421', 'Slovenia|SI|386', 'Solomon Islands|SB|677', 'Somalia|SO|252',
    'South Africa|ZA|27', 'South Korea|KR|82', 'South Sudan|SS|211', 'Spain|ES|34',
    'Sri Lanka|LK|94', 'Sudan|SD|249', 'Suriname|SR|597', 'Sweden|SE|46', 'Switzerland|CH|41',
    'Syria|SY|963', 'Taiwan|TW|886', 'Tajikistan|TJ|992', 'Tanzania|TZ|255', 'Thailand|TH|66',
    'Timor-Leste|TL|670', 'Togo|TG|228', 'Tonga|TO|676', 'Trinidad and Tobago|TT|1868',
    'Tunisia|TN|216', 'Turkey|TR|90', 'Turkmenistan|TM|993', 'Tuvalu|TV|688', 'Uganda|UG|256',
    'Ukraine|UA|380', 'United Arab Emirates|AE|971', 'United Kingdom|GB|44', 'United States|US|1',
    'Uruguay|UY|598', 'Uzbekistan|UZ|998', 'Vanuatu|VU|678', 'Vatican City|VA|379',
    'Venezuela|VE|58', 'Vietnam|VN|84', 'Yemen|YE|967', 'Zambia|ZM|260', 'Zimbabwe|ZW|263'
  ];

  // The handful members actually come from, floated to the top of the list so the
  // common case is one tap rather than a scroll through 190 names.
  var PRIORITY = ['IN', 'AE', 'US', 'GB', 'CA', 'AU', 'SA', 'QA', 'KW', 'OM', 'SG', 'MY'];

  var LIST = RAW.map(function (row) {
    var p = row.split('|');
    return { name: p[0], iso2: p[1], dial: '+' + p[2] };
  });

  var BY_NAME = {}, BY_ISO = {};
  LIST.forEach(function (c) {
    BY_NAME[c.name.toLowerCase()] = c;
    BY_ISO[c.iso2] = c;
  });

  /** ISO2 -> regional-indicator flag, so the list needs no image assets. */
  function flag(iso2) {
    if (!iso2 || iso2.length !== 2) return '';
    return String.fromCodePoint.apply(String, iso2.toUpperCase().split('').map(function (ch) {
      return 0x1F1E6 + (ch.charCodeAt(0) - 65);
    }));
  }

  function find(v) {
    if (!v) return null;
    var s = String(v).trim();
    return BY_NAME[s.toLowerCase()] || BY_ISO[s.toUpperCase()] || null;
  }

  /** Priority countries first, then everything else alphabetically. */
  function ordered() {
    var top = PRIORITY.map(function (i) { return BY_ISO[i]; }).filter(Boolean);
    var seen = {};
    top.forEach(function (c) { seen[c.iso2] = true; });
    return { top: top, rest: LIST.filter(function (c) { return !seen[c.iso2]; }) };
  }

  function option(c, label) {
    var o = document.createElement('option');
    o.value = c.name;
    o.textContent = label || (flag(c.iso2) + '  ' + c.name);
    o.setAttribute('data-dial', c.dial);
    o.setAttribute('data-iso', c.iso2);
    return o;
  }

  var BBCountries = {
    LIST: LIST,
    flag: flag,
    find: find,

    /** Dialling code for a country name or ISO2 ('' when unknown). */
    dialFor: function (v) {
      var c = find(v);
      return c ? c.dial : '';
    },

    /**
     * Fill a <select> with every country. Value is the country NAME, so the
     * payload sent to the server is unchanged from the free-text days and no
     * stored profile has to be migrated.
     */
    fillCountrySelect: function (sel, placeholder) {
      sel = typeof sel === 'string' ? document.getElementById(sel) : sel;
      if (!sel) return;
      sel.innerHTML = '';
      var ph = document.createElement('option');
      ph.value = '';
      ph.textContent = placeholder || 'Select your country';
      sel.appendChild(ph);
      var o = ordered();
      if (o.top.length) {
        var g1 = document.createElement('optgroup');
        g1.label = 'Common';
        o.top.forEach(function (c) { g1.appendChild(option(c)); });
        sel.appendChild(g1);
      }
      var g2 = document.createElement('optgroup');
      g2.label = 'All countries';
      o.rest.forEach(function (c) { g2.appendChild(option(c)); });
      sel.appendChild(g2);
    },

    /** Fill a narrow <select> with dialling codes: "🇮🇳 +91". */
    fillDialSelect: function (sel) {
      sel = typeof sel === 'string' ? document.getElementById(sel) : sel;
      if (!sel) return;
      sel.innerHTML = '';
      var o = ordered();
      var add = function (list, label) {
        var g = document.createElement('optgroup');
        g.label = label;
        list.forEach(function (c) {
          var op = document.createElement('option');
          op.value = c.dial;
          op.textContent = flag(c.iso2) + ' ' + c.dial;
          op.title = c.name + ' (' + c.dial + ')';
          op.setAttribute('data-iso', c.iso2);
          g.appendChild(op);
        });
        sel.appendChild(g);
      };
      if (o.top.length) add(o.top, 'Common');
      add(o.rest, 'All countries');
    },

    /**
     * Tie a dialling-code select to a country select: choosing India sets +91.
     * A member who then picks a different code by hand keeps it — the link is a
     * default, not a cage — until they change country again.
     */
    linkPhoneToCountry: function (countrySel, dialSel) {
      countrySel = typeof countrySel === 'string' ? document.getElementById(countrySel) : countrySel;
      dialSel = typeof dialSel === 'string' ? document.getElementById(dialSel) : dialSel;
      if (!countrySel || !dialSel) return;
      var apply = function () {
        var dial = BBCountries.dialFor(countrySel.value);
        if (dial) dialSel.value = dial;
      };
      countrySel.addEventListener('change', apply);
      apply();
      return apply;
    },

    /**
     * Split a stored number into its dialling code and the rest, so an existing
     * "+919876543210" reopens with India already selected.
     */
    splitPhone: function (value) {
      var s = String(value || '').trim().replace(/[\s()-]/g, '');
      if (!s) return { dial: '', number: '' };
      if (s.charAt(0) !== '+') return { dial: '', number: s.replace(/\D/g, '') };
      // Longest dialling code wins: +1868 (Trinidad) must beat +1 (US).
      var best = null;
      LIST.forEach(function (c) {
        if (s.indexOf(c.dial) === 0 && (!best || c.dial.length > best.dial.length)) best = c;
      });
      if (!best) return { dial: '', number: s.replace(/\D/g, '') };
      return { dial: best.dial, number: s.slice(best.dial.length).replace(/\D/g, '') };
    },

    /** One canonical E.164-ish string from the two controls. */
    composePhone: function (dial, number) {
      var n = String(number || '').replace(/\D/g, '');
      var d = String(dial || '').trim();
      if (!n) return '';
      if (!d) return n;
      return d + n;
    }
  };

  global.BBCountries = BBCountries;
  if (global.BB) global.BB.countries = BBCountries;
})(window);
