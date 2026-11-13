/**
 * Envio de e-mails pela Brevo + e-mails pós-compra simples (preparando e rastreio).
 * Os e-mails da jornada de compra ficam em lib/order-emails.js e o visual em lib/email-layout.js.
 */
import {
  escapeHtml, ref, brl, firstName, fmtPhone, whatsappLink, SUPPORT_WHATSAPP,
  layout, button, rows, box,
} from './email-layout.js';

export { escapeHtml, ref };

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'contato@solareluminarias.com.br';
const FROM_NAME = process.env.FROM_NAME || 'Solare Luminárias';
// Respostas dos clientes vão para este e-mail (ex.: o Gmail da loja)
const REPLY_TO_EMAIL = process.env.REPLY_TO_EMAIL || '';

// ─────────────────────────────────────────────
// Email Sender (Brevo)
// ─────────────────────────────────────────────

// Envia (ou agenda, com scheduledAt) pela API transacional da Brevo e devolve o messageId.
// Nunca lança erro e tem tempo-limite, para não atrasar nem quebrar o pagamento.
export async function brevoSend({ to, subject, html, text, scheduledAt }) {
  if (!BREVO_API_KEY) {
    console.warn('[Notifications] BREVO_API_KEY not set, skipping email.');
    return null;
  }
  if (!to) return null;
  try {
    const payload = {
      sender: { name: FROM_NAME, email: FROM_EMAIL },
      to: [{ email: to }],
      subject,
      htmlContent: html,
    };
    // Versão em texto simples: ajuda o Gmail a tratar como e-mail pessoal/transacional
    if (text) payload.textContent = text;
    if (REPLY_TO_EMAIL) payload.replyTo = { email: REPLY_TO_EMAIL };
    if (scheduledAt) payload.scheduledAt = scheduledAt;

    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('[Brevo Error Response]', JSON.stringify(data));
      return null;
    }
    console.log(scheduledAt ? '[Brevo] Scheduled email — id:' : '[Brevo Success]', data.messageId);
    return data.messageId || null;
  } catch (e) {
    console.error('[Brevo Exception]', e.message);
    return null;
  }
}

export async function sendEmail({ to, subject, html, text }) {
  await brevoSend({ to, subject, html, text });
}

export async function scheduleEmail({ to, subject, html, text, delayMs }) {
  return brevoSend({ to, subject, html, text, scheduledAt: new Date(Date.now() + delayMs).toISOString() });
}

// Cancela um e-mail agendado na Brevo (pelo messageId devolvido no agendamento)
export async function cancelScheduledEmail(messageId) {
  return cancelPixReminder(messageId);
}

export async function cancelPixReminder(reminderId) {
  if (!BREVO_API_KEY || !reminderId) return;
  try {
    await fetch(`https://api.brevo.com/v3/smtp/email/${encodeURIComponent(reminderId)}`, {
      method: 'DELETE',
      headers: { 'api-key': BREVO_API_KEY },
      signal: AbortSignal.timeout(8000),
    });
    console.log('[Brevo] Scheduled email cancelled — id:', reminderId);
  } catch (e) {
    console.error('[Brevo] Cancel scheduled email failed:', e.message);
  }
}

// ─────────────────────────────────────────────
// Pós-compra: "Pedido sendo preparado" (3 horas depois)
// (o "Pedido em processamento" de 3 dias fica em lib/order-emails.js)
// ─────────────────────────────────────────────

function orderPreparingEmail({ customerName, orderId }) {
  const r = ref(orderId);
  const name = escapeHtml(firstName(customerName));
  const html = layout({
    preheader: 'Seu pedido já está sendo separado e embalado.',
    icon: '📦',
    title: 'Seu pedido está sendo preparado',
    subtitle: `Pedido #${r}`,
    body: `
      <p style="margin:0 0 12px;">Olá, <b>${name}</b>!</p>
      <p style="margin:0 0 12px;">Ótima notícia! Seu pedido <b>#${r}</b> já está sendo separado e embalado com todo cuidado pela nossa equipe.</p>
      ${box('✅ <b>Status atual:</b> preparando seu pedido.<br>Em breve você recebe uma nova atualização com o código de rastreio. Fique de olho no seu e-mail!', 'green')}`,
  });
  const text = `Olá, ${firstName(customerName)}!\n\nSeu pedido #${r} já está sendo separado e embalado com todo cuidado. Em breve você recebe o código de rastreio por e-mail.\n\nDúvidas: WhatsApp ${fmtPhone(SUPPORT_WHATSAPP)}`;
  return { subject: `Seu pedido #${r} está sendo preparado — Solare`, html, text };
}

export async function schedulePostPurchaseEmails({ customerName, customerEmail, orderId }) {
  const h3 = 3 * 60 * 60 * 1000;
  await scheduleEmail({ to: customerEmail, ...orderPreparingEmail({ customerName, orderId }), delayMs: h3 })
    .catch(e => console.error('schedulePostPurchase 3h failed:', e));
}

// ─────────────────────────────────────────────
// Código de rastreio (enviado quando o rastreio é cadastrado no dashboard)
// ─────────────────────────────────────────────

export async function sendTrackingEmail({ to, customerName, trackingCode, totalPrice, quantity }) {
  const name = escapeHtml(firstName(customerName || 'Cliente'));
  const code = escapeHtml(trackingCode || '');
  const trackLink = `https://t.17track.net/pt#nums=${encodeURIComponent(trackingCode || '')}`;
  const html = layout({
    preheader: `Seu código de rastreio: ${trackingCode || ''}`,
    icon: '🚚',
    title: 'Seu pedido está a caminho!',
    subtitle: 'Acompanhe a entrega com o código abaixo',
    body: `
      <p style="margin:0 0 12px;">Olá, <b>${name}</b>!</p>
      <p style="margin:0 0 12px;">Seu pedido foi enviado e já está em trânsito. Este é o seu código de rastreio:</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;"><tr>
        <td align="center" style="background:#f6fbf7;border:2px dashed #86c49a;border-radius:12px;padding:18px;">
          <div style="font-size:12px;color:#4b6355;text-transform:uppercase;letter-spacing:1px;">Código de rastreio</div>
          <div style="margin-top:6px;font-size:24px;font-weight:bold;letter-spacing:2px;color:#1A3C34;-webkit-user-select:all;user-select:all;">${code}</div>
        </td>
      </tr></table>
      ${button(trackLink, '📍 Rastrear meu pedido')}
      ${rows([['Produto', 'Luminária Solar Solare'], ['Quantidade', `${quantity || 1} unidade(s)`], ['Total pago', brl(totalPrice)]])}
      <p style="margin:0;font-size:14px;color:#4b6355;">Você também pode acompanhar a entrega no site dos Correios ou da transportadora usando o código acima.</p>
      ${button(whatsappLink(''), '💬 Falar com o suporte no WhatsApp', '#1A3C34')}`,
  });
  const text = `Olá, ${firstName(customerName || 'Cliente')}!\n\nSeu pedido foi enviado. Código de rastreio: ${trackingCode}\nRastreie aqui: ${trackLink}\n\nDúvidas: WhatsApp ${fmtPhone(SUPPORT_WHATSAPP)}`;
  return sendEmail({ to, subject: 'Seu pedido Solare está a caminho! Código de rastreio', html, text });
}
