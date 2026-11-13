import { createClient } from '@supabase/supabase-js';
import { cancelPixReminder } from '../lib/send-notification.js';
import { notifyOrderPaid } from '../lib/order-emails.js';
import { sendMetaEvent } from '../lib/meta-capi.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const { payment_id, reminder_id, reminder_2h_id, reminder_4h_id } = req.query;
  if (!payment_id) return res.status(400).json({ error: 'Missing payment_id' });
  if (!/^[\w-]{1,64}$/.test(String(payment_id))) {
    return res.status(400).json({ error: 'Invalid payment_id' });
  }

  try {
    // 1. Verificar status no Supabase
    const { data: order } = await supabase
      .from('orders')
      .select('*')
      .eq('mp_payment_id', String(payment_id))
      .single();

    if (order?.status === 'approved') {
      return res.status(200).json({ status: 'approved' });
    }

    // 2. Consultar diretamente a API do Mercado Pago
    const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${payment_id}`, {
      headers: { 'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}` },
    });

    if (!mpRes.ok) {
      return res.status(200).json({ status: order?.status || 'pending' });
    }

    const mpData = await mpRes.json();
    const mpStatus = mpData.status;

    if (mpStatus === 'approved') {
      // Atualizar Supabase
      await supabase
        .from('orders')
        .update({ status: 'approved' })
        .eq('mp_payment_id', String(payment_id));

      // Enviar email + notificações (só se ainda não estava aprovado)
      if (order) {
        const nameParts = (order.customer_name || '').trim().split(/\s+/);
        const addr = order.customer_address || {};

        // Cancelar todos os lembretes Pix pendentes
        if (reminder_id)    cancelPixReminder(reminder_id).catch(() => {});
        if (reminder_2h_id) cancelPixReminder(reminder_2h_id).catch(() => {});
        if (reminder_4h_id) cancelPixReminder(reminder_4h_id).catch(() => {});

        // Confirmação (+ upsell no pedido principal) — uma única vez por pedido
        await notifyOrderPaid(order.id);
      }

      return res.status(200).json({ status: 'approved' });
    }

    return res.status(200).json({ status: mpStatus || order?.status || 'pending' });
  } catch (err) {
    console.error('check-payment-status error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
