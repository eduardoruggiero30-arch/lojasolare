// Rastreador "Ao vivo": avisa o servidor a cada 20s em que página o visitante está,
// para a página ao-vivo.html mostrar quem está no site, no carrinho, no checkout etc.
// Não guarda nome, IP nem nada pessoal — só um código aleatório por visitante.
// Tudo fica dentro de try/catch: se algo falhar, a loja continua igual.
(function () {
    try {
        var PING_MS = 20000;
        var IDLE_STOP_MS = 30 * 60 * 1000; // parado há 30 min sem interagir: para de avisar
        var path = location.pathname.replace(/\/+$/, '').toLowerCase() || '/';
        var q = new URLSearchParams(location.search);

        function store(get, k, v) {
            try { return get ? localStorage.getItem(k) : localStorage.setItem(k, v); } catch (e) { return null; }
        }

        // Visitante: mesmo código enquanto voltar em até 30 min
        var now = Date.now();
        var sid = store(true, 'lv_sid');
        var last = parseInt(store(true, 'lv_last') || '0', 10);
        if (!sid || now - last > 30 * 60 * 1000) {
            sid = (now.toString(36) + '-' + Math.random().toString(36).slice(2, 12));
            store(false, 'lv_sid', sid);
            store(false, 'lv_src', '');
        }

        // Origem: definida na página de entrada e mantida durante a visita
        var source = store(true, 'lv_src');
        if (!source) {
            var utm = (q.get('utm_source') || '').toLowerCase();
            var ref = (document.referrer || '').toLowerCase();
            if (q.get('fbclid') || /facebook|fb|meta/.test(utm) || /facebook\.com|fb\.com/.test(ref)) source = 'facebook';
            else if (/instagram|ig/.test(utm) || /instagram\.com/.test(ref)) source = 'instagram';
            else if (q.get('gclid') || q.get('gbraid') || q.get('wbraid') || /google/.test(utm) || /google\./.test(ref)) source = 'google';
            else if (q.get('ttclid') || /tiktok/.test(utm) || /tiktok\.com/.test(ref)) source = 'tiktok';
            else if (!ref || ref.indexOf(location.hostname) !== -1) source = utm ? 'outros' : 'direto';
            else source = 'outros';
            store(false, 'lv_src', source);
        }

        var ua = navigator.userAgent;
        var device = /iPad|Tablet/i.test(ua) ? 'tablet' : (/Mobi|Android|iPhone/i.test(ua) ? 'celular' : 'computador');

        // Etapa do funil a partir da página
        function pageStage() {
            if (/checkout/.test(path)) return 'checkout';
            if (/obrigado/.test(path)) return (q.get('type') === 'pix' && q.get('status') === 'pending') ? 'pix' : 'pos';
            if (/upsell/.test(path)) return 'pos';
            if (path === '/' || /index|lampada-led|luminaria-led|promo-liquidacao|catalogo/.test(path)) return 'produto';
            return 'outras';
        }
        var stage = pageStage();
        var page = path === '/' ? '/index' : path.replace(/\.html$/, '');

        var lastActivity = now;
        ['click', 'touchstart', 'scroll', 'keydown'].forEach(function (ev) {
            window.addEventListener(ev, function () { lastActivity = Date.now(); }, { passive: true });
        });

        function ping() {
            try {
                var t = Date.now();
                if (t - lastActivity > IDLE_STOP_MS) return;
                store(false, 'lv_last', String(t));
                fetch('/api/track', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sid: sid, stage: stage, page: page, source: source, device: device }),
                    keepalive: true
                }).catch(function () {});
            } catch (e) {}
        }

        // O carrinho lateral avisa quando abre/fecha: window.liveStage('carrinho') / window.liveStage()
        window.liveStage = function (s) {
            stage = s || pageStage();
            ping();
        };

        ping();
        setInterval(ping, PING_MS);
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible') { lastActivity = Date.now(); ping(); }
        });
    } catch (e) {}
})();
