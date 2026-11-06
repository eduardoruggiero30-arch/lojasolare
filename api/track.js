import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Etapas do funil, na ordem: a posição vira o "reached" (até onde o visitante chegou)
const STAGES = ['outras', 'produto', 'carrinho', 'checkout', 'pix', 'pos'];
const RANK   = { outras: 0, produto: 0, carrinho: 1, checkout: 2, pix: 3, pos: 4 };
const SOURCES = ['facebook', 'instagram', 'google', 'tiktok', 'direto', 'outros'];
const DEVICES = ['celular', 'tablet', 'computador'];

const clip = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);
const num  = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const hdr  = (req, k) => { try { const v = req.headers[k]; return v ? decodeURIComponent(v) : null; } catch { return null; } };

// Recebe o "estou aqui" que cada página manda a cada 20s (tracker.js).
// A cidade vem do IP pelos cabeçalhos da Vercel — o IP em si não é guardado.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body || '{}');
    body = body || {};

    const sid = clip(body.sid, 40);
    if (!sid || !/^[a-z0-9-]{8,40}$/i.test(sid)) return res.status(400).end();
    const stage = STAGES.includes(body.stage) ? body.stage : 'outras';

    const { error } = await supabase.rpc('live_ping', {
      p_sid:     sid,
      p_stage:   stage,
      p_page:    clip(body.page, 80),
      p_city:    clip(hdr(req, 'x-vercel-ip-city'), 80),
      p_region:  clip(hdr(req, 'x-vercel-ip-country-region'), 10),
      p_country: clip(hdr(req, 'x-vercel-ip-country'), 4),
      p_lat:     num(hdr(req, 'x-vercel-ip-latitude')),
      p_lon:     num(hdr(req, 'x-vercel-ip-longitude')),
      p_device:  DEVICES.includes(body.device) ? body.device : null,
      p_source:  SOURCES.includes(body.source) ? body.source : null,
      p_rank:    RANK[stage],
    });
    if (error) console.error('[track]', error.message);

    // Faxina ocasional: visitas com mais de 40 dias não entram em nenhum número
    if (Math.random() < 0.002) {
      await supabase.from('live_sessions').delete().lt('last_seen', new Date(Date.now() - 40 * 864e5).toISOString());
    }
  } catch (e) {
    console.error('[track]', e.message);
  }
  return res.status(204).end();
}
