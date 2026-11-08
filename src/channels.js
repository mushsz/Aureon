// Canais manuais: normalização de telefone/WhatsApp e Instagram e links oficiais de abertura.
// wa.me (clique para conversar do WhatsApp) abre a conversa com o texto preenchido; ig.me/m abre a DM.
// Quem envia é sempre a pessoa, pelo próprio celular.

const IG_RESERVED = new Set(['p', 'reel', 'reels', 'explore', 'stories', 'tv', 'accounts', 'direct', 'share', 'about', 'legal', 'developer']);

/** Dígitos com DDI (Brasil 55 por padrão). null se não parecer telefone. */
export function normalizePhone(raw) {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);
  d = d.replace(/^0+/, '');
  if (d.length === 10 || d.length === 11) d = '55' + d;
  if (d.length < 10 || d.length > 15) return null;
  return d;
}

export function formatPhone(d) {
  if (!d) return '';
  const m = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(d);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : `+${d}`;
}

/** Número de um link wa.me / api.whatsapp.com / whatsapp://send. */
export function whatsappFromUrl(href) {
  const s = String(href ?? '');
  const m = /wa\.me\/(\+?\d{8,15})/i.exec(s) || /[?&]phone=(\+?\d{8,15})/i.exec(s);
  return m ? normalizePhone(m[1]) : null;
}

/** @ do Instagram a partir de URL ou texto "@perfil". */
export function instagramHandle(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  let handle = null;
  if (/instagram\.com/i.test(s)) {
    try {
      const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
      handle = u.pathname.split('/').filter(Boolean)[0] || null;
    } catch { return null; }
  } else if (/^@?[a-z0-9._]{1,30}$/i.test(s)) {
    handle = s.replace(/^@/, '');
  }
  if (!handle || IG_RESERVED.has(handle.toLowerCase()) || !/^[a-z0-9._]{1,30}$/i.test(handle)) return null;
  return handle.toLowerCase();
}

export const waLink = (phone, text) => `https://wa.me/${phone}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
export const igLink = (handle) => `https://ig.me/m/${handle}`;
export const igProfile = (handle) => `https://www.instagram.com/${handle}/`;
export const telLink = (phone) => `tel:+${phone}`;
