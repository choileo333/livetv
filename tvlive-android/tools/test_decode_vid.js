function isM3u8(u) {
  var s = String(u || '');
  var cut = s.indexOf('#');
  if (cut >= 0) s = s.slice(0, cut);
  cut = s.indexOf('?');
  if (cut >= 0) s = s.slice(0, cut);
  return /\.m3u8$/i.test(s);
}

function base64Decode(data) {
  var b64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  var o1, o2, o3, h1, h2, h3, h4, bits, i = 0, ac = 0, dec = '', tmpArr = [];
  if (!data) return data;
  data += '';
  while (data.length % 4 !== 0) data += '=';
  do {
    h1 = b64.indexOf(data.charAt(i++));
    h2 = b64.indexOf(data.charAt(i++));
    h3 = b64.indexOf(data.charAt(i++));
    h4 = b64.indexOf(data.charAt(i++));
    bits = h1 << 18 | h2 << 12 | h3 << 6 | h4;
    o1 = bits >> 16 & 0xff;
    o2 = bits >> 8 & 0xff;
    o3 = bits & 0xff;
    if (h3 === 64) tmpArr[ac++] = String.fromCharCode(o1);
    else if (h4 === 64) tmpArr[ac++] = String.fromCharCode(o1, o2);
    else tmpArr[ac++] = String.fromCharCode(o1, o2, o3);
  } while (i < data.length);
  dec = tmpArr.join('');
  return dec;
}

function xorKey(s, key) {
  if (!s || !key) return '';
  var out = '';
  for (var i = 0; i < s.length; i++) {
    out += String.fromCharCode(s.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return out;
}

function extractVar(html, name) {
  if (!html) return '';
  var re = new RegExp('var\\s+' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=\\s*"([^"]+)"');
  var m = String(html).match(re);
  return (m && m[1]) ? m[1] : '';
}

function decodeVidFromHtml(html) {
  var ec2 = extractVar(html, 'phpsiteEc2');
  var key = extractVar(html, 'phpsitekey3');
  if (!ec2 || !key) return '';
  try {
    var step1 = base64Decode(ec2);
    var step2 = xorKey(step1, key);
    var step3 = base64Decode(step2);
    if (isM3u8(step3)) return step3;
  } catch (e) {}
  return '';
}

var html = require('fs').readFileSync('tools/probe_out/onet_real2.html', 'utf8');
var v = decodeVidFromHtml(html);
console.log('解出 vid:', v);
console.log('是否 m3u8:', isM3u8(v));
