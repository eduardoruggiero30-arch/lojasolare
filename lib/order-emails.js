/**
 * E-mails da jornada de compra (enviados pela Brevo):
 *  - Lembretes do Pix gerado e não pago: 4 min e 10 min depois (cancelados se o pagamento cair)
 *  - Confirmação de pagamento: na hora, uma única vez por pagamento (pedido principal e upsell)
 *  - Oferta de upsell: logo depois da confirmação do pedido principal
 *  - Pedido em processamento: 3 dias depois da compra
 *  - Pix vencido: convite para comprar de novo
 *  - Checkout abandonado: preencheu o e-mail mas não gerou Pix nem pagou no cartão (30 min)
 *
 * Tudo aqui é "não fatal": qualquer erro só é registrado e nunca atrapalha o pagamento.
 */
import { createClient } from '@supabase/supabase-js';
import { brevoSend, cancelScheduledEmail, schedulePostPurchaseEmails } from './send-notification.js';
import {
  SITE_URL, SUPPORT_WHATSAPP, escapeHtml, ref, brl, firstName, fmtPhone, whatsappLink,
  layout, button, rows, box, pixBox,
} from './email-layout.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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

function parseAddr(order) {
  let a = order?.customer_address || {};
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = {}; } }
  return a;
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

// Página da loja que mostra o código com um botão que copia tudo com 1 toque
function pixPageLink(order, code) {
  const q = new URLSearchParams({ c: code, v: String(order.total_price ?? '') });
  if (order.mp_payment_id) q.set('id', String(order.mp_payment_id));
  return `${SITE_URL}/pagar-pix.html?${q.toString()}`;
}

// ── 1. Lembretes do Pix gerado e não pago ────────────────────────

function pixReminderEmail(order, pixCode, second) {
  const it = orderItems(order);
  const r = ref(order.id);
  const name = escapeHtml(firstName(order.customer_name));
  const subject = second
    ? `${firstName(order.customer_name)}, seu pedido #${r} ainda está reservado`
    : `Seu Pix de ${brl(order.total_price)} está aguardando pagamento`;
  const body = `
    <p style="margin:0 0 12px;">Olá, <b>${name}</b>!</p>
    ${second
      ? `<p style="margin:0 0 12px;">Ainda não identificamos o pagamento do seu pedido <b>#${r}</b>. Ele continua reservado com o preço promocional, mas o Pix <b>expira em poucos minutos</b>.</p>`
      : `<p style="margin:0 0 12px;">Você gerou o Pix do seu pedido <b>#${r}</b>, mas o pagamento ainda não foi identificado. Seu pedido está reservado — falta só pagar para garantir!</p>`}
    ${rows([['Produto', escapeHtml(it.product)], ['Quantidade', `${it.units} unidades`], ['Total no Pix', `<span style="color:#16a34a;font-size:16px;">${brl(order.total_price)}</span>`]])}
    ${second ? box('⏳ <b>Depois que o Pix expirar, a reserva e o preço promocional são liberados.</b>', 'yellow') : ''}
    ${pixCode ? pixBox(pixCode, pixPageLink(order, pixCode)) : ''}
    <p style="margin:18px 0 0;font-size:13px;color:#6b7280;">Se você já pagou, pode desconsiderar este e-mail.</p>`;
  const html = layout({
    preheader: second ? 'Seu pedido ainda está reservado — o Pix expira em poucos minutos.' : 'Falta só pagar o Pix para garantir o seu pedido.',
    icon: second ? '⏳' : '💳',
    title: second ? 'Seu pedido ainda está reservado' : 'Seu Pix está aguardando pagamento',
    subtitle: second ? 'O Pix expira em poucos minutos' : `Pedido #${r} · ${brl(order.total_price)}`,
    body,
  });
  const text = [
    `Olá, ${firstName(order.customer_name)}!`,
    second
      ? `Ainda não identificamos o pagamento do seu pedido #${r}. Ele continua reservado, mas o Pix expira em poucos minutos.`
      : `Você gerou o Pix do seu pedido #${r}, mas o pagamento ainda não foi identificado.`,
    `Produto: ${it.product} — ${it.units} unidades — Total: ${brl(order.total_price)}`,
    pixCode ? `Código Pix (copia e cola): ${pixCode}` : '',
    pixCode ? `Copie o código com um toque aqui: ${pixPageLink(order, pixCode)}` : '',
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
    ['Quantidade', it.isUpsell || !it.extraUnits ? `${it.units} unidades` : `${it.units} unidades<br><span style="font-weight:normal;color:#4b6355;font-size:13px;">${it.kit} do kit + ${it.extraUnits} adicionais</span>`],
  ];
  if (it.extras.length) list.push(['Adicionais', it.extras.map(escapeHtml).join('<br>')]);
  if (it.color) list.push(['Cor da luz', escapeHtml(it.color)]);
  list.push(
    ['Pagamento', method],
    ['Total pago', `<span style="color:#16a34a;font-size:16px;">${brl(order.total_price)}</span>`],
    ['Frete', '<span style="color:#16a34a;">Grátis</span>'],
  );
  const addr = addressText(order);
  if (addr) list.push(['Entrega em', escapeHtml(addr)]);
  list.push(['Prazo de entrega', `até ${DELIVERY_DAYS} dias`]);

  const subject = it.isUpsell
    ? `Pagamento confirmado — oferta adicional #${r}`
    : `Pedido confirmado #${r} — Solare Luminárias`;
  const body = `
    <p style="margin:0 0 12px;">Olá, <b>${name}</b>!</p>
    <p style="margin:0 0 12px;">${it.isUpsell ? 'O pagamento da sua <b>oferta adicional</b> foi confirmado' : 'Seu <b>pagamento foi confirmado</b>'}! Muito obrigado pela confiança na Solare — é uma alegria ter você como cliente. 💚</p>
    <p style="margin:0;">Confira tudo o que foi confirmado:</p>
    ${rows(list)}
    <p style="margin:0 0 4px;">${it.isUpsell ? 'Essas unidades serão enviadas junto com o seu pedido.' : 'Agora vamos separar e embalar seu pedido com todo cuidado. Assim que ele for despachado, você recebe o código de rastreio por e-mail.'}</p>
    ${box(`<b style="font-size:15px;">📦 Acompanhe seu pedido com o nosso suporte</b><br>Mande uma mensagem no WhatsApp <b>${fmtPhone(SUPPORT_WHATSAPP)}</b> informando o número do pedido <b>#${r}</b>. Nossa equipe te acompanha até a entrega.`, 'green')}
    ${button(whatsappLink(r), '💬 Falar com o suporte no WhatsApp')}`;
  const html = layout({
    preheader: `Pagamento confirmado! Pedido #${r} — obrigado pela confiança.`,
    icon: '✅',
    title: it.isUpsell ? 'Oferta adicional confirmada!' : 'Pedido confirmado!',
    subtitle: `Pedido #${r} · ${brl(order.total_price)}`,
    body,
  });
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
  const body = `
    <p style="margin:0 0 12px;">Olá, <b>${name}</b>!</p>
    <p style="margin:0 0 6px;">Como você acabou de se tornar cliente Solare, liberamos uma <b>oportunidade única</b>, exclusiva para você:</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0;border:2px solid #16a34a;border-radius:14px;"><tr>
      <td align="center" style="padding:22px 16px;">
        <div style="display:inline-block;background:#f5c400;color:#3d2e00;font-size:12px;font-weight:bold;padding:4px 12px;border-radius:20px;letter-spacing:.5px;">OFERTA VIP · SÓ PARA VOCÊ</div>
        <div style="margin-top:12px;font-size:18px;font-weight:bold;color:#1A3C34;">Mais 2 Luminárias Solares</div>
        <div style="margin-top:6px;font-size:15px;color:#6b7280;text-decoration:line-through;">de ${brl(UPSELL_OLD_PRICE)}</div>
        <div style="font-size:34px;font-weight:bold;color:#16a34a;line-height:1.2;">${brl(UPSELL_PRICE)}</div>
        <div style="margin-top:6px;font-size:14px;color:#14532d;">🚚 Frete grátis · enviadas junto com o seu pedido</div>
      </td>
    </tr></table>
    ${box('⚠️ <b>Atenção:</b> esse super desconto é só seu e vale <b>apenas agora, por este link</b>. Ele não aparece no site e não será oferecido de novo.', 'red')}
    ${button(link, 'Quero aproveitar agora')}
    <p style="margin:4px 0 0;text-align:center;font-size:13px;color:#4b6355;">${viaCard ? 'Pagamento em um clique no mesmo cartão da sua compra — é só confirmar o código de segurança (CVV).' : 'Pagamento rápido por Pix, sem precisar preencher nada de novo.'}</p>`;
  const html = layout({
    preheader: `Mais 2 luminárias por ${brl(UPSELL_PRICE)} — oferta única, só para você.`,
    icon: '🎁',
    title: 'Uma oferta exclusiva para você',
    subtitle: 'Liberada só agora, como agradecimento pela sua compra',
    body,
  });
  const text = [
    `Olá, ${firstName(order.customer_name)}!`,
    'Como você acabou de se tornar cliente Solare, liberamos uma oportunidade única, exclusiva para você:',
    `Mais 2 Luminárias Solares por apenas ${brl(UPSELL_PRICE)} (de ${brl(UPSELL_OLD_PRICE)}), frete grátis, enviadas junto com o seu pedido.`,
    'Atenção: esse super desconto é só seu e vale apenas agora, por este link. Ele não aparece no site e não será oferecido de novo.',
    `Aproveite aqui: ${link}`,
  ].join('\n\n');
  return { subject, html, text };
}

// ── Pix venceu sem pagamento: convida a comprar de novo ─────────

function pixExpiredEmail(order) {
  const it = orderItems(order);
  const r = ref(order.id);
  const name = escapeHtml(firstName(order.customer_name));
  const link = `${SITE_URL}/?utm_source=email&utm_medium=email&utm_campaign=pix_expirado`;
  const subject = `${firstName(order.customer_name)}, seu Pix venceu — hoje é o último dia da oferta`;
  const body = `
    <p style="margin:0 0 12px;">Olá, <b>${name}</b>!</p>
    <p style="margin:0 0 12px;">O Pix do seu pedido <b>#${r}</b> venceu antes de o pagamento ser identificado — mas <b>ainda dá tempo de garantir o seu!</b></p>
    ${rows([['Produto', escapeHtml(it.product)], ['Quantidade', `${it.units} unidades`], ['Valor no Pix', `<span style="color:#16a34a;font-size:16px;">${brl(order.total_price)}</span>`]])}
    ${box('🔥 <b>Hoje é o último dia da oferta</b> e o <b>estoque está acabando</b>. Depois que esgotar, não conseguimos garantir este preço.', 'red')}
    ${button(link, 'Comprar novamente')}
    <p style="margin:4px 0 0;text-align:center;font-size:13px;color:#4b6355;">Leva menos de 1 minuto: escolha o kit, gere um novo Pix e pronto.<br>Se você já fez um novo pedido, pode desconsiderar este e-mail.</p>`;
  const html = layout({
    preheader: 'Hoje é o último dia da oferta e o estoque está acabando.',
    icon: '⏰',
    title: 'Seu Pix venceu',
    subtitle: 'Mas ainda dá tempo — hoje é o último dia da oferta',
    body,
  });
  const text = [
    `Olá, ${firstName(order.customer_name)}!`,
    `O Pix do seu pedido #${r} venceu antes de o pagamento ser identificado — mas ainda dá tempo de garantir o seu!`,
    `${it.product} — ${it.units} unidades — ${brl(order.total_price)} no Pix`,
    'Hoje é o último dia da oferta e o estoque está acabando.',
    `Compre novamente: ${link}`,
    'Se você já fez um novo pedido, desconsidere este e-mail.',
  ].join('\n\n');
  return { subject, html, text };
}

// Chamado pelo webhook quando o Pix vence. Envia uma única vez por pedido e
// não envia se a pessoa já comprou (pagou outro pedido nas últimas 24h).
export async function notifyPixExpiredOnce(orderId) {
  try {
    if (!orderId) return;
    const { data, error } = await supabase.from('orders')
      .update({ expired_email_sent_at: new Date().toISOString() })
      .eq('id', orderId)
      .eq('status', 'cancelled')
      .eq('payment_method', 'pix')
      .is('expired_email_sent_at', null)
      .select('*');
    if (error) { console.error('[Emails] expired claim failed:', error.message); return; }
    const order = data?.[0];
    if (!order || parseAddr(order).upsell) return;

    const { count } = await supabase.from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('customer_email', order.customer_email)
      .eq('status', 'approved')
      .gte('created_at', new Date(Date.now() - 24 * 3600e3).toISOString());
    if (count) return;

    await brevoSend({ to: order.customer_email, ...pixExpiredEmail(order) });
  } catch (e) {
    console.error('[Emails] notifyPixExpiredOnce failed:', e.message);
  }
}

// ── 4. Pedido em processamento (3 dias depois da compra) ─────────

function processingEmail(order) {
  const r = ref(order.id);
  const name = escapeHtml(firstName(order.customer_name));
  const subject = `Seu pedido #${r} está em processamento`;
  const body = `
    <p style="margin:0 0 12px;">Olá, <b>${name}</b>!</p>
    <p style="margin:0 0 12px;">Seu pedido <b>#${r}</b> está <b>em processamento</b> e logo logo sai o seu código de rastreio. 🚚</p>
    ${box('🙏 <b>Por favor, não deixe de enviar uma mensagem para o nosso suporte</b> perguntando sobre o seu pedido. Nossos pedidos são feitos de forma manual, então o seu contato ajuda muito a nossa equipe a acompanhar e agilizar o seu envio.', 'yellow')}
    ${button(whatsappLink(r), '💬 Falar com o suporte no WhatsApp')}
    <p style="margin:4px 0 0;text-align:center;font-size:13px;color:#4b6355;">WhatsApp do suporte: <b>${fmtPhone(SUPPORT_WHATSAPP)}</b> — informe o número do pedido <b>#${r}</b>.</p>`;
  const html = layout({
    preheader: 'Seu pedido está em processamento — logo logo sai o código de rastreio.',
    icon: '📦',
    title: 'Pedido em processamento',
    subtitle: `Pedido #${r} · logo logo sai o seu rastreio`,
    body,
  });
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

// ── 5. Checkout abandonado (preencheu e-mail, não gerou Pix nem pagou) ──

function abandonEmail(lead) {
  const name = escapeHtml(firstName(lead.name));
  const link = `${SITE_URL}/?utm_source=email&utm_medium=email&utm_campaign=carrinho_abandonado`;
  const subject = `${firstName(lead.name)}, você esqueceu de finalizar sua compra`;
  const qty = Number(lead.qty) || 0;
  const body = `
    <p style="margin:0 0 12px;">Olá, <b>${name}</b>!</p>
    <p style="margin:0 0 12px;">Vimos que você começou o pedido da sua <b>Luminária Solar</b>, mas não chegou a finalizar.</p>
    ${qty ? rows([['Seu pedido', `${qty} luminárias solares`], ['Valor', `<span style="color:#16a34a;font-size:16px;">${brl(lead.price)}</span>`]]) : ''}
    ${box('🔥 A promoção que você viu é <b>única e por tempo limitado</b> — ainda dá tempo de garantir o seu com <b>frete grátis</b> e <b>5% de desconto no Pix</b>.', 'yellow')}
    ${button(link, 'Continuar minha compra')}`;
  const html = layout({
    preheader: 'Seu pedido ficou pela metade — a promoção ainda está valendo.',
    icon: '🛒',
    title: 'Você esqueceu algo!',
    subtitle: 'Sua Luminária Solar está te esperando',
    body,
  });
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
