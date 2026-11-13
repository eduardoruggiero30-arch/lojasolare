/**
 * E-mails da jornada de compra (enviados pela Brevo):
 *  - Lembretes do Pix gerado e não pago: 4 min e 10 min depois (cancelados se o pagamento cair)
 *  - Confirmação de pagamento: na hora, uma única vez por pagamento (pedido principal e upsell)
 *  - Oferta de upsell: logo depois da confirmação do pedido principal
 *  - Checkout abandonado: preencheu o e-mail mas não gerou Pix nem pagou no cartão (30 min)
 *
 * Tudo aqui é "não fatal": qualquer erro só é registrado e nunca atrapalha o pagamento.
 */
import { createClient } from '@supabase/supabase-js';
import { brevoSend, cancelScheduledEmail, escapeHtml, ref, schedulePostPurchaseEmails } from './send-notification.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const SITE_URL = (process.env.SITE_URL || 'https://www.solareluminarias.com.br').replace(/\/+$/, '');
const SUPPORT_WHATSAPP = (process.env.WHATSAPP_NUMBER || '21975605337').replace(/\D/g, '');
const DELIVERY_DAYS = 8;

const PIX_REMINDER_1_MS = 4 * 60 * 1000;   // 4 min depois de gerar o Pix
const PIX_REMINDER_2_MS = 10 * 60 * 1000;  // 6 min depois do primeiro lembrete
const ABANDON_MS = 30 * 60 * 1000;         // checkout abandonado sem Pix/cartão
// "Pedido em processamento": 3 dias depois (a Brevo agenda no máximo 3 dias à frente, então 2 min de folga)
const PROCESSING_MS = 3 * 24 * 3600e3 - 2 * 60 * 1000;
const ABANDON_REPEAT_MS = 7 * 24 * 3600e3; // no máximo um e-mail de abandono por semana por pessoa

const PRODUCT_LABELS = {
  solar: 'Luminária Solar de Parede',
  led: 'Luminária LED Sem Fio',
  'lampada-led': 'Lâmpada LED Solar Max',
  jardim: 'Luminária Solar Externa de Jardim',
};
const LIGHT_LABELS = { warm: 'Luz Quente (Amarela)', white: 'Luz Branca' };
const UPSELL_PRICE = 49.90;
const UPSELL_OLD_PRICE = 129.90;

// ── Utilidades ───────────────────────────────────────────────────

const brl = (n) => 'R$ ' + (Number(n) || 0).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || 'cliente';
const fmtPhone = (d) => d.length === 11 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}` : d;

function parseAddr(order) {
  let a = order?.customer_address || {};
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = {}; } }
  return a;
}

function whatsappLink(orderRef) {
  const text = orderRef ? `Olá! Quero acompanhar meu pedido #${orderRef}` : 'Olá! Tenho uma dúvida sobre a Solare';
  return `https://wa.me/55${SUPPORT_WHATSAPP}?text=${encodeURIComponent(text)}`;
}

// Itens do pedido: unidades do kit + adicionais (mesma regra do dashboard)
function orderItems(order) {
  const a = parseAddr(order);
  const color = LIGHT_LABELS[order.product_light_color] || order.product_light_color || '';
  if (a.upsell) {
    return {
      product: 'Kit +2 Luminárias Solares (oferta exclusiva)',
      units: Number(order.product_quantity) || 2,
      extras: [],
      color,
      isUpsell: true,
    };
  }
  const b = a.orderBumps || {};
  const u = a.bumpUnits || { carrinho: 2, luminaria: a.productType === 'led' ? 3 : 2 };
  const kit = Number(order.product_quantity) || 0;
  const extras = [];
  let extraUnits = 0;
  if (b.carrinho === true) { extras.push(`+${u.carrinho} luminárias (oferta do carrinho)`); extraUnits += u.carrinho; }
  if (b.luminaria === true) { extras.push(`+${u.luminaria} ${u.luminaria > 1 ? 'unidades' : 'unidade'} (adicional do checkout)`); extraUnits += u.luminaria; }
  if (b.envio === true) extras.push('Envio priorizado');
  if (b.garantia === true) extras.push('Garantia estendida');
  return {
    product: PRODUCT_LABELS[a.productType] || PRODUCT_LABELS.solar,
    units: kit + extraUnits,
    kit,
    extraUnits,
    extras,
    color,
    isUpsell: false,
  };
}

function addressText(order) {
  const a = parseAddr(order);
  const l1 = [a.street, a.number].filter(Boolean).join(', ');
  const l2 = [a.neighborhood, [a.city, a.state].filter(Boolean).join(' - ')].filter(Boolean).join(', ');
  return [l1, l2, a.cep ? 'CEP ' + a.cep : ''].filter(Boolean).join(' · ');
}

// Layout simples, com cara de e-mail pessoal (ajuda a cair na aba Principal do Gmail)
function layout(inner) {
  return `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#ffffff;font-family:Arial,Helvetica,sans-serif;color:#1f2937;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;">
    <tr><td align="center" style="padding:24px 16px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
        <tr><td style="padding-bottom:16px;border-bottom:1px solid #e5e7eb;font-size:16px;font-weight:bold;color:#1a3c34;">Solare Luminárias</td></tr>
        <tr><td style="padding-top:20px;font-size:15px;line-height:1.6;">${inner}</td></tr>
        <tr><td style="padding-top:24px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;line-height:1.5;">
          Solare Luminárias · ${SITE_URL.replace(/^https?:\/\//, '')}<br>
          Dúvidas? WhatsApp ${fmtPhone(SUPPORT_WHATSAPP)}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function button(href, label, color = '#1a3c34') {
  return `<p style="margin:24px 0;"><a href="${href}" style="display:inline-block;background:${color};color:#ffffff;text-decoration:none;padding:13px 26px;border-radius:8px;font-weight:bold;font-size:15px;">${label}</a></p>`;
}

function rows(list) {
  return `<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:8px;margin:16px 0;font-size:14px;">
    ${list.map(([k, v], i) => `<tr><td style="padding:10px 14px;color:#6b7280;${i ? 'border-top:1px solid #f1f5f9;' : ''}width:42%;vertical-align:top;">${k}</td><td style="padding:10px 14px;font-weight:bold;${i ? 'border-top:1px solid #f1f5f9;' : ''}">${v}</td></tr>`).join('')}
  </table>`;
}

function pixCodeBlock(code) {
  return `<p style="margin:16px 0 6px;font-size:14px;color:#6b7280;">Código Pix (copia e cola):</p>
  <div style="background:#f8fafc;border:1px dashed #94a3b8;border-radius:8px;padding:12px;font-family:monospace;font-size:12px;word-break:break-all;color:#111827;">${escapeHtml(code)}</div>
  <p style="margin:8px 0 0;font-size:13px;color:#6b7280;">Abra o app do seu banco → Pix → <b>Pix Copia e Cola</b> → cole o código acima.</p>`;
}

// ── 1. Lembretes do Pix gerado e não pago ────────────────────────

function pixReminderEmail(order, pixCode, second) {
  const it = orderItems(order);
  const r = ref(order.id);
  const name = escapeHtml(firstName(order.customer_name));
  const subject = second
    ? `${firstName(order.customer_name)}, seu pedido #${r} ainda está reservado`
    : `Seu Pix de ${brl(order.total_price)} está aguardando pagamento`;
  const intro = second
    ? `<p>Olá, ${name}!</p><p>Ainda não identificamos o pagamento do seu pedido <b>#${r}</b>. Ele continua reservado com o preço promocional, mas o Pix <b>expira em poucos minutos</b> — depois disso a reserva é liberada.</p>`
    : `<p>Olá, ${name}!</p><p>Você gerou o Pix do seu pedido <b>#${r}</b>, mas o pagamento ainda não foi identificado. Seu pedido está reservado — falta só pagar para garantir.</p>`;
  const html = layout(`${intro}
    ${rows([['Produto', escapeHtml(it.product)], ['Quantidade', `${it.units} unidades`], ['Total no Pix', brl(order.total_price)]])}
    ${pixCode ? pixCodeBlock(pixCode) : ''}
    <p style="margin-top:20px;">Se você já pagou, pode desconsiderar este e-mail.</p>
    <p>Precisa de ajuda? Fale com a gente no <a href="${whatsappLink(r)}" style="color:#16a34a;font-weight:bold;">WhatsApp ${fmtPhone(SUPPORT_WHATSAPP)}</a>.</p>`);
  const text = [
    `Olá, ${firstName(order.customer_name)}!`,
    second
      ? `Ainda não identificamos o pagamento do seu pedido #${r}. Ele continua reservado, mas o Pix expira em poucos minutos.`
      : `Você gerou o Pix do seu pedido #${r}, mas o pagamento ainda não foi identificado.`,
    `Produto: ${it.product} — ${it.units} unidades — Total: ${brl(order.total_price)}`,
    pixCode ? `Código Pix (copia e cola): ${pixCode}` : '',
    'Se você já pagou, desconsidere este e-mail.',
    `Ajuda: WhatsApp ${fmtPhone(SUPPORT_WHATSAPP)}`,
  ].filter(Boolean).join('\n\n');
  return { subject, html, text };
}

// Agenda os 2 lembretes (4 min e 10 min) e guarda os ids no pedido para poder cancelar
export async function schedulePixReminders(order, pixCode) {
  try {
    if (!order?.id || !order.customer_email) return;
    const now = Date.now();
    const e1 = pixReminderEmail(order, pixCode, false);
    const e2 = pixReminderEmail(order, pixCode, true);
    const ids = (await Promise.all([
      brevoSend({ to: order.customer_email, ...e1, scheduledAt: new Date(now + PIX_REMINDER_1_MS).toISOString() }),
      brevoSend({ to: order.customer_email, ...e2, scheduledAt: new Date(now + PIX_REMINDER_2_MS).toISOString() }),
    ])).filter(Boolean);
    if (ids.length) await supabase.from('orders').update({ pix_reminder_ids: ids }).eq('id', order.id);
  } catch (e) {
    console.error('[Emails] schedulePixReminders failed:', e.message);
  }
}

// Cancela os lembretes de Pix ainda agendados deste cliente (de qualquer pedido dele)
async function cancelPixRemindersFor(email) {
  if (!email) return;
  const { data } = await supabase.from('orders')
    .select('id, pix_reminder_ids')
    .eq('customer_email', email)
    .not('pix_reminder_ids', 'is', null);
  for (const o of data || []) {
    await Promise.all((o.pix_reminder_ids || []).map(id => cancelScheduledEmail(id)));
    await supabase.from('orders').update({ pix_reminder_ids: null }).eq('id', o.id);
  }
}

// ── 2. Confirmação de pagamento ──────────────────────────────────

function confirmationEmail(order) {
  const it = orderItems(order);
  const r = ref(order.id);
  const name = escapeHtml(firstName(order.customer_name));
  const method = order.payment_method === 'pix' ? 'Pix' : 'Cartão de crédito';
  const list = [
    ['Pedido', `#${r}`],
    ['Produto', escapeHtml(it.product)],
    ['Quantidade', it.isUpsell || !it.extraUnits ? `${it.units} unidades` : `${it.units} unidades <span style="font-weight:normal;color:#6b7280;">(${it.kit} do kit + ${it.extraUnits} adicionais)</span>`],
  ];
  if (it.extras.length) list.push(['Adicionais', it.extras.map(escapeHtml).join('<br>')]);
  if (it.color) list.push(['Cor da luz', escapeHtml(it.color)]);
  list.push(['Pagamento', method], ['Total pago', brl(order.total_price)], ['Frete', 'Grátis']);
  const addr = addressText(order);
  if (addr) list.push(['Entrega em', escapeHtml(addr)]);
  list.push(['Prazo de entrega', `até ${DELIVERY_DAYS} dias`]);

  const subject = it.isUpsell
    ? `Pagamento confirmado — oferta adicional #${r}`
    : `Pedido confirmado #${r} — Solare Luminárias`;
  const html = layout(`
    <p>Olá, ${name}!</p>
    <p><b>${it.isUpsell ? 'O pagamento da sua oferta adicional foi confirmado' : 'Seu pagamento foi confirmado'}!</b> Muito obrigado pela confiança na Solare — é uma alegria ter você como cliente.</p>
    <p>Confira tudo o que foi confirmado:</p>
    ${rows(list)}
    <p>${it.isUpsell ? 'Essas unidades serão enviadas junto com o seu pedido.' : 'Agora vamos separar e embalar seu pedido com todo cuidado. Assim que ele for despachado, você recebe o código de rastreio por e-mail.'}</p>
    <div style="margin-top:24px;padding:16px;border-radius:8px;background:#f0fdf4;border:1px solid #bbf7d0;">
      <p style="margin:0 0 6px;font-weight:bold;color:#14532d;">Acompanhe seu pedido com o nosso suporte</p>
      <p style="margin:0 0 12px;font-size:14px;">Mande uma mensagem no WhatsApp <b>${fmtPhone(SUPPORT_WHATSAPP)}</b> informando o número do pedido <b>#${r}</b>. Nossa equipe te acompanha até a entrega.</p>
      <a href="${whatsappLink(r)}" style="display:inline-block;background:#16a34a;color:#ffffff;text-decoration:none;padding:11px 22px;border-radius:8px;font-weight:bold;font-size:14px;">Falar com o suporte no WhatsApp</a>
    </div>`);
  const text = [
    `Olá, ${firstName(order.customer_name)}!`,
    `${it.isUpsell ? 'O pagamento da sua oferta adicional foi confirmado' : 'Seu pagamento foi confirmado'}! Muito obrigado pela confiança na Solare.`,
    `Pedido: #${r}`,
    `Produto: ${it.product}`,
    `Quantidade: ${it.units} unidades`,
    it.extras.length ? `Adicionais: ${it.extras.join(', ')}` : '',
    it.color ? `Cor da luz: ${it.color}` : '',
    `Pagamento: ${method} — Total pago: ${brl(order.total_price)} — Frete grátis`,
    addr ? `Entrega em: ${addr}` : '',
    `Prazo de entrega: até ${DELIVERY_DAYS} dias`,
    `Acompanhe seu pedido com o suporte no WhatsApp ${fmtPhone(SUPPORT_WHATSAPP)} informando o pedido #${r}: ${whatsappLink(r)}`,
  ].filter(Boolean).join('\n');
  return { subject, html, text };
}

// ── 3. Oferta de upsell (logo depois da confirmação) ─────────────

function upsellEmail(order, link, viaCard) {
  const name = escapeHtml(firstName(order.customer_name));
  const subject = `${firstName(order.customer_name)}, liberamos uma condição exclusiva só para você`;
  const html = layout(`
    <p>Olá, ${name}!</p>
    <p>Como você acabou de se tornar cliente Solare, liberamos uma <b>oportunidade única</b>, exclusiva para você:</p>
    <p style="font-size:17px;margin:18px 0;"><b>Mais 2 Luminárias Solares por apenas ${brl(UPSELL_PRICE)}</b><br>
      <span style="color:#6b7280;text-decoration:line-through;">de ${brl(UPSELL_OLD_PRICE)}</span> · frete grátis · enviadas junto com o seu pedido</p>
    <p style="padding:12px 14px;border-left:4px solid #dc2626;background:#fef2f2;font-size:14px;">
      <b>Atenção:</b> esse super desconto é só seu e vale <b>apenas agora, por este link</b>. Ele não aparece no site e não será oferecido de novo.</p>
    ${button(link, 'Quero aproveitar agora', '#16a34a')}
    <p style="font-size:14px;color:#6b7280;">${viaCard ? 'Pagamento em um clique no mesmo cartão da sua compra — é só confirmar o código de segurança (CVV).' : 'Pagamento rápido por Pix, sem precisar preencher nada de novo.'}</p>`);
  const text = [
    `Olá, ${firstName(order.customer_name)}!`,
    'Como você acabou de se tornar cliente Solare, liberamos uma oportunidade única, exclusiva para você:',
    `Mais 2 Luminárias Solares por apenas ${brl(UPSELL_PRICE)} (de ${brl(UPSELL_OLD_PRICE)}), frete grátis, enviadas junto com o seu pedido.`,
    'Atenção: esse super desconto é só seu e vale apenas agora, por este link. Ele não aparece no site e não será oferecido de novo.',
    `Aproveite aqui: ${link}`,
  ].join('\n\n');
  return { subject, html, text };
}

// ── 4. Pedido em processamento (3 dias depois da compra) ─────────

function processingEmail(order) {
  const r = ref(order.id);
  const name = escapeHtml(firstName(order.customer_name));
  const subject = `Seu pedido #${r} está em processamento`;
  const html = layout(`
    <p>Olá, ${name}!</p>
    <p>Seu pedido <b>#${r}</b> está <b>em processamento</b> e logo logo sai o seu código de rastreio.</p>
    <p>Por favor, <b>não deixe de enviar uma mensagem para o nosso suporte</b> perguntando sobre o seu pedido. Nossos pedidos são feitos de forma manual, então o seu contato ajuda muito a nossa equipe a acompanhar e agilizar o seu envio.</p>
    ${button(whatsappLink(r), 'Falar com o suporte no WhatsApp', '#16a34a')}
    <p style="font-size:14px;color:#6b7280;">WhatsApp do suporte: <b>${fmtPhone(SUPPORT_WHATSAPP)}</b> — informe o número do pedido <b>#${r}</b>.</p>`);
  const text = [
    `Olá, ${firstName(order.customer_name)}!`,
    `Seu pedido #${r} está em processamento e logo logo sai o seu código de rastreio.`,
    'Por favor, não deixe de enviar uma mensagem para o nosso suporte perguntando sobre o seu pedido. Nossos pedidos são feitos de forma manual, então o seu contato ajuda muito a nossa equipe.',
    `WhatsApp do suporte: ${fmtPhone(SUPPORT_WHATSAPP)} (informe o pedido #${r}) — ${whatsappLink(r)}`,
  ].join('\n\n');
  return { subject, html, text };
}

// ── Pagamento confirmado: confirmação + upsell, uma única vez por pedido ──

export async function notifyOrderPaid(orderId) {
  try {
    if (!orderId) return;
    // "Reserva" o envio: só quem conseguir marcar confirm_email_sent_at manda o e-mail.
    // Assim webhook, consulta de status e sincronizações nunca duplicam a confirmação.
    const { data, error } = await supabase.from('orders')
      .update({ confirm_email_sent_at: new Date().toISOString() })
      .eq('id', orderId)
      .eq('status', 'approved')
      .is('confirm_email_sent_at', null)
      .select('*');
    if (error) { console.error('[Emails] claim failed:', error.message); return; }
    const order = data?.[0];
    if (!order) return; // já enviado (ou ainda não aprovado)

    const a = parseAddr(order);
    await cancelPixRemindersFor(order.customer_email).catch(e => console.error('[Emails] cancel reminders failed:', e.message));
    await markLeadConverted(order.customer_phone, order.customer_email);

    await brevoSend({ to: order.customer_email, ...confirmationEmail(order) });

    if (a.upsell) return;

    schedulePostPurchaseEmails({
      customerName: order.customer_name,
      customerEmail: order.customer_email,
      orderId: order.id,
    }).catch(e => console.error('[Emails] post-purchase failed:', e.message));
    await brevoSend({
      to: order.customer_email,
      ...processingEmail(order),
      scheduledAt: new Date(Date.now() + PROCESSING_MS).toISOString(),
    });

    // Upsell: só do produto da home; no cartão precisa do cartão salvo (compra em 1 clique)
    const viaCard = order.payment_method !== 'pix';
    const canUpsell = (a.productType || 'solar') === 'solar' && (!viaCard || (order.mp_customer_id && order.mp_card_id));
    if (canUpsell) {
      const link = `${SITE_URL}/${viaCard ? 'upsell-v2.html' : 'upsell-pix.html'}?orderId=${encodeURIComponent(order.id)}`;
      await brevoSend({ to: order.customer_email, ...upsellEmail(order, link, viaCard) });
    }
  } catch (e) {
    console.error('[Emails] notifyOrderPaid failed:', e.message);
  }
}

// ── 4. Checkout abandonado (preencheu e-mail, não gerou Pix nem pagou) ──

function abandonEmail(lead) {
  const name = escapeHtml(firstName(lead.name));
  const link = `${SITE_URL}/?utm_source=email&utm_medium=email&utm_campaign=carrinho_abandonado`;
  const subject = `${firstName(lead.name)}, você esqueceu de finalizar sua compra`;
  const qty = Number(lead.qty) || 0;
  const html = layout(`
    <p>Olá, ${name}!</p>
    <p>Vimos que você começou o pedido da sua <b>Luminária Solar</b>, mas não chegou a finalizar.</p>
    ${qty ? rows([['Seu pedido', `${qty} luminárias solares`], ['Valor', brl(lead.price)]]) : ''}
    <p>A promoção que você viu é <b>única e por tempo limitado</b> — ainda dá tempo de garantir o seu com frete grátis e 5% de desconto no Pix.</p>
    ${button(link, 'Continuar minha compra', '#16a34a')}
    <p style="font-size:14px;color:#6b7280;">Ficou com alguma dúvida? Fale com a gente no <a href="${whatsappLink('')}" style="color:#16a34a;">WhatsApp ${fmtPhone(SUPPORT_WHATSAPP)}</a>.</p>`);
  const text = [
    `Olá, ${firstName(lead.name)}!`,
    'Vimos que você começou o pedido da sua Luminária Solar, mas não chegou a finalizar.',
    'A promoção que você viu é única e por tempo limitado — ainda dá tempo de garantir o seu com frete grátis e 5% de desconto no Pix.',
    `Continue sua compra: ${link}`,
    `Dúvidas: WhatsApp ${fmtPhone(SUPPORT_WHATSAPP)}`,
  ].join('\n\n');
  return { subject, html, text };
}

// Chamado quando o lead é salvo no checkout: agenda o e-mail de abandono para daqui a 30 min
export async function scheduleAbandonEmail(phone) {
  try {
    if (!phone) return;
    const { data: lead } = await supabase.from('leads')
      .select('id, name, email, price, qty, converted, abandon_email_at')
      .eq('phone', phone).maybeSingle();
    if (!lead?.email || lead.converted) return;
    if (lead.abandon_email_at && Date.now() - new Date(lead.abandon_email_at).getTime() < ABANDON_REPEAT_MS) return;

    const at = new Date(Date.now() + ABANDON_MS).toISOString();
    const id = await brevoSend({ to: lead.email, ...abandonEmail(lead), scheduledAt: at });
    if (id) await supabase.from('leads').update({ abandon_email_id: id, abandon_email_at: at }).eq('id', lead.id);
  } catch (e) {
    console.error('[Emails] scheduleAbandonEmail failed:', e.message);
  }
}

// Gerou Pix ou pagou: cancela o e-mail de abandono agendado (mantém a data para não reagendar)
export async function cancelAbandonEmail(phone, email) {
  try {
    const filters = [];
    const p = String(phone || '').replace(/\D/g, '');
    if (p) filters.push(`phone.eq.${p}`);
    const e = String(email || '').trim();
    if (e && !/[",()]/.test(e)) filters.push(`email.eq."${e}"`);
    if (!filters.length) return;
    const { data } = await supabase.from('leads')
      .select('id, abandon_email_id')
      .or(filters.join(','))
      .not('abandon_email_id', 'is', null);
    for (const l of data || []) {
      await cancelScheduledEmail(l.abandon_email_id);
      await supabase.from('leads').update({ abandon_email_id: null }).eq('id', l.id);
    }
  } catch (e) {
    console.error('[Emails] cancelAbandonEmail failed:', e.message);
  }
}

async function markLeadConverted(phone, email) {
  await cancelAbandonEmail(phone, email);
  const p = String(phone || '').replace(/\D/g, '');
  if (p) await supabase.from('leads').update({ converted: true }).eq('phone', p);
}
