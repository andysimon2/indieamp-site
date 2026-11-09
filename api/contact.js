// The contact form's one endpoint (2026-11-09). Static site otherwise; this is
// the only server code. It emails the message to the inbox through Mailgun
// from the site's own sending domain, with the visitor as Reply-To, so the
// inbox address never appears on a page.
//
// Spam: a hidden "website" field no person fills in, a minimum time on the
// form (the "t" field is the page's load time), length caps, and a small
// per-address rate limit. No CAPTCHA by design.
//
// Env (Vercel project indieamp-site): MAILGUN_API_KEY (the mail.indieamp.app
// sending key), MAILGUN_DOMAIN (mail.indieamp.app), CONTACT_TO (the inbox).

const LIMITS = { name: 120, email: 200, org: 160, role: 40, message: 4000 }
const MIN_FILL_MS = 3000
const RATE = { max: 4, windowMs: 10 * 60 * 1000 }
const hits = new Map() // best effort per warm instance

function clip(v, n) { return typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, n) : '' }
function looksLikeEmail(s) { return /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']{2,}$/.test(s) }
function clientIp(req) { return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown' }
function limited(ip) {
  const now = Date.now()
  const row = hits.get(ip) || []
  const recent = row.filter(t => now - t < RATE.windowMs)
  recent.push(now); hits.set(ip, recent)
  if (hits.size > 5000) hits.clear()
  return recent.length > RATE.max
}
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body
  const raw = typeof req.body === 'string' ? req.body : await new Promise(r => { let s = ''; req.on('data', c => { s += c }); req.on('end', () => r(s)) })
  const ct = String(req.headers['content-type'] || '')
  if (ct.includes('application/json')) { try { return JSON.parse(raw) } catch { return {} } }
  return Object.fromEntries(new URLSearchParams(raw))
}
function wantsHtml(req) { return String(req.headers.accept || '').includes('text/html') && !String(req.headers['content-type'] || '').includes('application/json') }
function answer(req, res, status, body, redirectTo) {
  if (wantsHtml(req) && redirectTo) { res.statusCode = 303; res.setHeader('Location', redirectTo); return res.end() }
  res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store')
  return res.end(JSON.stringify(body))
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.statusCode = 405; res.setHeader('Allow', 'POST'); return res.end() }
  const b = await readBody(req)
  // Honeypot: a filled hidden field is a bot — answer as if sent, send nothing.
  if (clip(b.website, 50)) return answer(req, res, 200, { ok: true }, '/contact.html?sent=1')
  const t = Number(b.t); if (!Number.isFinite(t) || Date.now() - t < MIN_FILL_MS) return answer(req, res, 200, { ok: true }, '/contact.html?sent=1')
  if (limited(clientIp(req))) return answer(req, res, 429, { ok: false, error: 'Please wait a few minutes before sending another message.' }, '/contact.html?error=rate')

  const name = clip(b.name, LIMITS.name), email = clip(b.email, LIMITS.email), org = clip(b.org, LIMITS.org), role = clip(b.role, LIMITS.role), message = clip(b.message, LIMITS.message)
  if (!name || !looksLikeEmail(email) || !message) return answer(req, res, 400, { ok: false, error: 'Please add your name, a valid email address and a message.' }, '/contact.html?error=fields')

  const key = process.env.MAILGUN_API_KEY, domain = process.env.MAILGUN_DOMAIN, to = process.env.CONTACT_TO
  if (!key || !domain || !to) { console.error('[contact] mail is not configured'); return answer(req, res, 503, { ok: false, error: 'The form is not available right now.' }, '/contact.html?error=unavailable') }

  const roleWord = { network: 'Network / association', member: 'Member store', brand: 'Brand partner', other: 'Other' }[role] || 'Not said'
  const text = [
    `From: ${name} <${email}>`, `Organization: ${org || '—'}`, `I am a: ${roleWord}`, '',
    message, '', `— sent from indieamp.app/contact · ${new Date().toISOString()} · ${clientIp(req)}`,
  ].join('\n')
  const form = new URLSearchParams({
    from: `IndieAmp website <contact@${domain}>`, to, 'h:Reply-To': `${name.replace(/[<>"]/g, '')} <${email}>`,
    subject: `[indieamp.app] ${roleWord} — ${name}${org ? ` (${org})` : ''}`, text, 'o:tag': 'contact-form',
  })
  try {
    const r = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
      method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`api:${key}`).toString('base64') }, body: form,
    })
    if (!r.ok) { console.error('[contact] mailgun', r.status, (await r.text()).slice(0, 200)); return answer(req, res, 502, { ok: false, error: 'We could not send your message. Please try again in a minute.' }, '/contact.html?error=send') }
  } catch (e) {
    console.error('[contact] mailgun unreachable', e && e.message); return answer(req, res, 502, { ok: false, error: 'We could not send your message. Please try again in a minute.' }, '/contact.html?error=send')
  }
  return answer(req, res, 200, { ok: true }, '/contact.html?sent=1')
}
