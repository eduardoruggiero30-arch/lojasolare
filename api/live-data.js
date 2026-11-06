import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'solare@2024';

// Visitante conta como "ao vivo" se deu sinal nos últimos 90s (o tracker avisa a cada 20s)
const ACTIVE_MS = 90 * 1000;

function startOfTodayBR() {
  // Meia-noite de hoje no horário de Brasília (UTC-3)
  const br = new Date(Date.now() - 3 * 3600e3);
  return `${br.toISOString().slice(0, 10)}T00:00:00-03:00`;
}

function tally(rows, key) {
  const out = {};
  for (const r of rows) { const k = r[key] || 'desconhecido'; out[k] = (out[k] || 0) + 1; }
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (req.query.password !== DASHBOARD_PASSWORD) return res.status(401).json({ error: 'Senha incorreta.' });
  res.setHeader('Cache-Control', 'no-store');

  try {
    const today = startOfTodayBR();
    const activeSince = new Date(Date.now() - ACTIVE_MS).toISOString();

    const [activeQ, todayQ, ordersQ] = await Promise.all([
      supabase.from('live_sessions')
        .select('stage, page, city, region, lat, lon, device, source')
        .gte('last_seen', activeSince).limit(5000),
      supabase.from('live_sessions')
        .select('reached, device, source')
        .gte('first_seen', today).limit(50000),
      supabase.from('orders')
        .select('status, total_price, payment_method, customer_address')
        .gte('created_at', today).limit(5000),
    ]);
    if (activeQ.error) throw activeQ.error;
    if (todayQ.error) throw todayQ.error;
    if (ordersQ.error) throw ordersQ.error;

    const active = activeQ.data;
    const visits = todayQ.data;
    const orders = ordersQ.data.map(o => {
      let a = o.customer_address || {};
      if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = {}; } }
      return { ...o, upsell: !!a.upsell };
    });

    // Agrupa os visitantes ativos por cidade para os pontos do mapa
    const byCity = {};
    for (const s of active) {
      const key = `${s.city || '?'}|${s.region || ''}`;
      if (!byCity[key]) byCity[key] = { city: s.city, region: s.region, lat: s.lat, lon: s.lon, count: 0 };
      byCity[key].count++;
    }

    const paid = orders.filter(o => o.status === 'approved');
    const mainPaid = paid.filter(o => !o.upsell);
    const revenue = Math.round(paid.reduce((s, o) => s + (Number(o.total_price) || 0), 0) * 100) / 100;

    return res.status(200).json({
      now: new Date().toISOString(),
      live: {
        total:   active.length,
        stages:  tally(active, 'stage'),
        devices: tally(active, 'device'),
        sources: tally(active, 'source'),
        cities:  Object.values(byCity).sort((a, b) => b.count - a.count),
      },
      today: {
        visits:     visits.length,
        carrinho:   visits.filter(v => v.reached >= 1).length,
        checkout:   visits.filter(v => v.reached >= 2).length,
        pixGerados: orders.filter(o => !o.upsell && o.payment_method === 'pix').length,
        vendas:     mainPaid.length,
        receita:    revenue,
        conversao:  visits.length ? Math.round((mainPaid.length / visits.length) * 1000) / 10 : 0,
        devices:    tally(visits, 'device'),
        sources:    tally(visits, 'source'),
      },
    });
  } catch (e) {
    console.error('[live-data]', e.message);
    return res.status(500).json({ error: 'Erro ao carregar dados ao vivo.' });
  }
}
