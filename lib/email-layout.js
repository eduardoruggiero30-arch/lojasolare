/**
 * Visual dos e-mails da loja (verde Solare + detalhe amarelo do logo).
 * HTML em tabelas e estilos inline, que é o que Gmail/Outlook/Apple Mail entendem.
 */

export const SITE_URL = (process.env.SITE_URL || 'https://www.solareluminarias.com.br').replace(/\/+$/, '');
export const SUPPORT_WHATSAPP = (process.env.WHATSAPP_NUMBER || '21975605337').replace(/\D/g, '');

const GREEN_DARK = '#1A3C34';
const GREEN = '#16a34a';
const GREEN_SOFT = '#ecf7ef';
const YELLOW = '#f5c400';
const YEAR = new Date().getFullYear();

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

// Número curto do pedido para o cliente (o id interno é um UUID longo)
export const ref = (id) => String(id ?? '').replace(/^MP-/, '').slice(0, 8).toUpperCase();
export const brl = (n) => 'R$ ' + (Number(n) || 0).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
export const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || 'cliente';
export const fmtPhone = (d) => d.length === 11 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}` : d;

export function whatsappLink(orderRef) {
  const text = orderRef ? `Olá! Quero acompanhar meu pedido #${orderRef}` : 'Olá! Tenho uma dúvida sobre a Solare';
  return `https://wa.me/55${SUPPORT_WHATSAPP}?text=${encodeURIComponent(text)}`;
}

// Botão grande e centralizado (fácil de tocar no celular)
export function button(href, label, color = GREEN) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0 8px;"><tr><td align="center">
    <a href="${href}" style="display:block;max-width:380px;margin:0 auto;background:${color};color:#ffffff;text-decoration:none;padding:17px 20px;border-radius:12px;font-weight:bold;font-size:17px;text-align:center;font-family:Arial,Helvetica,sans-serif;">${label}</a>
  </td></tr></table>`;
}

// Tabela de resumo (rótulo à esquerda, valor à direita)
export function rows(list) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #d6eadb;border-radius:12px;border-collapse:separate;margin:18px 0;font-size:14px;overflow:hidden;">
    ${list.map(([k, v], i) => `<tr style="background:${i % 2 ? '#ffffff' : '#f6fbf7'};">
      <td style="padding:11px 14px;color:#4b6355;width:40%;vertical-align:top;">${k}</td>
      <td style="padding:11px 14px;color:#10251c;font-weight:bold;">${v}</td></tr>`).join('')}
  </table>`;
}

// Caixa de destaque: green (informação), yellow (atenção leve), red (urgência)
export function box(html, tone = 'green') {
  const t = {
    green:  ['#ecf7ef', '#16a34a', '#14532d'],
    yellow: ['#fff8db', '#f5c400', '#5c4500'],
    red:    ['#fef2f2', '#dc2626', '#7f1d1d'],
  }[tone];
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0;"><tr>
    <td style="background:${t[0]};border-left:5px solid ${t[1]};border-radius:10px;padding:14px 16px;color:${t[2]};font-size:14px;line-height:1.55;">${html}</td>
  </tr></table>`;
}

// Bloco do Pix: código visível + botão "Copiar código Pix" (abre a página que copia com 1 toque)
export function pixBox(code, copyLink) {
  return `<div style="margin:22px 0 6px;font-size:14px;font-weight:bold;color:${GREEN_DARK};">Seu código Pix (copia e cola):</div>
    <div style="background:#f6fbf7;border:2px dashed #86c49a;border-radius:12px;padding:14px;font-family:'Courier New',monospace;font-size:12px;line-height:1.5;word-break:break-all;color:#10251c;-webkit-user-select:all;user-select:all;">${escapeHtml(code)}</div>
    ${copyLink ? button(copyLink, '📋 Copiar código Pix') + `<p style="margin:0 0 6px;text-align:center;font-size:13px;color:#4b6355;">Toque no botão: abre uma página com o código pronto para copiar com um toque.</p>` : ''}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0 4px;font-size:14px;color:#10251c;">
      <tr><td style="padding:5px 0;"><b style="color:${GREEN};">1.</b> Toque em <b>“Copiar código Pix”</b></td></tr>
      <tr><td style="padding:5px 0;"><b style="color:${GREEN};">2.</b> Abra o app do seu banco e escolha <b>Pix → Pix Copia e Cola</b></td></tr>
      <tr><td style="padding:5px 0;"><b style="color:${GREEN};">3.</b> Cole o código e confirme o pagamento</td></tr>
    </table>`;
}

/**
 * Estrutura completa do e-mail.
 * icon/title/subtitle formam a faixa verde do topo; preheader é o texto que aparece
 * na prévia da caixa de entrada.
 */
export function layout({ preheader = '', icon = '', title = '', subtitle = '', body = '' }) {
  return `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta name="color-scheme" content="light"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#eef5ef;font-family:Arial,Helvetica,sans-serif;color:#1f2937;-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#eef5ef;">${escapeHtml(preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef5ef;">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #d6eadb;">

        <tr><td align="center" style="padding:22px 20px 18px;background:#ffffff;">
          <a href="${SITE_URL}" style="text-decoration:none;"><img src="${SITE_URL}/logo-solare.png" width="150" alt="SOLARE" style="display:block;width:150px;max-width:150px;height:auto;border:0;"></a>
        </td></tr>
        <tr><td style="height:5px;line-height:5px;font-size:0;background:${GREEN_DARK};">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td width="82%" style="height:5px;line-height:5px;font-size:0;background:${GREEN_DARK};">&nbsp;</td>
            <td width="18%" style="height:5px;line-height:5px;font-size:0;background:${YELLOW};">&nbsp;</td>
          </tr></table>
        </td></tr>

        ${title ? `<tr><td align="center" style="background:${GREEN_DARK};padding:30px 24px 32px;">
          ${icon ? `<div style="display:inline-block;width:64px;height:64px;line-height:64px;border-radius:32px;background:#ffffff;font-size:32px;text-align:center;margin-bottom:14px;">${icon}</div>` : ''}
          <div style="font-size:24px;line-height:1.3;font-weight:bold;color:#ffffff;">${title}</div>
          ${subtitle ? `<div style="margin-top:8px;font-size:15px;line-height:1.5;color:#bfe6cb;">${subtitle}</div>` : ''}
        </td></tr>` : ''}

        <tr><td style="padding:28px 26px 10px;font-size:15px;line-height:1.65;color:#1f2937;">${body}</td></tr>

        <tr><td style="padding:6px 26px 26px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${GREEN_SOFT};border-radius:12px;"><tr>
            <td style="padding:14px 16px;font-size:14px;color:#14532d;line-height:1.5;">
              💬 <b>Precisa de ajuda?</b> Fale com a gente no WhatsApp
              <a href="${whatsappLink('')}" style="color:${GREEN};font-weight:bold;text-decoration:none;">${fmtPhone(SUPPORT_WHATSAPP)}</a>
            </td>
          </tr></table>
        </td></tr>

        <tr><td align="center" style="background:${GREEN_DARK};padding:20px 20px 22px;color:#bfe6cb;font-size:12px;line-height:1.7;">
          <div style="font-size:14px;font-weight:bold;color:#ffffff;letter-spacing:1px;">SOLARE <span style="color:${YELLOW};">LUMINÁRIAS</span></div>
          <a href="${SITE_URL}" style="color:#bfe6cb;text-decoration:none;">${SITE_URL.replace(/^https?:\/\//, '')}</a><br>
          © ${YEAR} Solare Luminárias · Iluminação solar para o seu lar
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>`;
}
